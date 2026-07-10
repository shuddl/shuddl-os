# WP-02 — Ledger Core Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the append-only, hash-chained, co-signed event ledger — all 21 doc-10 tables, the DO-per-stream sequencer, lenses, money-line projections, and daily Merkle→TSA anchoring — meeting the WP-02 DoD: 35 event kinds round-trip · chain verifies after 10K events · correction semantics net to zero in the GL export fixture · lens tests prove scoping.

**Architecture:** Migrations live in `db/{control,tenant}/migrations` and are the only SQL in the repo (invariant-linted). `@shuddl/contracts` gains the full 35-kind event envelope (Zod discriminated union, integer-only numbers); `@shuddl/ledger` owns canonicalization, hash chain, signing, lenses, projections (money, passports, status-cache), GL export, Merkle, and the RFC 3161 client — pure modules, no LLM imports (REQ-024). `workers/api` hosts the `ShipmentSequencer` Durable Object (server-assigned `seq`/`prev_hash`, tenant-pinned by DO-id equality) and the lens-scoped read routes; `workers/agents` owns the daily anchor cron. Every piece integrates behind the existing WP-01 middleware (auth, claim-only tenant resolution, idempotency, error envelope).

**Tech Stack:** Everything from WP-01 (pnpm, TS 5.9 strict, Hono 4, Zod, vitest 3.2 + `@cloudflare/vitest-pool-workers` in workers, vitest 4 for tools) + Durable Objects (SQLite-backed), D1 migrations via wrangler + an in-test applier, WebCrypto (SHA-256, ECDSA P-256), R2 (anchor receipts).

---

## Governing rows (read before executing)

- **WP row:** `genesis/08 §03` WP-02 — "Tables per doc 10; event append API w/ hash chain + device signing; lenses (role-scoped queries); money-lines; authority map flags; TSA timestamp batching."
- **REQ rows:** REQ-001 (partial, evidence-carrying events), REQ-002, REQ-005 (agent.acted basis links), REQ-009 (passports accrue), REQ-011, REQ-012, REQ-014, REQ-015, REQ-057. Invariants I1–I8 (doc 10 §05) are all enforced or tested by this WP.
- **Mechanics law:** `genesis/14 §06` (DO sequencer, positions partition, Merkle→TSA) and §04 (API conventions).
- This plan was produced from six parallel subsystem designs plus an adversarial completeness audit (15 defects found). **§Decisions below resolves every audit conflict; where a decision contradicts an individual design, this plan wins.**

## Decisions (the consolidated law — resolves audit defects D1–D15)

| # | Decision | Resolves |
|---|---|---|
| 1 | **One canonical/hash spec** (Task 5–7): JCS-restricted canonical JSON, integer-only numbers; `hash = sha256(canonicalBytes(hashView(e)))` where `hashView` = envelope minus `sig` (includes `prev_hash`, `seq`, `id`, `ts`); chain rule `e[n].prev_hash = e[n-1].hash`; genesis sentinel `"0".repeat(64)`. Device signature covers `clientView(e)` (the fields a device knows offline), not the hash-view. | audit #1 |
| 2 | **One events DDL** in `db/tenant/migrations/0001_ledger_core.sql` (Task 2): `stream_id` keying (`s:{shipment_id}` / `q:{quote_id}` / `t:root`), actor split into 3 columns, `sig` nullable, offline-reserve columns (`device_id`, `device_seq`, `captured_ts`), **`recorded_at INTEGER NOT NULL`** (server clock — Merkle day bucketing), `ts` = integer epoch-ms everywhere (envelope, DB, canonical form; ISO-8601 is a rendering concern — PR assumption note re REQ-156). | audit #2, #4 |
| 3 | **Migrations only under `db/*/migrations/`**; the invariant lint gains a stray-SQL check that fails any `.sql` elsewhere. | audit #3 |
| 4 | **One money_lines DDL** (Task 3), FK `event_id REFERENCES events(id)` (valid — `events.id` is UNIQUE; the composite `(shipment_id, seq)` FK from the money design is invalid SQLite and is dropped). The sequencer calls `applyMoneyProjection` + `assertPodSigned` + passport/status-cache projections in the same `db.batch()` as the event INSERT. | audit #7 |
| 5 | **Visibility enum is `internal | counterparty | public`** everywhere (the canonical design's `private` is renamed). | audit #8 |
| 6 | **Integers only**: geo = `lat_e6`/`lon_e6` microdegrees (INTEGER), `accuracy_m` INTEGER, `confidence` = basis points 0–10000 INTEGER, money = signed cents. No REAL columns in ledger tables. | audit #9 |
| 7 | **Merkle leaf order** = events by `(stream_id, seq)` (stream_id is never NULL) then positions by `(shipment_id, device_id, ts)`; RFC 6962 domain separation. | audit #10 |
| 8 | **REQ-009 owner:** `projection/passports.ts` accrues counters from pod/exception/osd/custody events in the append batch (Task 12). | audit #5 |
| 9 | **REQ-005 owner:** typed `AgentActedPayload` with `basis: min(1)` required (Task 4). | audit #6 |
| 10 | **status_cache is a projection** the sequencer maintains (`state`, `assigned_driver`, `out_for_delivery`) — driver lens and city-granularity depend on it (Task 12). | audit #11 |
| 11 | **Lint amendment order:** Task 1 (trigger-body allowlist + guard-presence + PARTITION_TABLES + lockfile + stray-SQL) lands before any migration task. | audit #12 |
| 12 | **I4 in WP-02:** contracts refine — `custody.transferred`/`pod.signed` require `actor.device` present OR `payload.unwitnessed === true`; co-sign ack field reserved for WP-05. | audit #13 |
| 13 | **REQ-011 round-trip owner** = `packages/ledger/test/roundtrip.test.ts` only (schema task does a DB-round-trip, a different assertion). | audit #14 |
| 14 | **Anchor endpoints:** proof endpoint open to all tenant roles (portal parties verifying a POD hash is the point) but the portal-role manifest exposes only `{day, root}` (no event counts). Positions ingest idempotency = PK `(shipment_id, device_id, ts)` + `INSERT OR IGNORE`. | audit #15 |
| 16 | **`BEFORE INSERT` guards are mandatory on `events`, `positions`, `money_lines`.** D1 runs `recursive_triggers = 0`, so `INSERT OR REPLACE` performs an implicit delete that **never fires a `BEFORE DELETE` trigger** — a single statement rewrites history. Only a `BEFORE INSERT ... WHEN EXISTS(...)` guard (which fires while the old row still exists) closes it. The migration lint cannot: it scans migrations, not the sequencer or routes. Verified live against D1. | schema review |
| 15 | **`tsa_receipt`** is a `documents.kind` enum addition — stated as a register note in the PR (not a table/event-kind budget item). CMS cert-chain verification of TSA responses is deferred to WP-16 audit (raw `.tsr` bytes retained in R2, verifiable offline forever). | audit — |

## Stated assumptions (say these in the PR body)

1. **Events PK is `(stream_id, seq)`** with nullable `shipment_id` + CHECK, vs doc 10's `(shipment_id, seq)` — required for shipment-less kinds (`agent.acted`, `message.*`, `authority.flipped`, pre-booking `quote.*`). Register note proposed.
2. **`positions` is a physical partition of doc-10 entry #9** — the I8 guard learns a pinned `PARTITION_TABLES = {positions: "events"}` map; effective count stays 21.
3. **Ledger timestamps are integer epoch-ms** (canonicalization law); doc 14 §04's ISO-8601 applies at rendering. Anchoring day-buckets on `recorded_at` (server clock), never actor `ts` — airplane-mode uploads must not mutate anchored days.
4. **Integer-only canonical numbers** (cents/microdegrees/bps) — a documented JCS restriction, REQ-011 note.
5. **TSA endpoint is an open F1 [CONFIRM]** — `HttpTsaClient` ships tested against `FakeTsaClient` only; real-TSA smoke is the WP-02 exit line item.
6. **REQ-111's log→ledger unification is NOT built here** — logs stay event-shaped (WP-01 helper); making them ledger rows would need a `log.*` event kind (36th kind = register amendment). Deferred to WP-11 Watchtower with a register note.
7. Chain verification is a tenant-lens privilege; counterparties verify individual evidence hashes against anchors instead (redaction breaks contiguous chains for party lenses by design).
8. **Doc 10's `shipments.tenant` column is dropped** — redundant under physical per-tenant D1 (the database IS the tenant). Register note proposed alongside the PK note.
9. Execution on branch `wp-02-ledger` in a worktree; commits reference REQ-IDs; `tools/traceability/active-wps.json` gains `WP-02` in the final task (orphan detector then requires all nine rows annotated).

---

### Task 1: Migration infrastructure + invariant-lint amendments (land BEFORE any DDL)

**Files:**
- Create: `db/migrations.lock.json`, `packages/ledger/src/migrate.ts`
- Modify: `tools/checks/invariants.ts`, `tools/checks/invariants.test.ts`
- Test: `packages/ledger/test/migrate.test.ts`

**Step 1: Write the failing lint tests** — append to `tools/checks/invariants.test.ts`. **Also amend the existing WP-01 case** `"allows CREATE TABLE events and CREATE INDEX on events"` — under the new guard-presence rule bare `CREATE TABLE events` is a violation, so that case's SQL must gain the two events guard triggers (its intent — CREATE/INDEX allowed — is unchanged):

```ts
describe("I3 v2: trigger bodies may only RAISE(ABORT)", () => {
  const guards = `
-- BEFORE INSERT is the ONLY guard that stops `INSERT OR REPLACE` (D1 has recursive_triggers=0,
-- so REPLACE's implicit delete never fires a BEFORE DELETE trigger). Decision 16.
CREATE TRIGGER events_guard_ins BEFORE INSERT ON events
WHEN EXISTS (SELECT 1 FROM events WHERE (stream_id = NEW.stream_id AND seq = NEW.seq) OR id = NEW.id)
BEGIN SELECT RAISE(ABORT,'I3: append-only'); END;
CREATE TRIGGER events_guard_upd BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'I3: append-only'); END;
CREATE TRIGGER events_guard_del BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'I3: append-only'); END;
-- positions allows idempotent OR IGNORE re-ingest (Decision 14), so abort only on a
-- genuine overwrite: same PK, different data.
CREATE TRIGGER positions_guard_ins BEFORE INSERT ON positions
WHEN EXISTS (SELECT 1 FROM positions WHERE shipment_id = NEW.shipment_id AND device_id = NEW.device_id AND ts = NEW.ts AND hash <> NEW.hash)
BEGIN SELECT RAISE(ABORT,'I3: append-only'); END;
CREATE TRIGGER positions_guard_upd BEFORE UPDATE ON positions BEGIN SELECT RAISE(ABORT,'I3: append-only'); END;
CREATE TRIGGER positions_guard_del BEFORE DELETE ON positions BEGIN SELECT RAISE(ABORT,'I3: append-only'); END;
CREATE TRIGGER money_lines_guard_upd BEFORE UPDATE ON money_lines BEGIN SELECT RAISE(ABORT,'I1'); END;
CREATE TRIGGER money_lines_guard_del BEFORE DELETE ON money_lines BEGIN SELECT RAISE(ABORT,'I1'); END;`;
  const tables = "CREATE TABLE events (id TEXT);\nCREATE TABLE positions (id TEXT);\nCREATE TABLE money_lines (id TEXT);";

  it("stacked RAISE(ABORT) guard triggers are green (old regex false-positived here)", () => {
    expect(checkMigrationSql([tables + guards]).ok).toBe(true);
  });
  it("a trigger that mutates events is red", () => {
    const bad = tables + guards + "\nCREATE TRIGGER sneak AFTER INSERT ON events BEGIN UPDATE events SET id='x'; END;";
    const r = checkMigrationSql([bad]);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toContain("I3");
  });
  it("missing guard triggers is itself a violation when the table exists", () => {
    const r = checkMigrationSql([tables]); // tables without guards
    expect(r.violations.join(" ")).toContain("missing guard trigger");
  });
});

describe("I8 v2: positions is a partition of entry 9", () => {
  it("events + positions + 20 more = effective 21, ok, no spare warning", () => {
    const sql = ["CREATE TABLE events (id TEXT);", "CREATE TABLE positions (id TEXT);",
      ...Array.from({ length: 20 }, (_, i) => `CREATE TABLE t${i} (id TEXT);`)].join("\n") + GUARDS_SQL;
    const r = checkMigrationSql([sql]);
    expect(r.ok).toBe(true);
    expect(r.tableCount).toBe(21);
  });
  it("positions without events counts as a full table", () => {
    const sql = ["CREATE TABLE positions (id TEXT);", ...Array.from({ length: 22 }, (_, i) => `CREATE TABLE t${i} (id TEXT);`)].join("\n");
    expect(checkMigrationSql([sql]).ok).toBe(false);
  });
  it("the partition map is pinned to exactly ['positions']", () => {
    expect(Object.keys(PARTITION_TABLES)).toEqual(["positions"]);
  });
});
```

(`GUARDS_SQL` is the six-guard string above, exported from the test top; import `PARTITION_TABLES` from `./invariants.js`.)

**Step 2: Run to verify RED** — `pnpm test:tools` → the new cases fail (old regex flags the stacked guards; `PARTITION_TABLES` doesn't exist).

**Step 3: Amend `tools/checks/invariants.ts`**

Replace the I3 section and table counting:

```ts
// Doc 10 entry 9: physical partitions sharing one budget entry with their parent.
// Expanding this map requires a register note (test pins its keys).
export const PARTITION_TABLES: Record<string, string> = { positions: "events" };

// Append-only tables that MUST carry RAISE(ABORT) guard triggers once created (I3, I1).
const GUARDED_TABLES = ["events", "positions", "money_lines"] as const;

export function checkMigrationSql(sqlFiles: string[]): InvariantResult {
  const violations: string[] = [];
  const warnings: string[] = [];
  const tables = new Set<string>();
  const all = sqlFiles.join("\n");

  for (const m of all.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+["'`]?(\w+)/gi)) {
    const name = m[1];
    if (name) tables.add(name.toLowerCase());
  }
  let effective = tables.size;
  for (const [part, parent] of Object.entries(PARTITION_TABLES)) {
    if (tables.has(part) && tables.has(parent)) effective -= 1; // partition shares the parent's entry
  }
  if (effective > TABLE_BUDGET) {
    violations.push(`I8 VIOLATION: ${effective} effective tables > budget ${TABLE_BUDGET}. A 22nd+ table requires a register amendment + written deletion.`);
  } else if (effective > NAMED_TABLES) {
    warnings.push(`I8: spare table slot spent (${effective}/${TABLE_BUDGET}). This requires a written deletion note in the register.`);
  }

  // I3/I1: direct mutation of append-only tables — migrations may only CREATE/INDEX them.
  for (const m of all.matchAll(/\b(UPDATE|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE)\s+["'`]?(events|positions|money_lines)\b/gi)) {
    violations.push(`I3 VIOLATION: migrations may only CREATE/INDEX ${m[2]} — found "${m[0]}". Corrections are new events.`);
  }
  // Triggers on guarded tables: the body must be exactly one RAISE(ABORT) statement.
  for (const m of all.matchAll(/CREATE\s+TRIGGER\s+[\w"'`]+[\s\S]*?\bON\s+["'`]?(events|positions|money_lines)\b[\s\S]*?\bBEGIN\b([\s\S]*?)\bEND\s*;/gi)) {
    const body = (m[2] ?? "").trim();
    if (!/^SELECT\s+RAISE\s*\(\s*ABORT\b[^;]*;$/i.test(body)) {
      violations.push(`I3 VIOLATION: trigger on ${m[1]} may only RAISE(ABORT) — found "${body.slice(0, 60)}"`);
    }
  }
  // Guards are mandatory, not optional: each guarded table present must have both guard triggers.
  for (const t of GUARDED_TABLES) {
    if (!tables.has(t)) continue;
    for (const suffix of ["guard_upd", "guard_del"]) {
      if (!new RegExp(`CREATE\\s+TRIGGER\\s+["'\`]?${t}_${suffix}\\b`, "i").test(all)) {
        violations.push(`I3 VIOLATION: missing guard trigger ${t}_${suffix}`);
      }
    }
  }
  return { ok: violations.length === 0, tableCount: effective, violations, warnings };
}
```

In `main()`: change the glob to `db/**/migrations/*.sql`; add the stray-SQL check and the lockfile check:

```ts
function main(): void {
  const files = globSync("db/**/migrations/*.sql");
  const migrationSet = new Set(files);
  // NOTE: fs.globSync calls `exclude` with the BASENAME for leaf files ("0001_x.sql")
  // and partial paths for directories — never the full relative path. Filtering on the
  // RESULT array is the only correct place for a path-membership test. Using `exclude`
  // for it silently flags every legitimate migration as stray.
  const strays = globSync("**/*.sql", { exclude: (p) => p.includes("node_modules") })
    .filter((p) => isStraySql(p, migrationSet));
  if (strays.length > 0) {
    console.error(`FAIL stray SQL outside db/*/migrations (evades I3/I8 lint): ${strays.join(", ")}`);
    process.exit(1);
  }
  // Forward-only: a merged migration file is immutable (hash-pinned in db/migrations.lock.json).
  const lockPath = "db/migrations.lock.json";
  const lock = existsSync(lockPath) ? (JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, string>) : {};
  for (const f of files) {
    const digest = createHash("sha256").update(readFileSync(f)).digest("hex");
    if (lock[f] && lock[f] !== digest) { console.error(`FAIL migration ${f} was EDITED after lock — migrations are forward-only; add a new file.`); process.exit(1); }
    if (!lock[f] && checkOnly) { console.error(`FAIL migration ${f} is not pinned in ${lockPath} — run \`pnpm lock:migrations\`.`); process.exit(1); }
    lock[f] = lock[f] ?? digest;   // pin-on-first-sight, but ONLY in --write mode
  }
  const result = checkMigrationSql(files.map((f) => readFileSync(f, "utf8")));
  /* ...existing warning/violation/OK printing... */
  // Write the lock only in --write mode and only AFTER invariants pass, so a failing
  // migration never gets pinned and CI can never "fix" the lock by regenerating it.
  if (!checkOnly && result.ok) writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
}
```

(Add `createHash`, `existsSync`, `writeFileSync` imports. Initialize `db/migrations.lock.json` as `{}`. `checkOnly = !process.argv.includes("--write")`; root `check:invariants` runs check-only, and a separate `lock:migrations` script writes.)

**The lint is the enforcement of I3/I8 — close every bypass, and test each one red-path first.** A quality review of the first implementation found these holes; the guard is only worth what it rejects:
- **Strip `--` and `/* */` comments from the SQL before ANY scanning.** A commented-out guard trigger otherwise satisfies the presence check. (This single change also hardens the four below.)
- **`DROP TRIGGER` is a forbidden verb.** Otherwise `0002_evil.sql` containing `DROP TRIGGER events_guard_del;` passes green and append-only is silently off — presence is checked across the concatenation of all files, so 0001's CREATE still satisfies it.
- **`REPLACE INTO` / `INSERT OR REPLACE INTO` are mutations.** REPLACE is delete-then-insert, and SQLite fires `BEFORE DELETE` triggers for it only when `recursive_triggers` is ON (off by default) — so the runtime guard may not catch it either.
- **Guard-presence must match the timing**, not just the name: `CREATE TRIGGER events_guard_upd\s+BEFORE\s+UPDATE\s+ON\s+events`. An `AFTER INSERT` trigger with the right name protects nothing.
- **Three guards per append-only table, not two:** `_guard_ins` (BEFORE INSERT), `_guard_upd`, `_guard_del`. The insert guard is what stops `INSERT OR REPLACE` (Decision 16) — without it the other two are theatre.
- **Ban `OR REPLACE` in application source too.** The migration lint never sees the sequencer or the routes. Add a source scan of `packages/**/src` and `workers/**/src` rejecting `INSERT OR REPLACE` / `OR REPLACE` against `events`, `positions`, `money_lines`.
- **Identifier quote class must include `[`** (SQLite bracket quoting): `CREATE TABLE [events]` otherwise evades the table count, the budget, AND guard-presence; `UPDATE [events]` evades the mutation check.
- **`splitSql` must hard-error on a non-empty trailing buffer** (no `;`), per CLAUDE.md rule 10 "no silent drops" — comment-only fragments are fine, real content is not.
- **The lockfile must fail closed:** check-only in CI (never writes), fails on digest mismatch AND on any migration file absent from the lock (otherwise deleting a lock entry re-pins an edited migration).

**Every guard needs a positive control, not just red-path tests.** The first implementation's stray-SQL fence rejected `db/tenant/migrations/0001_ledger_core.sql` itself — it would have blocked every later task — because the suite only ever asserted what the fence *rejects*. For each check, test that a legitimate artifact **passes**: a real migration under `db/tenant/migrations/` and `db/control/migrations/` must leave `pnpm check:invariants` at exit 0. Assert on the script's composition (glob + filter), not on the pure predicate alone — the bug lived in what the caller passed the predicate, which a unit test of the predicate could never catch.

Root `package.json` also gains devDependencies `"@shuddl/ledger": "workspace:*"` and `"@shuddl/contracts": "workspace:*"` — `tools/` scripts (seed generator, fixture gen) import them via tsx and cannot resolve workspace packages otherwise.

**Step 4: `packages/ledger/src/migrate.ts`** — the in-test applier (wrangler applies in real envs):

```ts
// Test/dev migration applier. Splits on ';' at top level only — trigger bodies
// (BEGIN ... END;) are kept whole. Every trigger body is exactly one statement
// so wrangler's splitter and this one agree.
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let depth = 0;
  for (const line of sql.split("\n")) {
    const stripped = line.replace(/--.*$/, "");
    if (/\bBEGIN\b/i.test(stripped)) depth += 1;
    if (/\bEND\s*;/i.test(stripped)) depth -= 1;
    buf += stripped + "\n";   // comment-STRIPPED, never the raw line: applyMigrations
                              // flattens newlines for D1.exec, and an inline `--`
                              // would then swallow the rest of the statement.
    if (depth === 0 && /;\s*$/.test(stripped)) {
      const stmt = buf.trim();
      if (stmt.length > 1) out.push(stmt);
      buf = "";
    }
  }
  return out;
}

export async function applyMigrations(db: D1Database, files: ReadonlyArray<{ path: string; sql: string }>): Promise<void> {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : 1));
  for (const f of sorted) for (const stmt of splitSql(f.sql)) await db.exec(stmt.replaceAll("\n", " "));
}
```

`packages/ledger/test/migrate.test.ts`: `splitSql` keeps a two-trigger file as 2 statements + a CREATE TABLE as 1; applying a trigger through a real D1 (pool-workers `env.TENANT_A_DB`) then violating it throws `I3`.

Also: `packages/ledger/package.json` gains `"exports": { ".": "./src/index.ts", "./*": "./src/*.ts" }` (Task 13+ import subpaths like `@shuddl/ledger/chain`), `"test": "vitest run"`, deps `@shuddl/contracts workspace:*`, devDeps `vitest ~3.2.4`, `wrangler`, `@cloudflare/vitest-pool-workers`, `@cloudflare/workers-types`; `packages/ledger/vitest.config.ts` mirrors `workers/api/vitest.config.ts` (own minimal `wrangler.test.toml` with two D1 bindings + R2 `EVIDENCE` binding for anchor tests).

**Step 5: Run** — `pnpm test:tools && pnpm --filter @shuddl/ledger test && pnpm check:invariants` → all green (0 migrations yet; lockfile created empty).

**Step 6: Commit** — `db+lint: forward-only lockfile, partition-aware I8, RAISE-only trigger law, stray-SQL fence` — REQ-118, I3/I8 (+ Co-Authored-By footer, as every commit below).

> **Migration workflow for every task below.** `pnpm check:invariants` is check-only: it fails if a migration is unpinned OR its digest changed. So after writing a new `.sql`: run `pnpm db:lock` (the only writer), then commit the `.sql` **and** `db/migrations.lock.json` together. Editing a pinned migration is a hard failure by design — corrections are new files, exactly like corrections are new events. Deleting a lock entry to sidestep this fails too ("not pinned").

---

### Task 2: Tenant migration 0001 — events + positions (+ guard triggers)

**Files:**
- Create: `db/tenant/migrations/0001_ledger_core.sql`
- Test: `packages/ledger/test/schema-core.test.ts`

**Step 1: Failing test** — apply migrations to a fresh D1; assert: (a) `UPDATE events` raises `I3`; (b) `DELETE FROM positions` raises; (c) inserting two events with the same `(stream_id, seq)` fails; (d) `stream_id` CHECK rejects `s:` mismatch; (e) duplicate `(stream_id, device_id, device_seq)` fails.

**Step 2: RED** (file doesn't exist — applyMigrations loader reads `db/tenant/migrations/*.sql` via a small `loadMigrations()` test helper using `import.meta.glob`? No — vitest-pool-workers can't fs-read at runtime; use vite `?raw` imports: `import m1 from "../../../db/tenant/migrations/0001_ledger_core.sql?raw"`).

**Step 3: The DDL** (STRICT tables; integer times; NO IF NOT EXISTS — wrangler tracks):

```sql
-- db/tenant/migrations/0001_ledger_core.sql
-- Doc 10 entry 9: events + positions partition. I3: append-only, guard-trigger enforced.
CREATE TABLE events (
  stream_id   TEXT NOT NULL,             -- 's:{shipment_id}' | 'q:{quote_id}' | 't:root'
  seq         INTEGER NOT NULL,          -- dense per stream, assigned by the sequencer DO
  id          TEXT NOT NULL UNIQUE,      -- uuid, client-generated, idempotency anchor
  shipment_id TEXT,
  ts          INTEGER NOT NULL,          -- actor-claimed epoch ms (advisory for offline capture)
  recorded_at INTEGER NOT NULL,          -- server clock at append; Merkle day bucketing (REQ-014)
  kind        TEXT NOT NULL,
  actor_party_id  TEXT NOT NULL,
  actor_user_id   TEXT,
  actor_device_id TEXT,
  party_refs  TEXT NOT NULL DEFAULT '[]',
  payload     TEXT NOT NULL DEFAULT '{}',
  evidence    TEXT NOT NULL DEFAULT '[]',
  prev_hash   TEXT NOT NULL,
  hash        TEXT NOT NULL UNIQUE,      -- sha256 hex of canonical hash-view
  sig         TEXT,                      -- base64url P-256 over clientView; NULL for server actors (I4 tested)
  visibility  TEXT NOT NULL CHECK (visibility IN ('internal','counterparty','public')),
  source      TEXT NOT NULL DEFAULT 'native' CHECK (source IN ('native','legacy','edi','email')),
  confidence  INTEGER NOT NULL DEFAULT 10000,  -- basis points
  device_id   TEXT, device_seq INTEGER, captured_ts INTEGER,  -- offline reserve (REQ-016, WP-05)
  PRIMARY KEY (stream_id, seq),
  CHECK (device_id IS NULL OR device_seq IS NOT NULL),
  CHECK (shipment_id IS NULL OR stream_id = 's:' || shipment_id)
) STRICT;
CREATE INDEX ix_events_kind_ts ON events(kind, ts);
CREATE INDEX ix_events_shipment ON events(shipment_id) WHERE shipment_id IS NOT NULL;
CREATE INDEX ix_events_recorded ON events(recorded_at);
CREATE UNIQUE INDEX ux_events_device ON events(stream_id, device_id, device_seq) WHERE device_id IS NOT NULL;
CREATE TRIGGER events_guard_upd BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'I3: append-only'); END;
CREATE TRIGGER events_guard_del BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'I3: append-only'); END;

CREATE TABLE positions (
  shipment_id TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  ts          INTEGER NOT NULL,          -- capture epoch ms
  recorded_at INTEGER NOT NULL,
  lat_e6      INTEGER NOT NULL,          -- microdegrees (integer-only canonical law)
  lon_e6      INTEGER NOT NULL,
  accuracy_m  INTEGER,
  speed_cms   INTEGER,                   -- cm/s, integer
  hash        TEXT NOT NULL,             -- sha256 of canonical position row (Merkle leaf)
  PRIMARY KEY (shipment_id, device_id, ts)
) STRICT;
CREATE INDEX ix_positions_recorded ON positions(recorded_at);
CREATE TRIGGER positions_guard_upd BEFORE UPDATE ON positions BEGIN SELECT RAISE(ABORT,'I3: append-only'); END;
CREATE TRIGGER positions_guard_del BEFORE DELETE ON positions BEGIN SELECT RAISE(ABORT,'I3: append-only'); END;
```

**Step 4: GREEN** — schema tests + `pnpm check:invariants` (effective count 1 — events+positions share entry 9; guards present; lockfile pins the file).

**Step 5: Commit** — `ledger schema: events + positions partition, append-only guards` — REQ-011, REQ-002, I3/I8.

---

### Task 3: Migrations 0002 (tenant domain, 16 tables) + 0001_control (4 tables)

**Files:**
- Create: `db/tenant/migrations/0002_domain.sql`, `db/control/migrations/0001_control.sql`
- Test: extend `packages/ledger/test/schema-core.test.ts` (+ new `schema-domain.test.ts`)

**Step 1: Failing tests** — apply all migrations: (a) invariant lint reports **effective 21/22, zero warnings**; (b) `money_lines` guard triggers fire; (c) `money_lines.event_id` FK enforced (insert with unknown event id fails — enable `PRAGMA foreign_keys=ON` in the applier for tests; D1 enables FKs by default); (d) division column exists and is indexed on shipments/money_lines/invoices (REQ-057: `EXPLAIN QUERY PLAN` uses the index, or just insert+filter test).

**Step 2: DDL — `0002_domain.sql`** (tenant, 16 tables; JSON columns marked `-- j`):

```sql
CREATE TABLE parties (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('shipper','consignee','carrier','broker','cartage','factor','insurer')),
  names TEXT NOT NULL, addresses TEXT NOT NULL DEFAULT '[]', contacts TEXT NOT NULL DEFAULT '[]',  -- j
  credit_status TEXT, credit_limit_cents INTEGER, credit_terms TEXT,
  division TEXT, bill_terms_default TEXT, external_refs TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE TABLE passports (
  party_id TEXT PRIMARY KEY REFERENCES parties(id),
  identity TEXT NOT NULL DEFAULT '{}', authority TEXT NOT NULL DEFAULT '{}',
  insurance TEXT NOT NULL DEFAULT '{}', scores TEXT NOT NULL DEFAULT '{}', consents TEXT NOT NULL DEFAULT '{}',  -- j (REQ-009)
  updated_at INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE shipments (
  id TEXT PRIMARY KEY, division TEXT NOT NULL DEFAULT 'main',
  refs TEXT NOT NULL DEFAULT '{}',  -- j {pro,bol,master_job,partner}
  shipper_party_id TEXT NOT NULL, consignee_party_id TEXT NOT NULL, bill_to_party_id TEXT NOT NULL,
  bill_terms TEXT, service TEXT, mode TEXT NOT NULL DEFAULT 'LTL' CHECK (mode IN ('LTL','TL','brokered','cartage','dray','transload')),
  commodities TEXT NOT NULL DEFAULT '[]', service_flags TEXT NOT NULL DEFAULT '{}',  -- j
  status_cache TEXT NOT NULL DEFAULT '{}',  -- j: {state, assigned_driver, out_for_delivery} — projection, not truth
  created_ts INTEGER NOT NULL
) STRICT;
CREATE INDEX ix_shipments_division ON shipments(division);
CREATE TABLE legs (
  id TEXT PRIMARY KEY, shipment_id TEXT NOT NULL REFERENCES shipments(id), seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pickup','linehaul','interline','cartage','delivery','dray')),
  executor_party_id TEXT NOT NULL, custody_state TEXT, split_bps INTEGER, geo TEXT NOT NULL DEFAULT '{}'  -- j
) STRICT;
CREATE TABLE documents (
  id TEXT PRIMARY KEY, shipment_id TEXT, party_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('BOL','POD','photo','WI_cert','invoice','ratecon','COI','W9','claim','tsa_receipt')),
  r2_key TEXT NOT NULL, hash TEXT NOT NULL, lifecycle_class TEXT NOT NULL DEFAULT 'default',
  visibility TEXT NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal','counterparty','public'))
) STRICT;
CREATE TABLE money_lines (
  id TEXT PRIMARY KEY,
  shipment_id TEXT,
  event_id TEXT NOT NULL REFERENCES events(id),   -- I1: no line without event, ever
  line_no INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('ar','ap')),
  kind TEXT NOT NULL CHECK (kind IN ('freight','fsc','accessorial','correction_credit','correction_debit','interline_split','cod_collect','settle_fee','credit_purchase')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents != 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  party_id TEXT NOT NULL,
  division TEXT NOT NULL,                          -- REQ-057
  gl_map TEXT NOT NULL,
  corrects_event_id TEXT,
  basis TEXT NOT NULL DEFAULT '{}',                -- j
  created_ts INTEGER NOT NULL,
  UNIQUE (event_id, line_no)
) STRICT;
CREATE UNIQUE INDEX ux_ml_corrects ON money_lines(corrects_event_id, line_no) WHERE corrects_event_id IS NOT NULL;
CREATE INDEX ix_ml_division ON money_lines(division, direction);
CREATE INDEX ix_ml_shipment ON money_lines(shipment_id);
CREATE TRIGGER money_lines_guard_ins BEFORE INSERT ON money_lines
WHEN EXISTS (SELECT 1 FROM money_lines WHERE id = NEW.id OR (event_id = NEW.event_id AND line_no = NEW.line_no))
BEGIN SELECT RAISE(ABORT,'I1: projections are append-only'); END;
CREATE TRIGGER money_lines_guard_upd BEFORE UPDATE ON money_lines BEGIN SELECT RAISE(ABORT,'I1: projections are append-only'); END;
CREATE TRIGGER money_lines_guard_del BEFORE DELETE ON money_lines BEGIN SELECT RAISE(ABORT,'I1: projections are append-only'); END;
CREATE TABLE invoices (
  id TEXT PRIMARY KEY, party_id TEXT NOT NULL, division TEXT NOT NULL DEFAULT 'main',
  shipment_ids TEXT NOT NULL DEFAULT '[]',  -- j
  total_cents INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'issued',
  issued_event_id TEXT NOT NULL, pdf_doc_id TEXT, terms TEXT, due_ts INTEGER
) STRICT;
CREATE INDEX ix_invoices_division ON invoices(division);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, channel TEXT NOT NULL CHECK (channel IN ('email','sms','voice','portal','note')),
  direction TEXT NOT NULL, party_id TEXT, shipment_id TEXT,
  resolved_conf INTEGER, thread TEXT, body_ref TEXT, drafted_by_agent TEXT, sla_due_ts INTEGER
) STRICT;
CREATE TABLE approvals (
  id TEXT PRIMARY KEY, object_kind TEXT NOT NULL, object_id TEXT NOT NULL, rule TEXT NOT NULL,
  required_role TEXT NOT NULL, requested_event_id TEXT NOT NULL, decided_event_id TEXT, status TEXT NOT NULL DEFAULT 'open'
) STRICT;
CREATE TABLE facilities (
  id TEXT PRIMARY KEY, party_id TEXT, kind TEXT NOT NULL CHECK (kind IN ('terminal','dock','yard')),
  lat_e6 INTEGER, lon_e6 INTEGER, hours TEXT NOT NULL DEFAULT '{}', capacity_slots TEXT NOT NULL DEFAULT '[]', appointment_rules TEXT NOT NULL DEFAULT '{}'  -- j
) STRICT;
CREATE TABLE assets (
  id TEXT PRIMARY KEY, unit_no TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('tractor','trailer','pup')),
  status TEXT NOT NULL DEFAULT 'active', home_facility_id TEXT
) STRICT;
CREATE TABLE rate_config (
  id TEXT PRIMARY KEY, version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('zone_tariff','floors','fsc','accessorials','transit_matrix','class_adapter')),
  payload TEXT NOT NULL, effective_ts INTEGER NOT NULL, approved_by TEXT  -- j payload; I5: quotes pin ids
) STRICT;
CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY, agent TEXT NOT NULL, trigger_event_id TEXT,
  actions TEXT NOT NULL DEFAULT '[]', basis TEXT NOT NULL DEFAULT '[]',  -- j (REQ-005/039)
  confidence INTEGER, cost TEXT NOT NULL DEFAULT '{}', latency_ms INTEGER, outcome TEXT
) STRICT;
CREATE TABLE authority_map (
  module TEXT PRIMARY KEY CHECK (module IN ('rating','invoicing','dispatch','settlement','comms')),
  authority TEXT NOT NULL DEFAULT 'legacy' CHECK (authority IN ('native','legacy')),
  gates_status TEXT NOT NULL DEFAULT '{}', flipped_events TEXT NOT NULL DEFAULT '[]'  -- j (L8)
) STRICT;
CREATE TABLE anomalies (
  id TEXT PRIMARY KEY, rule TEXT NOT NULL, object_kind TEXT, object_id TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('info','warn','critical')), detail TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'open'
) STRICT;
CREATE TABLE integrations (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('edi_partner','eld','quickbooks','email_inbox','tiles','tsa')),
  config TEXT NOT NULL DEFAULT '{}', cert_status TEXT, replay_fixture_ref TEXT
) STRICT;
```

**`0001_control.sql`** (control plane, 4 tables): `tenants`(id PK, name, slug UNIQUE, plan, policy j, divisions j, pro_ranges j, created_ts) · `users`(id PK, tenant_id, email UNIQUE, role CHECK in the six roles, auth j, device_keys j DEFAULT '[]') · `pairings`(id PK, tenant_id, kind CHECK mcp|api|webhook|edi, scopes j, caps j, secret_ref, status) · `usage_credits`(id PK, tenant_id, period, metered j, stripe_refs j). All STRICT.

**Step 3: GREEN** — schema tests pass; `pnpm check:invariants` prints `21/22`. Table census: 4 control + 18 tenant physical − 1 partition = **21 effective**.

**Step 4: Commit** — `schema: all 21 doc-10 tables (control 4 + tenant 17), I1 money guards, REQ-057 division columns` — REQ-011, REQ-057, REQ-009 (fields), I1/I8.

---

### Task 4: Contracts — money types + the 35-kind event envelope

**Files:**
- Create: `packages/contracts/src/money.ts`, `packages/contracts/src/json.ts`, `packages/contracts/src/events.ts`
- Modify: `packages/contracts/src/index.ts` (re-exports)
- Test: `packages/contracts/test/events.test.ts`

**Step 1: Failing tests:**

```ts
import { describe, expect, it } from "vitest";
import { EVENT_KINDS, LedgerEvent, AgentActedPayload, eventFixture } from "../src/index.js";

describe("REQ-011: the 35-kind catalog", () => {
  it("exactly 35 kinds, matching doc 10 §01", () => expect(EVENT_KINDS.length).toBe(35));
  it("every kind has a parseable fixture (round-trip owner is packages/ledger)", () => {
    for (const kind of EVENT_KINDS) expect(LedgerEvent.parse(eventFixture(kind)).kind).toBe(kind);
  });
});
describe("REQ-005: agent.acted requires basis links", () => {
  it("rejects empty basis", () => {
    expect(() => AgentActedPayload.parse({ agent: "biller", action: "draft", basis: [], confidence_bps: 9000 })).toThrow();
  });
});
describe("I4: custody kinds need a device or the unwitnessed flag", () => {
  it("pod.signed without device and without unwitnessed is rejected", () => {
    const f = eventFixture("pod.signed");
    const bad = { ...f, actor: { party: f.actor.party } };
    expect(() => LedgerEvent.parse(bad)).toThrow(/unwitnessed|device/);
  });
  it("unwitnessed flag admits it", () => {
    const f = eventFixture("pod.signed");
    const ok = { ...f, actor: { party: f.actor.party }, payload: { ...f.payload, unwitnessed: true } };
    expect(LedgerEvent.parse(ok).kind).toBe("pod.signed");
  });
});
describe("I5: quotes pin rate_config versions", () => {
  it("quote.priced with empty rate_config_ids (or versions absent) is rejected", () => {
    const f = eventFixture("quote.priced");
    const p = f.payload as { versions: { rate_config_ids: string[] } };
    expect(() => LedgerEvent.parse({ ...f, payload: { ...p, versions: { rate_config_ids: [] } } })).toThrow();
    const { versions: _v, ...rest } = p;
    expect(() => LedgerEvent.parse({ ...f, payload: rest })).toThrow();
  });
});
describe("I4 mirror: custody.transferred", () => {
  it("no device + no unwitnessed rejected; unwitnessed admits", () => {
    const f = eventFixture("custody.transferred");
    const bare = { ...f, actor: { party: f.actor.party } };
    expect(() => LedgerEvent.parse(bare)).toThrow(/unwitnessed|device/);
    expect(LedgerEvent.parse({ ...bare, payload: { ...f.payload, unwitnessed: true } }).kind).toBe("custody.transferred");
  });
});
describe("integer-only law", () => {
  it("float ts / confidence rejected", () => {
    const f = eventFixture("quote.requested");
    expect(() => LedgerEvent.parse({ ...f, ts: 1.5 })).toThrow();
    expect(() => LedgerEvent.parse({ ...f, confidence: 0.9 })).toThrow();
  });
});
```

**Step 2: RED**, then implement.

**`json.ts`** — the integer-only JSON value schema used by loosely-typed payloads:

```ts
import { z } from "zod";
export const SafeInt = z.number().int().refine((n) => Number.isSafeInteger(n) && !Object.is(n, -0), "integer-only canonical law");
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export const JsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), SafeInt, z.boolean(), z.null(), z.array(JsonValue), z.record(z.string(), JsonValue)]),
);
export const JsonObject = z.record(z.string(), JsonValue);
```

**`money.ts`**: `Cents = SafeInt.min(-999_999_999_999).max(999_999_999_999)` (branded), `Bps = SafeInt.min(0).max(10_000)`, `InvoiceIssuedPayload`, `InvoiceCorrectedPayload` (`corrects_event_id`, `reason`, `reissue_lines` — empty array = void), `SplitComputedPayload` (allocations `share_bps` refine sums to 10 000) — exactly as the money design §2.

**`events.ts`** — the envelope:

```ts
export const EVENT_KINDS = [
  "quote.requested","quote.priced","quote.sent","quote.accepted","quote.expired",
  "booking.created","credit.checked","appointment.set","pickup.scheduled","dispatch.assigned",
  "stop.arrived","freight.counted","freight.photographed","dims.captured","custody.transferred",
  "seal.applied","stop.departed","position.updated","exception.raised","osd.captured",
  "pod.signed","delivery.evidenced",
  "invoice.issued","invoice.corrected","payment.received","settlement.executed","split.computed",
  "message.received","message.sent","call.transcribed",
  "document.attached","approval.requested","approval.decided","agent.acted","authority.flipped",
] as const;  // 35 — additions are a register amendment

export const Actor = z.object({ party: z.string().min(1), user: z.string().optional(), device: z.string().optional() }).strict();
export const EvidenceRef = z.object({ doc_id: z.string(), hash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export const Visibility = z.enum(["internal", "counterparty", "public"]);

export const EventBase = z.object({
  id: z.string().uuid(),
  stream_id: z.string().regex(/^(s:[\w-]+|q:[\w-]+|t:root)$/),
  shipment_id: z.string().optional(),
  seq: SafeInt.min(0),
  ts: SafeInt.min(0),                       // epoch ms UTC (assumption 3)
  recorded_at: SafeInt.min(0),
  actor: Actor,
  party_refs: z.array(z.string()),
  evidence: z.array(EvidenceRef),
  prev_hash: z.string().regex(/^[0-9a-f]{64}$/),
  hash: z.string().regex(/^[0-9a-f]{64}$/).optional(), // present on read; computed, never client-supplied
  sig: z.string().optional(),
  visibility: Visibility,
  source: z.enum(["native", "legacy", "edi", "email"]),
  confidence: Bps,
  device_id: z.string().optional(),
  device_seq: SafeInt.min(0).optional(),
  captured_ts: SafeInt.min(0).optional(),
}).strict().refine((e) => e.device_id === undefined || e.device_seq !== undefined,
  "device_seq required when device_id present (offline dedupe key)");
```

Typed payloads (all `.strict()`): `GeoStamp = { lat_e6: SafeInt, lon_e6: SafeInt, accuracy_m: SafeInt.optional() }`; `QuotePricedPayload = { sell: Cents, floors: { contribution: Cents, full: Cents, target: Cents }, versions: { rate_config_ids: z.array(z.string()).min(1) } /* I5 */, basis: JsonObject }`; `PodSignedPayload = { signature_hash: Hash64, geo: GeoStamp, unwitnessed: z.literal(true).optional() }`; `CustodyTransferredPayload = { from_party: string, to_party: string, geo: GeoStamp.optional(), cosig: z.string().optional() /* WP-05 */, unwitnessed: z.literal(true).optional() }`; `AgentActedPayload = { agent: string, action: string, basis: z.array(z.object({ kind: z.enum(["event","doc","config"]), id: z.string() }).strict()).min(1), confidence_bps: Bps, cost_cents: Cents.optional(), latency_ms: SafeInt.optional() }` (REQ-005); `PositionUpdatedPayload = GeoStamp & { speed_cms: SafeInt.optional() }`; money payloads from `money.ts`; every remaining kind gets `payload: JsonObject`.

`LedgerEvent = z.discriminatedUnion("kind", [...35 members...])` **with a superRefine** implementing I4: kinds `custody.transferred`/`pod.signed` require `actor.device` present or `payload.unwitnessed === true`.

`eventFixture(kind, overrides?: Partial<LedgerEvent>)` — a deterministic fixture factory (fixed uuids/timestamps, minimal valid payload per kind, shallow-merged overrides) exported for reuse by ledger/API tests.

**Step 3: GREEN → Commit** — `contracts: 35-kind event envelope, typed payloads, I4/I5/REQ-005 enforced at the boundary` — REQ-011, REQ-005, REQ-001 (partial), I4/I5.

---

### Task 5: Canonicalization (`packages/ledger/src/canonical.ts`)

**Files:** Create `packages/ledger/src/canonical.ts` · Test `packages/ledger/test/canonical.test.ts`

**Step 1: Failing tests** (edge cases are the spec):

```ts
import { describe, expect, it } from "vitest";
import { canonicalize, canonicalBytes, sha256Hex } from "../src/canonical.js";

describe("canonical JSON — the byte law", () => {
  it("sorts keys by UTF-16 code units, no whitespace", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
  it("emits unicode literally; composed vs decomposed hash differently (no NFC)", async () => {
    const a = await sha256Hex(canonicalBytes({ s: "é" }));            // U+00E9
    const b = await sha256Hex(canonicalBytes({ s: "é" }));      // e + combining acute
    expect(a).not.toBe(b);
  });
  it("escapes only quote, backslash, control chars (lowercase \\u00xx)", () => {
    expect(canonicalize({ s: "\u0001\"\\" })).toBe('{"s":"\\u0001\\"\\\\"}');
  });
  it("rejects floats, -0, and unsafe integers", () => {
    for (const bad of [1.5, -0, 2 ** 53]) expect(() => canonicalize({ n: bad })).toThrow();
  });
  it("rejects lone surrogates (TextEncoder would fold them to U+FFFD — non-injective)", () => {
    expect(() => canonicalize({ s: "\ud800" })).toThrow(/surrogate/);
  });
  it("omits undefined members; null survives", () => {
    expect(canonicalize({ a: undefined as unknown as null, b: null })).toBe('{"b":null}');
  });
  it("array order preserved; nested objects sorted", () => {
    expect(canonicalize({ a: [{ z: 1, y: 2 }, 3] })).toBe('{"a":[{"y":2,"z":1},3]}');
  });
  it("known-answer: sha256 of canonical {} is stable", async () => {
    expect(await sha256Hex(canonicalBytes({}))).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
  });
});
```

**Step 2: RED. Step 3: Implement:**

```ts
// Canonical JSON — the byte law of the ledger (REQ-011, REQ-002). JCS (RFC 8785)
// restricted to integer-only numbers. These rules are frozen forever; changing any
// of them breaks every hash chain. Do not "improve" this file.
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

function esc(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (c >= 0xd800 && c <= 0xdfff) throw new Error("canonical law: lone surrogate rejected (non-injective under UTF-8)");
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (c < 0x20) {
      out += ch === "\b" ? "\\b" : ch === "\t" ? "\\t" : ch === "\n" ? "\\n" : ch === "\f" ? "\\f" : ch === "\r" ? "\\r"
        : "\\u" + c.toString(16).padStart(4, "0");
    } else out += ch;
  }
  return out + '"';
}

export function canonicalize(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || Object.is(v, -0)) throw new Error(`canonical law: integers only, got ${v}`);
    return String(v);
  }
  if (typeof v === "string") return esc(v);
  if (Array.isArray(v)) return "[" + v.map((x) => canonicalize(x)).join(",") + "]";
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return "{" + entries.map(([k, val]) => esc(k) + ":" + canonicalize(val)).join(",") + "}";
  }
  throw new Error(`canonical law: unsupported type ${typeof v}`);
}

export function canonicalBytes(v: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(v));
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
```

(Key-sort caveat: JCS sorts by UTF-16 code units — `(a < b)` on JS strings IS UTF-16 code-unit order. Correct as written.)

**Step 4: GREEN → Commit** — `ledger: canonical JSON byte law (JCS-restricted, integer-only)` — REQ-011, REQ-002.

---

### Task 6: Hash chain (`packages/ledger/src/chain.ts`) — the 10K DoD

**Files:** Create `packages/ledger/src/chain.ts` · Test `packages/ledger/test/chain.test.ts`

**Step 1: Failing tests:**

```ts
import { describe, expect, it } from "vitest";
import { GENESIS_HASH, hashEvent, verifyChain, buildChain } from "../src/chain.js";
import { eventFixture, EVENT_KINDS } from "@shuddl/contracts";

describe("REQ-002 DoD: chain verifies after 10K events", () => {
  it("10,000 events verify < 5s; one tampered byte breaks at the right seq", async () => {
    const events = await buildChain(
      Array.from({ length: 10_000 }, (_, i) => eventFixture(EVENT_KINDS[i % 35] as never, { seq: i })),
    );
    const t0 = performance.now();
    const ok = await verifyChain(events);
    expect(ok.ok).toBe(true);
    expect(ok.ok && ok.count).toBe(10_000);
    expect(performance.now() - t0).toBeLessThan(5_000);

    const tampered = events.map((e, i) => (i === 5_000 ? { ...e, payload: { ...e.payload, evil: 1 } } : e));
    const bad = await verifyChain(tampered);
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.failure.seq).toBe(5_000);
  });
  it("seq gap and bad genesis are distinct failures", async () => {
    const chain = await buildChain([eventFixture("quote.requested", { seq: 0 }), eventFixture("quote.priced", { seq: 1 })]);
    expect((await verifyChain([chain[0]!, { ...chain[1]!, seq: 3 }])).ok).toBe(false);
    expect((await verifyChain([{ ...chain[0]!, prev_hash: "1".repeat(64) }])).ok).toBe(false);
  });
});
```

**Step 2: RED. Step 3: Implement:**

```ts
import { canonicalBytes, sha256Hex } from "./canonical.js";
import type { LedgerEvent } from "@shuddl/contracts";

export const GENESIS_HASH = "0".repeat(64);

// hashView: the envelope minus sig and minus the stored hash itself.
// Includes prev_hash + seq + id + ts — tampering anywhere breaks the next link.
export function hashView(e: LedgerEvent): Record<string, unknown> {
  const { sig: _sig, hash: _hash, ...rest } = e as Record<string, unknown>;
  return rest;
}

export async function hashEvent(e: LedgerEvent): Promise<string> {
  return sha256Hex(canonicalBytes(hashView(e)));
}

// Test/fixture helper: assigns seq (dense from 0), prev_hash, hash.
export async function buildChain(events: LedgerEvent[]): Promise<LedgerEvent[]> {
  const out: LedgerEvent[] = [];
  let prev = GENESIS_HASH;
  for (const [i, e] of events.entries()) {
    const withLinks = { ...e, seq: i, prev_hash: prev };
    const hash = await hashEvent(withLinks as LedgerEvent);
    out.push({ ...withLinks, hash } as LedgerEvent);
    prev = hash;
  }
  return out;
}

export type ChainFailure = { seq: number; reason: "prev_hash_mismatch" | "seq_gap" | "bad_genesis" | "hash_mismatch" };
export type ChainResult = { ok: true; head: string; count: number } | { ok: false; failure: ChainFailure };

export async function verifyChain(
  events: AsyncIterable<LedgerEvent> | Iterable<LedgerEvent>,
  opts?: { fromSeq?: number; trustedPrevHash?: string },
): Promise<ChainResult> {
  let expectedSeq = opts?.fromSeq ?? 0;
  let expectedPrev = opts?.trustedPrevHash ?? GENESIS_HASH;
  let count = 0;
  for await (const e of events as AsyncIterable<LedgerEvent>) {
    if (e.seq !== expectedSeq) return { ok: false, failure: { seq: e.seq, reason: "seq_gap" } };
    if (e.prev_hash !== expectedPrev) {
      return { ok: false, failure: { seq: e.seq, reason: e.seq === 0 ? "bad_genesis" : "prev_hash_mismatch" } };
    }
    const recomputed = await hashEvent(e);
    if (e.hash !== undefined && e.hash !== recomputed) return { ok: false, failure: { seq: e.seq, reason: "hash_mismatch" } };
    expectedPrev = recomputed;
    expectedSeq += 1;
    count += 1;
  }
  return { ok: true, head: expectedPrev, count };
}
```

(Tamper detection: mutating payload at seq N changes N's recomputed hash → N+1's `prev_hash` no longer matches; with stored `hash` present it fails at N itself — the test asserts seq 5,000. Streaming: `for await` accepts arrays and async iterables; the API worker pages D1 by `LIMIT 500` keyset on `seq`.)

**Step 4: GREEN → Commit** — `ledger: hash chain — GENESIS, hashView, streaming verifyChain (10K DoD)` — REQ-002, REQ-012 (edits impossible: any mutation breaks the chain).

---

### Task 7: Device signing (`packages/ledger/src/sign.ts`)

**Files:** Create `packages/ledger/src/sign.ts` · Test `packages/ledger/test/sign.test.ts`

**Step 1: Failing tests:** generate a P-256 pair per test (`crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])`); sign a fixture's clientView; verify OK; flip one payload byte → verify fails; wrong key fails; a server-actor event (no device) needs no sig; base64url round-trip.

**Step 2: RED. Step 3: Implement:**

```ts
import { canonicalBytes } from "./canonical.js";
import type { LedgerEvent } from "@shuddl/contracts";

// clientView: exactly the fields a device knows OFFLINE — no seq, no prev_hash,
// no recorded_at (all server-assigned). This is the signed byte set (doc 14 §06
// interpretation; PR assumption). Frozen forever, like the canonical law.
export function clientView(e: Pick<LedgerEvent, "id" | "shipment_id" | "kind" | "payload" | "evidence" | "actor" | "ts"> & { device_id?: string; device_seq?: number; captured_ts?: number }) {
  const { id, shipment_id, kind, payload, evidence, actor, ts, device_id, device_seq, captured_ts } = e;
  return { id, shipment_id, kind, payload, evidence, actor, ts, device_id, device_seq, captured_ts };
}

const b64u = {
  enc: (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""),
  dec: (s: string) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0)),
};

export async function signEvent(e: Parameters<typeof clientView>[0], key: CryptoKey): Promise<string> {
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, canonicalBytes(clientView(e)) as BufferSource);
  return b64u.enc(sig);
}

export async function verifyEventSig(e: Parameters<typeof clientView>[0] & { sig?: string }, pubJwk: JsonWebKey): Promise<boolean> {
  if (!e.sig) return false;
  const key = await crypto.subtle.importKey("jwk", pubJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64u.dec(e.sig) as BufferSource, canonicalBytes(clientView(e)) as BufferSource);
}
```

**Step 4: GREEN → Commit** — `ledger: P-256 device signatures over the offline clientView` — REQ-011, REQ-016 (reserve), I4.

---

### Task 8: The 35-kind round-trip + snapshot pins (REQ-011 DoD — single owner)

**Files:** Test `packages/ledger/test/roundtrip.test.ts`

**Step 1: The test** (this task is test-only — it pins the byte format forever):

```ts
import { describe, expect, it } from "vitest";
import { EVENT_KINDS, LedgerEvent, eventFixture } from "@shuddl/contracts";
import { canonicalize } from "../src/canonical.js";
import { hashEvent, buildChain } from "../src/chain.js";

describe("REQ-011 DoD: all 35 kinds round-trip", () => {
  it.each(EVENT_KINDS.map((k) => [k]))("%s: parse -> canonicalize -> reparse -> identical hash", async (kind) => {
    const [e] = await buildChain([eventFixture(kind)]);
    const parsed = LedgerEvent.parse(JSON.parse(JSON.stringify(e)));
    expect(await hashEvent(parsed)).toBe(await hashEvent(e!));
    expect(parsed).toEqual(e);
  });
  it("canonical strings + hashes are pinned (a diff here = a broken chain format)", async () => {
    const pins: Record<string, { canonical: string; hash: string }> = {};
    for (const kind of EVENT_KINDS) {
      const [e] = await buildChain([eventFixture(kind)]);
      pins[kind] = { canonical: canonicalize({ ...e, sig: undefined, hash: undefined }), hash: await hashEvent(e!) };
    }
    expect(pins).toMatchSnapshot();
  });
});
```

**Step 2:** Run once → snapshot written; run again → stable. Commit the snapshot. Any future diff to `__snapshots__/roundtrip.test.ts.snap` is a chain-format break and must be treated as a Critical.

**Commit** — `ledger: 35-kind round-trip + canonical byte pins (REQ-011 DoD)` — REQ-011.

---

### Task 9: Visibility + redaction (`visibility.ts`, `redact.ts`)

**Files:** Create `packages/ledger/src/visibility.ts`, `packages/ledger/src/redact.ts` · Test `packages/ledger/test/visibility.test.ts`

**Step 1: Failing tests:** per-kind defaults (table-driven over all 35); tenant policy may widen `call.transcribed` to counterparty; per-event override may only narrow; `invoice.corrected` inherits the visibility of the event it corrects; redaction strips `payload.floors|basis|versions` from `quote.priced` for party lenses but leaves `sell`; `generalizePosition` rounds `lat_e6` to ~11 km (`Math.round(lat_e6 / 100_000) * 100_000`) and drops `accuracy_m` pre-OFD.

**Step 2: RED. Step 3: Implement** — `visibility.ts`:

```ts
export const KIND_VISIBILITY_DEFAULTS: Record<EventKind, Visibility> = {
  // counterparty: the physical world + commercial artifacts the party is part of
  "quote.requested": "counterparty", "quote.priced": "counterparty", "quote.sent": "counterparty",
  "quote.accepted": "counterparty", "quote.expired": "counterparty",
  "booking.created": "counterparty", "appointment.set": "counterparty", "pickup.scheduled": "counterparty",
  "dispatch.assigned": "counterparty",
  "stop.arrived": "counterparty", "freight.counted": "counterparty", "freight.photographed": "counterparty",
  "dims.captured": "counterparty", "custody.transferred": "counterparty", "seal.applied": "counterparty",
  "stop.departed": "counterparty", "position.updated": "counterparty", "exception.raised": "counterparty",
  "osd.captured": "counterparty", "pod.signed": "counterparty", "delivery.evidenced": "counterparty",
  "invoice.issued": "counterparty", "invoice.corrected": "counterparty", "payment.received": "counterparty",
  "settlement.executed": "counterparty",
  "message.received": "counterparty", "message.sent": "counterparty", "document.attached": "counterparty",
  // internal: margin, credit, consent, control
  "credit.checked": "internal", "split.computed": "internal", "call.transcribed": "internal",
  "approval.requested": "internal", "approval.decided": "internal", "agent.acted": "internal",
  "authority.flipped": "internal",
};

const RANK: Record<Visibility, number> = { internal: 0, counterparty: 1, public: 2 };

// Append-time resolution: default -> tenant policy (may widen or narrow) ->
// per-event request (may ONLY narrow). Clients never set visibility directly.
export function resolveVisibility(kind: EventKind, policy: Record<string, Visibility> | undefined, requested: Visibility | undefined, correctedEventVisibility?: Visibility): Visibility {
  if (kind === "invoice.corrected" && correctedEventVisibility) return correctedEventVisibility; // I7 nets inside one lens
  let v = policy?.[kind] ?? KIND_VISIBILITY_DEFAULTS[kind];
  if (requested && RANK[requested] < RANK[v]) v = requested;
  return v;
}
```

`redact.ts`: `REDACTIONS` map (`quote.priced` → strip `payload.floors`, `payload.basis`, `payload.versions`; `exception.raised` → `payload.internal_note`), `redactEvent(lens, event)` (deep-clone, delete paths, run `generalizePosition` for party lenses pre-OFD), `generalizePosition(payload, outForDelivery)`.

**Step 4: GREEN → Commit** — `ledger: append-time visibility resolution + party-lens redaction map` — REQ-015, I6.

---

### Task 10: Lenses (`lens.ts`) + SQL goldens

**Files:** Create `packages/ledger/src/lens.ts` · Modify `packages/contracts/src/session.ts` (add `party_id`) · Test `packages/ledger/test/lens.test.ts`

**Step 1: Failing tests:** `lensFor({role:"ops"})` → tenant scope; `lensFor({role:"portal"})` without `party_id` throws; SQL fragments snapshot-pinned; `readEvents` against a seeded D1 returns scoped rows (uses pool-workers D1 + `applyMigrations`).

**Step 2: RED. Step 3: Implement:**

```ts
export type Lens =
  | { scope: "tenant" }                       // admin | ops | finance | read
  | { scope: "party"; partyId: string }       // portal
  | { scope: "driver"; userId: string };

export function lensFor(s: SessionClaims): Lens {
  if (s.role === "portal") {
    if (!s.party_id) throw new Error("LENS_UNRESOLVED: portal session without party_id");
    return { scope: "party", partyId: s.party_id };
  }
  if (s.role === "driver") return { scope: "driver", userId: s.sub };
  return { scope: "tenant" };
}

export interface SqlFragment { sql: string; params: (string | number)[] }

const DRIVER_KINDS = ["appointment.set","pickup.scheduled","dispatch.assigned","stop.arrived","freight.counted","freight.photographed","dims.captured","custody.transferred","seal.applied","stop.departed","exception.raised","osd.captured","pod.signed","delivery.evidenced","document.attached","message.received","message.sent"] as const;

export function lensWhere(lens: Lens, alias = "e"): SqlFragment {
  switch (lens.scope) {
    case "tenant": return { sql: "1=1", params: [] };
    case "party": return {
      sql: `${alias}.visibility <> 'internal' AND EXISTS (SELECT 1 FROM json_each(${alias}.party_refs) WHERE value = ?)`,
      params: [lens.partyId],
    };
    case "driver": return {
      sql: `${alias}.kind IN (${DRIVER_KINDS.map(() => "?").join(",")}) AND ${alias}.shipment_id IN (SELECT id FROM shipments WHERE json_extract(status_cache,'$.assigned_driver') = ?)`,
      params: [...DRIVER_KINDS, lens.userId],
    };
  }
}

export async function readEvents(db: D1Database, lens: Lens, q: { shipment_id?: string; after_seq?: number; cursor?: { stream_id: string; seq: number }; limit?: number }): Promise<LedgerEvent[]> {
  const w = lensWhere(lens);
  const clauses = [w.sql]; const params = [...w.params];
  if (q.shipment_id) { clauses.push("e.shipment_id = ?"); params.push(q.shipment_id); }
  if (q.cursor) { // firehose cursor is COMPOSITE keyset: seq alone is per-stream and would drop rows
    clauses.push("(e.stream_id > ? OR (e.stream_id = ? AND e.seq > ?))");
    params.push(q.cursor.stream_id, q.cursor.stream_id, q.cursor.seq);
  }
  if (q.after_seq !== undefined) { clauses.push("e.seq > ?"); params.push(q.after_seq); } // shipment-scoped reads only
  const rows = await db.prepare(
    `SELECT * FROM events e WHERE ${clauses.join(" AND ")} ORDER BY e.stream_id, e.seq LIMIT ?`,
  ).bind(...params, Math.min(q.limit ?? 200, 1000)).all();
  return rows.results.map((r) => redactEvent(lens, rowToEvent(r)));
}
```

Plus `rowToEvent(row)` and its inverse `eventToRow(e)`.

> **The load-bearing rule of `rowToEvent` (hash-critical).** SQL `NULL` must map to an **omitted key (`undefined`), never to `null`** — for `shipment_id`, `actor.user`, `actor.device`, `device_id`, `device_seq`, `captured_ts`. The canonicalizer omits `undefined` but *emits* `null`, so a `NULL → null` mapping injects `"shipment_id":null` into the canonical form and the recomputed hash drifts from the stored one. Every event read back from D1 would then fail chain verification. `party_refs`/`payload`/`evidence` are safe (canonicalization re-sorts keys, so stored JSON key order is irrelevant). **Test this directly:** insert an event with NULL columns, read it back through `rowToEvent`, and assert `hashEvent(rowToEvent(row)) === row.hash`. `SessionClaims` gains `party_id: z.string().optional()`.

**Step 4: GREEN → Commit** — `ledger: role/party/driver lenses, SQL goldens, row<->envelope round-trip` — REQ-015, REQ-002, I6.

---

### Task 11: Money projections, invoice gate, split rounding, GL export + THE NETTING FIXTURE (I7 DoD)

**Files:**
- Create: `packages/ledger/src/projection/money.ts`, `packages/ledger/src/gates/invoice-gate.ts`, `packages/ledger/src/money/split.ts`, `packages/ledger/src/gl/export.ts`
- Create: `fixtures/gl-netting/seed.json` (deterministic, generated by a fixture script), manifest entry
- Test: `packages/ledger/test/{split.test.ts,money-projection.test.ts,invoice-gate.test.ts,gl-netting.fixture.test.ts}`

**Step 1: Failing tests (the important ones):**

```ts
// split.test.ts — Hamilton allocation: exact by construction
it("always sums exactly (property, 500 random cases)", () => {
  for (let i = 0; i < 500; i++) {
    const total = (1 + Math.floor(rnd() * 1e7)) as Cents;           // seeded mulberry32, not Math.random
    const n = 1 + Math.floor(rnd() * 6);
    const cuts = Array.from({ length: n - 1 }, () => Math.floor(rnd() * 10_000)).sort((a, b) => a - b);
    const bps = [...cuts, 10_000].map((c, j, a) => c - (a[j - 1] ?? 0));
    const parts = allocateCents(total, bps);
    expect(parts.reduce((s, p) => s + p, 0)).toBe(total);
  }
});
it("100 cents over [3333,3333,3334]bps -> [33,33,34]", () => { ... });

// invoice-gate.test.ts
it("invoice.issued before pod.signed -> GATE_BLOCKED with required_evidence ['pod.signed'] (I2)", ...);
it("tenant policy exception class passes", ...);

// gl-netting.fixture.test.ts — THE WP-02 DoD
it("20 shipments, 8 corrections (4 round-trip pairs): grand journal total equals the uncorrected total to the penny", async () => {
  const db = env.TENANT_A_DB; await applyAll(db); await seedGlFixture(db);   // appends via the real projection path
  const journal = await exportJournal(db, { from: 0, to: Number.MAX_SAFE_INTEGER });
  expect(journal.reduce((s, l) => s + l.debit_cents - l.credit_cents, 0)).toBe(0);          // double-entry balances
  const perEvent = await db.prepare(`SELECT corrects_event_id, SUM(amount_cents) s FROM money_lines WHERE corrects_event_id IS NOT NULL GROUP BY corrects_event_id`).all();
  // every corrected event's original+credit lines net to zero:
  for (const r of perEvent.results) { ... assert original sum + credit sum === 0 ... }
  const grand = await db.prepare(`SELECT SUM(amount_cents) s FROM money_lines WHERE direction='ar'`).first();
  expect(grand?.s).toBe(UNCORRECTED_TOTAL_CENTS);   // literal constant computed in the fixture generator
});
it("division filter partitions the journal with no leakage (REQ-057)", ...);
```

**Step 2: RED. Step 3: Implement** — exactly per the money design, consolidated:

- `split.ts`: `allocateCents(total, sharesBps)` — largest-remainder: floor `(total*bps)/10000` per share via integer math, distribute the remainder by descending `(total*bps) % 10000`, ties by index. Postcondition assert.
- `projection/money.ts`: pure `projectMoneyLines(event, deps)` — `invoice.issued` → one `ar` row per payload line; `invoice.corrected` → **full-reversal-plus-reissue** (one `correction_credit` per original line with negated cents + same gl_map/division and `corrects_event_id` set, then `correction_debit` rows for `reissue_lines`; empty = void); `split.computed` → `interline_split` ap rows via `allocateCents`; `payment.received` → `[]` except `payload.method === "cod"` → one `cod_collect`; `settlement.executed` → `settle_fee` (dormant, synthetic-tested); all other 30 kinds → `[]` via exhaustive `switch` with a `never` guard. `applyMoneyProjection(db, event, deps)` returns the prepared statements so the SEQUENCER can include them in its single `db.batch()` (I1 both directions — Task 13 wires it). **It also maintains the `invoices` projection row** (REQ-057 "filterable everywhere"): `invoice.issued` → INSERT invoices(id, party_id, division, total_cents, status='issued', issued_event_id); `invoice.corrected` → INSERT the reissued invoice row (or none on void) — plus a division-filter test over invoices.
- `gates/invoice-gate.ts`: `assertPodSigned(db, streamId, policy)` — query `WHERE stream_id = ? AND kind = 'pod.signed'` (the caller passes the STREAM id, e.g. `s:shp-1`, never a bare shipment id) → throws `GateError("GATE_BLOCKED", ["pod.signed"])` unless such an event exists on the stream or `policy.gates?.invoice_without_pod_classes` matches. The sequencer calls it before appending `invoice.issued` (I2 — ledger-level, so every API path hits it, REQ-030 pattern).
- `gl/export.ts`: each money_line → two `JournalLine`s (debit/credit against `1200-AR`/`2000-AP` vs `gl_map`); export asserts `Σdebits === Σcredits`.
- Fixture: `tools/fixtures/gen-gl-netting.ts` (deterministic, seeded, no Date.now) writes `fixtures/gl-netting/seed.json` — 20 shipments, freight `10_000 + i*137` cents + literal fsc/accessorial lines; corrections on shipments 3/7/11/15: correct to new totals then correct back to the original lines. Vendor it: `fixtures/manifest.json` entry `gl-netting` flips to `status: "vendored"` with its sha256 (the first vendored fixture — hash-pinning goes live).

**Step 4: GREEN** — including `pnpm check:fixtures` now verifying a real hash. **Commit** — `money: projections, Hamilton splits, I2 gate, GL export; gl-netting fixture VENDORED (I7 DoD)` — REQ-012, REQ-057, REQ-003 (guard), I1/I2/I7, REQ-112.

---

### Task 12: Passport accrual + status-cache projections (REQ-009, audit #5/#11)

**Files:**
- Create: `packages/ledger/src/projection/passports.ts`, `packages/ledger/src/projection/status-cache.ts`
- Test: `packages/ledger/test/projections.test.ts`

**Step 1: Failing tests** (seed `parties` rows first — `passports.party_id` has an enforced FK; every fixture that appends events for a party must create the party, a rule that also binds Tasks 11/14/17): `pod.signed` increments `passports.scores.deliveries` (and `.on_time` when `payload.on_time === true`) for the executing carrier party; `exception.raised`/`osd.captured` increment `scores.exceptions`/`scores.claims_opened`; a party with no passport row gets one created (upsert); `dispatch.assigned` sets `status_cache.assigned_driver`; `stop.departed` with `payload.leg === "delivery"`... no — **out_for_delivery flips on `stop.departed` whose payload.leg_kind === "pickup" of the final delivery leg is WP-05 nuance; v1 rule: `position.updated` never flips it; `stop.departed` with `payload.out_for_delivery === true` sets it** (driver PWA sets the flag in WP-05; tests drive it directly). `pod.signed` sets `status_cache.state = "delivered"`.

**Step 2: RED. Step 3: Implement** — both return prepared statements for the sequencer batch:

```ts
// passports.ts — REQ-009: passport fields accrue from events. Passports are mutable
// projections (NOT append-only); truth remains the events they derive from.
export function projectPassport(db: D1Database, e: LedgerEvent): D1PreparedStatement[] {
  const bump = (party: string, field: string, alsoOnTime = false) => db.prepare(`
    INSERT INTO passports (party_id, scores, updated_at) VALUES (?, json_object(?, 1), ?)
    ON CONFLICT(party_id) DO UPDATE SET
      scores = json_set(scores, '$.' || ?2, COALESCE(json_extract(scores, '$.' || ?2), 0) + 1),
      updated_at = ?3`).bind(party, field, e.recorded_at);
  switch (e.kind) {
    case "pod.signed": {
      const stmts = [bump(e.actor.party, "deliveries")];
      if ((e.payload as { on_time?: boolean }).on_time) stmts.push(bump(e.actor.party, "on_time"));
      return stmts;
    }
    case "exception.raised": return [bump(e.actor.party, "exceptions")];
    case "osd.captured": return [bump(e.actor.party, "claims_opened")];
    case "custody.transferred": return [bump(e.actor.party, "custody_events")];
    default: return [];
  }
}
```

`status-cache.ts`: **`booking.created` first UPSERTS the `shipments` row itself** (id, division, shipper/consignee/bill_to party ids, created_ts — all from the typed payload; without this no later `json_set` projection has a row to update and the driver lens would stay empty forever). Then the kind→state map (`booking.created→booked`, `dispatch.assigned→dispatched` + `$.assigned_driver = actor.user`, `custody.transferred→in_transit`, `stop.departed` + `payload.out_for_delivery→$.out_for_delivery=true`, `pod.signed→delivered`, `exception.raised→exception`) via `json_set` on `shipments.status_cache`.

**Step 4: GREEN → Commit** — `projections: passports accrue from events (REQ-009); status_cache feeds driver lens + OFD` — REQ-009, REQ-015 (dependency).

---

### Task 13: The ShipmentSequencer Durable Object (doc 14 §06)

**Files:**
- Create: `workers/api/src/do/sequencer.ts`
- Modify: `workers/api/src/index.ts` (export DO class), `workers/api/wrangler.toml` (DO binding + migration), `workers/api/package.json` (dep `@shuddl/ledger workspace:*`), `packages/contracts/src/events.ts` (+index re-export: `EventInput` with `requested_visibility`)
- Test: `workers/api/test/sequencer.test.ts`

**Step 1: Failing tests** (vitest-pool-workers; `SELF` for routes lands Task 14 — here use `env.SHIPMENT_SEQ` stubs + `runInDurableObject`). Test setup applies `db/control/migrations` to `CONTROL_DB` and seeds a `tenants` row (policy `{}`) + a `users` row with a test device JWK in `device_keys` — `#policy`/`#deviceKey` read them on every append:

```ts
it("assigns dense seqs under 100 concurrent appends (the mutex proof)", async () => {
  const stub = env.SHIPMENT_SEQ.get(env.SHIPMENT_SEQ.idFromName("tenant-a|s:shp-1"));
  const results = await Promise.all(Array.from({ length: 100 }, (_, i) =>
    stub.append({ tenant: "tenant-a", streamId: "s:shp-1", input: fixtureInput(i) })));
  expect(new Set(results.map((r) => r.seq)).size).toBe(100);
  expect(Math.max(...results.map((r) => r.seq))).toBe(99);
  const chain = await verifyChain(rowsFromDb(env.TENANT_A_DB, "s:shp-1"));
  expect(chain.ok).toBe(true);
});
it("a forged tenant in the RPC is structurally rejected (id-equality)", async () => {
  const stub = env.SHIPMENT_SEQ.get(env.SHIPMENT_SEQ.idFromName("tenant-a|s:shp-2"));
  await expect(stub.append({ tenant: "tenant-b", streamId: "s:shp-2", input: fixtureInput(0) })).rejects.toThrow(/FORBIDDEN/);
});
it("crash-heal: DO storage wiped, next append resumes from the D1 tail", async () => {
  // append 3, then runInDurableObject((inst, state) => { state.storage.deleteAll();
  //   (inst as { tail: unknown; pin: unknown }).tail = null; (inst as { pin: unknown }).pin = null; })
  // — wiping storage alone leaves the in-memory cache warm and proves nothing.
  // Then append 1 more -> seq 3, prev_hash = hash of seq 2 (reloaded from D1).
});
it("duplicate event id returns the original row; count unchanged (idempotent replay)", ...);
it("duplicate (device_id, device_seq) returns original (offline reserve)", ...);
it("invoice.issued without pod.signed on the stream -> GATE_BLOCKED (I2 wired)", ...);
it("invoice.issued projects money_lines in the SAME batch (I1 both directions)", ...);
it("client-supplied visibility can only narrow (resolveVisibility wired)", ...);
it("position.updated kind is rejected here (bypass route owns it)", ...);
it("a device-signed event with a bad sig is rejected; a good sig lands with sig stored", ...);
```

**Step 2: RED. Step 3: Implement `workers/api/src/do/sequencer.ts`:**

```ts
import { DurableObject } from "cloudflare:workers";
import { LedgerEvent, EventInput, type Visibility } from "@shuddl/contracts";
import { GENESIS_HASH, hashEvent } from "@shuddl/ledger/chain";
import { verifyEventSig } from "@shuddl/ledger/sign";
import { resolveVisibility } from "@shuddl/ledger/visibility";
import { applyMoneyProjection } from "@shuddl/ledger/projection/money";
import { assertPodSigned } from "@shuddl/ledger/gates/invoice-gate";
import { projectPassport } from "@shuddl/ledger/projection/passports";
import { projectStatusCache } from "@shuddl/ledger/projection/status-cache";
import { eventToRow, rowToEvent } from "@shuddl/ledger/lens";
import { tenantDb } from "../tenants.js";
import type { Env } from "../index.js";

export class ShipmentSequencer extends DurableObject<Env> {
  private tail: { seq: number; hash: string } | null = null;   // cache; D1 is truth
  private pin: { tenant: string; streamId: string } | null = null;
  private lock: Promise<unknown> = Promise.resolve();

  async append(req: { tenant: string; streamId: string; input: unknown }): Promise<LedgerEvent> {
    const run = this.lock.then(() => this.#append(req));
    // the mutex: DO input gates do NOT cover awaits into D1 — serialize explicitly
    this.lock = run.catch(() => undefined);
    return run;
  }

  async #append({ tenant, streamId, input }: { tenant: string; streamId: string; input: unknown }): Promise<LedgerEvent> {
    // REQ-025: structural tenant pinning. The caller-declared identity must re-derive
    // to OUR OWN id — a forged tenant produces a different DO, so this instance can
    // never be tricked into another tenant's D1.
    const expected = this.env.SHIPMENT_SEQ.idFromName(`${tenant}|${streamId}`);
    if (!expected.equals(this.ctx.id)) throw new Error("FORBIDDEN: sequencer identity mismatch");
    const pinned = this.pin ?? (await this.ctx.storage.get<{ tenant: string; streamId: string }>("pin")) ?? null;
    if (pinned && (pinned.tenant !== tenant || pinned.streamId !== streamId)) throw new Error("FORBIDDEN: pin mismatch");
    if (!pinned) { this.pin = { tenant, streamId }; await this.ctx.storage.put("pin", this.pin); }

    const db = tenantDb(this.env, tenant);
    const parsed = EventInput.parse(input);                   // no seq/prev_hash/recorded_at from clients
    if (parsed.kind === "position.updated") throw new Error("VALIDATION_FAILED: positions bypass the sequencer (POST /v1/positions)");

    // replay by id — idempotent
    const existing = await db.prepare("SELECT * FROM events WHERE id = ?").bind(parsed.id).first();
    if (existing) return rowToEvent(existing);
    if (parsed.device_id != null) {
      const dupe = await db.prepare("SELECT * FROM events WHERE stream_id=? AND device_id=? AND device_seq=?")
        .bind(streamId, parsed.device_id, parsed.device_seq ?? -1).first();
      if (dupe) return rowToEvent(dupe);
    }

    // device signature (I4/REQ-011): driver-actor events must verify against users.device_keys
    if (parsed.actor.device) {
      const jwk = await this.#deviceKey(tenant, parsed.actor.device);
      if (!jwk || !(await verifyEventSig(parsed, jwk))) throw new Error("UNAUTHORIZED: bad device signature");
    }

    if (parsed.kind === "invoice.issued") await assertPodSigned(db, streamId, await this.#policy(tenant)); // I2

    // load tail (D1 is truth; storage tail only ever trusted if >= D1 — cheap: just read D1 tail once per wake)
    if (!this.tail) {
      const row = await db.prepare("SELECT seq, hash FROM events WHERE stream_id=? ORDER BY seq DESC LIMIT 1").bind(streamId).first<{ seq: number; hash: string }>();
      this.tail = row ? { seq: row.seq, hash: row.hash } : { seq: -1, hash: GENESIS_HASH };
    }

    const correctedVis = parsed.kind === "invoice.corrected" ? await this.#visibilityOf(db, parsed.payload.corrects_event_id) : undefined;
    // requested_visibility is INPUT-only: it must never reach the hashed envelope
    // (no DB column -> rowToEvent could never reproduce the hash).
    const { requested_visibility, ...clientFields } = parsed;
    const event = {
      ...clientFields,
      stream_id: streamId,
      seq: this.tail.seq + 1,
      prev_hash: this.tail.hash,
      recorded_at: Date.now(),
      visibility: resolveVisibility(parsed.kind, (await this.#policy(tenant)).visibility, requested_visibility, correctedVis),
    } as LedgerEvent;
    const hash = await hashEvent(event);
    const full = { ...event, hash } as LedgerEvent;

    // ONE batch: event + money lines + passport + status_cache (I1 both directions)
    const stmts = [
      insertEventStmt(db, eventToRow(full)),
      ...applyMoneyProjection(db, full),
      ...projectPassport(db, full),
      ...projectStatusCache(db, full),
    ];
    await db.batch(stmts);

    this.tail = { seq: full.seq, hash };                       // bump AFTER commit — crash self-heals from D1
    return full;
  }
  /* #deviceKey / #policy: cached reads of control-plane users.device_keys / tenants.policy via env.CONTROL_DB */
}
```

`EventInput` (contracts): the client-suppliable subset — envelope minus `seq/prev_hash/recorded_at/visibility/hash/stream_id` plus optional `requested_visibility` (narrow-only) and optional `device_id/device_seq/captured_ts`. wrangler.toml: `[[durable_objects.bindings]] name = "SHIPMENT_SEQ" class_name = "ShipmentSequencer"` + `[[migrations]] tag = "v2-sequencer" new_sqlite_classes = ["ShipmentSequencer"]` + `[[d1_databases]] binding = "CONTROL_DB" database_name = "shuddl-control-dev"`.

**Step 4: GREEN → Commit** — `sequencer DO: tenant-pinned, mutex-serialized, gate+projection batch append` — REQ-002, REQ-011, REQ-025, I1/I2/I3, doc 14 §06.

---

### Task 14: Routes + the adversarial lens suite (REQ-015 DoD) + isolation suite growth

**Files:**
- Create: `workers/api/src/routes/events.ts`, `workers/api/src/routes/positions.ts`
- Modify: `workers/api/src/index.ts` (mount)
- Test: `workers/api/test/lens-adversarial.test.ts`; extend `workers/api/test/isolation.test.ts`

**Step 1: Routes:**

```ts
// POST /v1/shipments/:id/events  (ops/admin/driver; drivers only their assigned shipments — checked in handler)
// GET  /v1/shipments/:id/events  -> readEvents(tenantDb, lensFor(session), {shipment_id})
// GET  /v1/events?cursor=<stream_id>:<seq>&limit=  (tenant lens roles only; COMPOSITE keyset cursor — doc 14 §04; after_seq is only valid together with a shipment scope)
// POST /v1/positions  -> Zod PositionInput -> INSERT OR IGNORE (PK idempotency) + hash = sha256(canonical(row))
```

The POST handler derives `streamId = "s:" + params.id`, calls `env.SHIPMENT_SEQ.get(idFromName(`${session.tenant}|${streamId}`)).append(...)` — tenant from the JWT claim only. **Error translation is the route's job** (Workers RPC preserves only name/message, so `instanceof ApiError` is false on arrival): the DO throws `Error` whose message is `CODE:json`, e.g. `GATE_BLOCKED:{"required_evidence":["pod.signed"]}`; the route wraps `stub.append()` in try/catch, splits on the first `:`, and rethrows `new ApiError(code, statusFor(code), message, gate)` so the existing `handleError` renders the envelope. A unit test asserts GATE_BLOCKED arrives with `gate.required_evidence` intact and unknown prefixes map to INTERNAL.

**Step 2: The adversarial suite** (`lens-adversarial.test.ts`; seeded via `applyMigrations` + the real append path — 1 tenant, shipper P1, consignee P2, cartage P3, drivers D1/D2, all 35 kinds across 3 shipments):

1. Portal P1 lists events → **zero** `approval.*`, `agent.acted`, `split.computed`, `credit.checked`, `call.transcribed` (string-search the raw body for each kind).
2. P1 reads `quote.priced` → `payload.sell` present; the whole body contains no `"floors"`, `"basis"`, `"versions"` substrings.
3. P1 on a P2-only shipment → empty; `?party_id=P2` forgery → ignored (claim wins; assert same result).
4. Driver D1 on D2's shipment → empty; D1 sees no `invoice.issued` even on own shipment (kind allowlist).
5. Consignee `position.updated` pre-OFD → `lat_e6 % 100000 === 0` and no `accuracy_m`; after the OFD flag flips → exact.
6. Append with `requested_visibility: "counterparty"` on `approval.requested` → stored `internal`.
7. `custody.transferred` with both P1 and P3 in `party_refs` → each sees it exactly once.
8. Correction pair under P1's lens → both legs visible, sum zero (I7 inside a lens).
9. Table-driven I6 sweep: for each of the 35 kinds × 3 lens scopes, assert visibility matches the defaults map.
10. **Isolation suite growth (REQ-025):** tenant-a token on `GET /v1/shipments/:id/events` for a tenant-b shipment id → empty (different D1, different DO namespace); the WP-01 attack cases re-run against the new routes.

**Step 3: GREEN → Commit** — `routes + adversarial lens suite: cross-lens reads fail (REQ-015 DoD); isolation suite extended to ledger routes` — REQ-015, REQ-025, REQ-002, I6.

---

### Task 15: Merkle tree + RFC 3161 DER (`merkle.ts`, `tsa/`)

**Files:**
- Create: `packages/ledger/src/merkle.ts`, `packages/ledger/src/tsa/der.ts`, `packages/ledger/src/tsa/client.ts`
- Create: `fixtures/merkle-vectors/vectors.json` (+ manifest entry, vendored)
- Test: `packages/ledger/test/{merkle.test.ts,der.test.ts}`

**Step 1: Failing tests:** RFC 6962 known-answer vectors (empty tree = `sha256("")` = `e3b0c442...`; the CT test vectors for 1–7 leaves) pinned in the fixture; property loop n = 1..257: every leaf's `inclusionProof` verifies against the root, any mutated leaf/proof/root fails. DER: golden bytes for a known digest+nonce; **the classic high-bit INTEGER pad** (nonce starting `0x80+` needs a leading `0x00`); `parseTimeStampResp` round-trips `FakeTsaClient` output.

**Step 2: RED. Step 3: Implement** — `merkle.ts` per RFC 6962 (`leaf = sha256(0x00 || data)`, `node = sha256(0x01 || L || R)`, odd node promotes, `ProofStep = {side, hash}`); `tsa/der.ts` minimal DER: `encodeTimeStampReq({digestHex, nonce})` (SEQUENCE{version 1, messageImprint{SHA-256 OID 2.16.840.1.101.3.4.2.1, OCTET STRING}, INTEGER nonce, BOOLEAN certReq}) + `parseTimeStampResp(bytes)` extracting `{status, imprintDigestHex, nonceHex}` by TLV walk — verified: status granted, imprint match, nonce echo; CMS chain verification deferred (Decision 15). `tsa/client.ts`: `TsaClient` interface, `HttpTsaClient(config, fetchImpl)` (POST `application/timestamp-query`), `FakeTsaClient` (builds a granted response via the same encoder).

**Step 4: GREEN → Commit** — `ledger: RFC 6962 Merkle + minimal RFC 3161 DER, pluggable TSA client` — REQ-014.

---

### Task 16: Daily anchor job + anchors API (REQ-014 DoD)

**Files:**
- Create: `packages/ledger/src/anchor.ts`, `workers/api/src/routes/anchors.ts`, `packages/contracts/src/anchors.ts`
- Modify: `workers/agents/wrangler.toml` (crons + D1/R2 bindings), `workers/agents/src/index.ts` (scheduled handler), `workers/agents/package.json` (add `"test": "vitest run"` + devDeps `vitest ~3.2.4`, `@cloudflare/vitest-pool-workers`, `wrangler`)
- Create: `workers/agents/vitest.config.ts` (pool-workers, mirrors workers/api), `workers/agents/src/tenants.ts` (allowlist mirror + parity test vs workers/api)
- Test: `packages/ledger/test/anchor.test.ts`, `workers/agents/test/anchor-cron.test.ts`

**Step 1: Failing tests:**

```ts
// anchor.test.ts — THE REQ-014 DoD
it("a pod.signed hash verifies against the day's TSA-stamped root", async () => {
  const db = env.TENANT_A_DB; await applyAll(db); await seedDayOfEvents(db);   // incl. one pod.signed
  const res = await runDailyAnchor({ db, r2: env.EVIDENCE, tsa: new FakeTsaClient(), tenant: "tenant-a", now: () => new Date("2026-07-10T01:00:00Z") });
  expect(res.anchored).toContain("2026-07-09");
  const pod = await db.prepare("SELECT hash FROM events WHERE kind='pod.signed'").first<{ hash: string }>();
  const proof = await anchorProof(db, "2026-07-09", pod!.hash);
  expect(await verifyInclusion(hexToBytes(pod!.hash), proof.steps, hexToBytes(proof.root))).toBe(true);
  const receipt = parseTimeStampResp(await (await env.EVIDENCE.get(`anchors/tenant-a/2026-07-09/tsr.der`))!.arrayBuffer());
  expect(receipt.imprintDigestHex).toBe(await sha256Hex(utf8(`shuddl-anchor-v1:tenant-a:2026-07-09:${proof.root}:${proof.leafCount}`)));
});
it("determinism: two runs -> identical root; re-run is a no-op (INSERT OR IGNORE doc row)", ...);
it("late upload: yesterday's ts but today's recorded_at lands in TODAY's tree; yesterday's root unchanged", ...);
it("empty day still anchors (gap-free day chain)", ...);
it("TSA failure leaves the day unanchored and retried; 3 consecutive failures -> anomalies row", ...);
```

**Step 2: RED. Step 3: Implement** — `anchor.ts` exactly per the merkle design §§2/4: leaves = events by `(stream_id, seq)` where `recorded_at` in day D (leaf data = hex-decoded event hash), then positions by `(shipment_id, device_id, ts)` (leaf = canonical position bytes); imprint = `sha256("shuddl-anchor-v1:{tenant}:{day}:{root}:{leafCount}")`; storage = `documents` row id `anchor:{day}`, kind `tsa_receipt`, R2 `anchors/{tenant}/{day}/{manifest.json,tsr.der}`; row exists iff fully anchored; boundary race guard (recount after build, abort on mismatch); backfill oldest-first cap 30; TSA config from `integrations` kind `tsa`, missing in prod → anomaly, dev/CI → fake. Cron `0 1 * * *` in workers/agents; scheduled handler enumerates the tenant allowlist. Routes: `GET /v1/anchors/:day` (tenant roles: full manifest; portal: `{day, root}` only — Decision 14), `GET /v1/anchors/:day/proof?leaf=`, `POST /v1/anchors/run` (admin).

**Step 4: GREEN → Commit** — `daily Merkle anchor -> TSA: cron, backfill, inclusion proofs (REQ-014 DoD via FakeTsaClient; real endpoint = F1 CONFIRM)` — REQ-014, REQ-002.

---

### Task 17: SEED-1 → D1 loader (closes the WP-01 deferred REQ-155 slice)

**Files:**
- Create: `tools/seed/load.ts` (root script `seed:load`)
- Modify: `tools/seed/generate.ts` (emit schema-shaped events: stream_id, integer ts, recorded_at, canonical hashes via `buildChain` — `generateSeed` becomes async), `tools/seed/verify.ts` + `tools/seed/seed.test.ts` (await the async generator)
- Test: `packages/ledger/test/seed-load.test.ts`

**Step 1: Failing test:** load SEED-1 into a fresh D1 → 20 shipments, all event chains `verifyChain` green, deterministic dataset hash **repinned once** (generator now emits the WP-02 envelope — a deliberate seed change: regenerate `tools/seed/seed.hash`, say so in the PR per the WP-01 rule).

**Step 2–3:** Update the generator (respect all Task 4 payload schemas — `eventFixture` reuse), write the loader (uses `applyMigrations` + `eventToRow` inserts + projections replay), repin.

**Step 4: GREEN → Commit** — `SEED-1 loads into D1; chains verify; hash repinned (deliberate, WP-02 envelope)` — REQ-155, REQ-002.

---

### Task 18: Close-out — activate WP-02 traceability, checklist, full verify

**Files:**
- Modify: `tools/traceability/active-wps.json` → `{"active": ["WP-01", "WP-02"]}`
- Create: `docs/wp/WP-02.md` (checklist mirroring docs/wp/WP-01.md: DoD evidence · REQ→evidence table · deferred slices · assumption log · proposed register notes)
- Modify: `docs/security/threat-model.md` (the WP-02 review the doc promises: chain-fork attempts, seq races, TSA receipt validation rows)

**Step 1:** Flip active-wps **and edit root `package.json`: `"check:traceability": "tsx tools/traceability/orphans.ts"` (drop `--wp WP-01` — the CLI flag overrides the JSON, so without this edit the flip is a no-op)** → run `pnpm check:traceability` → RED until every one of REQ-001/002/005/009/011/012/014/015/057 has an implementation annotation (they will by now; fix any stragglers at the real site).

**Step 2: DoD evidence run** (paste outputs into `docs/wp/WP-02.md`):
1. `pnpm --filter @shuddl/ledger test` — 35-kind round-trip + snapshot pins green (DoD 1).
2. `pnpm --filter @shuddl/api test` — sequencer 10K/concurrency + adversarial lens suite green (DoD 2, 4).
3. `pnpm --filter @shuddl/ledger test -- gl-netting` — netting to the penny (DoD 3).
4. `pnpm verify` — the whole WP-01 gate chain still green, table census 21/22, fixtures manifest now has TWO vendored entries.

**Step 3: Register notes to propose in the PR** (append-only; owner ratifies): events PK `(stream_id, seq)`; `tsa_receipt` documents-kind; integer-epoch-ms ledger timestamps; REQ-111 log→ledger deferral to WP-11; TSA real-endpoint smoke as WP-02 exit gate blocked on F1 [CONFIRM].

**Step 4:** Update WP-02 checklist boxes, commit — `WP-02 close: checklist + DoD evidence; threat model reviewed` — REQ-118, REQ-119 (exit audit swarm pending), REQ-131.

**Step 5:** The WP-exit adversarial audit swarm (REQ-119) runs before merge — no open Criticals at close.

---

## Deferred / explicitly out of WP-02 scope

- Board-DO fan-out + live map subscriptions → WP-03 (the sequencer exposes a `notifyBoard` no-op seam).
- Agent queue triggers → WP-06+ (same seam).
- On-device key generation + offline batch merge + co-sign ack → WP-05 (columns, clientView, and the (device_id, device_seq) unique reserve land now).
- Real TSA endpoint smoke → blocked on F1 [CONFIRM]; `HttpTsaClient` is fake-tested only.
- CMS cert-chain verification of TSA receipts → WP-16 audit item (raw receipts retained).
- Cash application for `payment.received` → WP-11.
- Full-tenant export (REQ-010) → WP-11; nightly D1 snapshot job activation → F1-A creds (spec in docs/ops/dr-backups.md).
