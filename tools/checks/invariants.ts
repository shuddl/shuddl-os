import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, globSync as globSyncRaw, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { stripSqlComments } from "@shuddl/ledger/migrate";

// I8 (doc 10): ≤22 tables — 21 named, the spare requires a written deletion (register note).
// macOS/iCloud name-collision duplicates ("0008_x 2.sql", "index 3.ts") are gitignored, but EVERY gate in
// this file reads the FILESYSTEM, not `git ls-files` — so an ignored duplicate still reaches the scans.
// MEASURED (audit §253): copying one migration to "0008_append_only_unique_guards 2.sql" turns
// `check:invariants` RED, reporting that four test helpers fail to apply a "shipped migration" that is not
// shipped at all. Fail-closed, so not dangerous — but it is the cry-wolf mode on any iCloud-synced
// checkout, and it accuses the developer of a defect they did not create (the §252 fault, again).
//
// Filtered at the GLOB rather than per-caller, deliberately: there are 15 glob sites here, and a predicate
// each caller must remember to apply is one a future caller will forget (§244 — key the guard on something
// that cannot be omitted). `globSync` is shadowed so the raw import is unreachable by accident.
export function isCollisionDuplicate(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return / \d{1,2}\.[^.]+$/.test(base); // "name 2.ext" … "name 99.ext"; "name2.ext" is untouched
}

type GlobOpts = { cwd?: string; exclude?: (p: string) => boolean };
function globSync(pattern: string, opts?: GlobOpts): string[] {
  const raw = opts === undefined ? globSyncRaw(pattern) : globSyncRaw(pattern, opts);
  return (raw as string[]).filter((p) => !isCollisionDuplicate(p));
}

export const TABLE_BUDGET = 22;
const NAMED_TABLES = 21;

// Doc 10 entry 9: physical partitions sharing one budget entry with their parent.
// Expanding this map requires a register note (test pins its keys).
export const PARTITION_TABLES: Record<string, string> = { positions: "events" };

// Append-only tables that MUST carry RAISE(ABORT) guard triggers once created (I3, I1).
const GUARDED_TABLES = ["events", "positions", "money_lines"] as const;

// EVERY tenant table is classified — append-only (guarded) or deliberately mutable (audit §265).
// GUARDED_TABLES is hand-curated, and append-only enforcement is keyed to it in TWO places: the guard-
// completeness check below, and the REPLACE-ban matcher's table alternation. A new append-only table
// therefore needs two edits nobody is prompted to make, and if it gets neither, an `INSERT OR REPLACE`
// against it silently erases the chained row under D1's `recursive_triggers = 0` — the exact defect
// migration 0008 closed for `money_lines`.
//
// So the classification is forced rather than remembered: every `CREATE TABLE` in db/tenant/migrations
// must appear in GUARDED_TABLES or MUTABLE_TABLES. Adding a table without deciding fails the gate with the
// question attached. MUTABLE_TABLES is a DECLARATION, not a dumping ground — each entry is a table whose
// UPDATE/DELETE is a legal domain write (`legs` claims a dock slot, REQ-028/052; `anomalies` is an ops
// table whose markers resolve; the rest are current-state rows the ledger projects INTO).
const MUTABLE_TABLES = [
  "agent_runs", "anomalies", "approvals", "assets", "authority_map", "documents", "facilities",
  "integrations", "invoices", "legs", "messages", "parties", "passports", "rate_config", "shipments",
] as const;

export function checkTableClassification(createdTables: readonly string[]): string[] {
  const known = new Set<string>([...GUARDED_TABLES, ...MUTABLE_TABLES]);
  const unclassified = [...new Set(createdTables)].filter((t) => !known.has(t)).sort();
  if (unclassified.length === 0) return [];
  return [
    `unclassified tenant table(s): ${unclassified.join(", ")} — is each APPEND-ONLY or MUTABLE? ` +
      `Append-only ⇒ add to GUARDED_TABLES *and* the REPLACE-ban alternation, and ship BEFORE INSERT/UPDATE/DELETE guards ` +
      `(without them an INSERT OR REPLACE silently erases rows under recursive_triggers=0 — see migration 0008). ` +
      `Mutable ⇒ add to MUTABLE_TABLES with the domain write that justifies it (audit §265).`,
  ];
}

// Identifier-delimiter fragments. SQLite lets an identifier be bare, or wrapped in a quote/backtick/
// bracket, and lets a name abut a keyword with NO whitespace when it is delimited (`CREATE TABLE"x"`,
// `CREATE TABLE[t]`). It also lets any table/trigger name carry a schema qualifier (`main.events`,
// `"main".events`). The lint must see through all of that or an append-only mutation slips by.
const QOPEN = `["'\`\\[]`; // an opening quote/backtick/bracket
const Q = `${QOPEN}?`; // optional opening quote/backtick/bracket before an identifier
const QCLOSE = `["'\`\\]]?`; // optional closing quote/backtick/bracket after an identifier
// Optional SQLite schema qualifier before a guarded identifier: main. / "main". / [main]. / `main`.
// We always capture the UNQUALIFIED tail so `DROP TRIGGER main.events_guard_del` reads as the guard,
// not as the schema "main". Whitespace is allowed around the dot.
const SCHEMA = `(?:${Q}\\w+${QCLOSE}\\s*\\.\\s*)?`;
// After a keyword (TABLE / TRIGGER / verb) a name may follow whitespace OR abut a quote/bracket with
// none (the zero-width lookahead), so `CREATE TABLE[t22]` counts and `DELETE FROM[events]` is caught.
const DELIM = `(?:\\s+|(?=${QOPEN}))`;

// ---- shared target matchers (share-lint) --------------------------------------------------------------
// ONE builder both the migration surface AND the TS-source surface consume, so the two scanners can never
// drift on delimiter/schema forms (the classic `INTO"events"` / `INTO main.events` bypasses). A parity test
// (invariants.test.ts) feeds ONE evasion corpus through every scanner. Callers pass an alternation of
// table names ("events|positions|money_lines" or "legs"); `gi` so matchAll can sweep a whole file/statement.
const replaceFamilyRe = (tables: string): RegExp =>
  new RegExp(`\\b(INSERT\\s+OR\\s+REPLACE\\s+INTO|REPLACE\\s+INTO)${DELIM}${SCHEMA}${Q}(${tables})\\b`, "gi");

/**
 * ANY `INSERT [OR …] INTO <table>` — delimiter- and schema-tolerant, built from the same fragments as the
 * matchers above. Exported for `tools/checks/append-chokepoint.ts` (REQ-030), which must see every write to
 * `events` wherever it appears.
 *
 * Shared rather than copied for the reason this whole section exists (audit §71): the chokepoint lint
 * shipped in §56 with a hand-written `INTO\s+…`, which the abutting-quote form `INSERT INTO"events"` walked
 * straight past — the EXACT blind spot the `share-lint-matchers-with-parity-tests` skill documents, and the
 * one the legs corpus already tests for. A second hand-rolled copy of a matcher is a second thing to get
 * wrong, and the copy nobody re-reads is the one an evasion goes through.
 */
export const insertIntoRe = (tables: string): RegExp =>
  new RegExp(`\\bINSERT\\s+(?:OR\\s+(?:ROLLBACK|ABORT|FAIL|IGNORE|REPLACE)\\s+)?INTO${DELIM}${SCHEMA}${Q}(${tables})\\b`, "gi");
const onConflictUpdateRe = (tables: string): RegExp =>
  new RegExp(`\\bINSERT\\s+(?:OR\\s+(?:ROLLBACK|ABORT|FAIL|IGNORE|REPLACE)\\s+)?INTO${DELIM}${SCHEMA}${Q}(${tables})\\b[^;]*?\\bON\\s+CONFLICT\\b[^;]*?\\bDO\\s+UPDATE\\b`, "gi");

export type InvariantResult = { ok: boolean; tableCount: number; violations: string[]; warnings: string[] };

// ---- guard-completeness (Task 5, REQ-002/011) --------------------------------------------------------
// A BEFORE INSERT guard only closes the recursive_triggers=0 REPLACE hole for the UNIQUE keys its WHEN
// clause actually enumerates. Any UNIQUE column / UNIQUE(...) constraint / PRIMARY KEY / CREATE UNIQUE
// INDEX on a guarded table that NO guard-ins predicate covers is an open door — an INSERT OR REPLACE
// colliding there deletes the chained victim row while the guard stays silent. Below: extract every
// unique target's column-set, extract every guard-ins disjunct's equality column-set, require each
// target to be enumerated (exact set match) by some disjunct.

// Normalize an identifier: drop a wrapping quote/backtick/bracket, lowercase.
function normIdent(s: string): string {
  return s.trim().replace(/^["'`[]/, "").replace(/["'`\]]$/, "").toLowerCase();
}
// A comma-separated column list → the leading identifier of each entry (drops ASC/DESC/COLLATE tails).
function colList(list: string): string[] {
  return list.split(",").map((c) => normIdent(c.trim().split(/\s+/)[0] ?? "")).filter(Boolean);
}
// The parenthesized body of `CREATE TABLE <table> ( ... )`, via string-aware balanced-paren matching so a
// string literal or a nested CHECK(... IN (...)) cannot throw the depth count off.
function tableBody(clean: string, table: string): string | null {
  const re = new RegExp(`CREATE\\s+TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?${DELIM}${SCHEMA}${Q}${table}${QCLOSE}\\s*\\(`, "i");
  const m = re.exec(clean);
  if (!m) return null;
  let depth = 1;
  const start = m.index + m[0].length;
  let i = start;
  while (i < clean.length && depth > 0) {
    const ch = clean.charAt(i);
    if (ch === "'") { i += 1; while (i < clean.length && clean.charAt(i) !== "'") i += 1; }
    else if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    i += 1;
  }
  return clean.slice(start, i - 1);
}
// Split a table body / clause on top-level commas — respecting parens and single-quoted strings.
function splitTopLevel(body: string, sep: "," | "or"): string[] {
  const parts: string[] = [];
  let depth = 0;
  let buf = "";
  let i = 0;
  while (i < body.length) {
    const ch = body.charAt(i);
    if (ch === "'") { buf += ch; i += 1; while (i < body.length) { buf += body.charAt(i); if (body.charAt(i) === "'") { i += 1; break; } i += 1; } continue; }
    if (ch === "(") { depth += 1; buf += ch; i += 1; continue; }
    if (ch === ")") { depth -= 1; buf += ch; i += 1; continue; }
    if (depth === 0 && sep === "," && ch === ",") { parts.push(buf); buf = ""; i += 1; continue; }
    if (depth === 0 && sep === "or" && (ch === "O" || ch === "o") && /r/i.test(body.charAt(i + 1))) {
      const before = i === 0 ? " " : body.charAt(i - 1);
      const after = i + 2 >= body.length ? " " : body.charAt(i + 2);
      if (!/\w/.test(before) && !/\w/.test(after)) { parts.push(buf); buf = ""; i += 2; continue; }
    }
    buf += ch;
    i += 1;
  }
  parts.push(buf);
  return parts;
}
// Every UNIQUE target on a guarded table, each as a sorted column-set: table-level PRIMARY KEY / UNIQUE(...),
// column-level PRIMARY KEY / UNIQUE, and every CREATE UNIQUE INDEX ... ON <table> (...).
function uniqueTargets(clean: string, table: string): string[][] {
  const targets: string[][] = [];
  const body = tableBody(clean, table);
  if (body) {
    for (const raw of splitTopLevel(body, ",")) {
      const item = raw.trim();
      let mm: RegExpExecArray | null;
      if ((mm = /^PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(item))) targets.push(colList(mm[1] ?? ""));
      else if ((mm = /^UNIQUE\s*\(([^)]*)\)/i.exec(item))) targets.push(colList(mm[1] ?? ""));
      else if (/^(?:CONSTRAINT\b|CHECK\b|FOREIGN\s+KEY\b|PRIMARY\s+KEY\b|UNIQUE\b)/i.test(item)) {
        // a table-level constraint form other than the two handled above — no column target to add
      } else {
        // a column definition: `<name> <type> [constraints…]`
        const first = item.split(/\s+/)[0] ?? "";
        const name = normIdent(first);
        if (!name) continue;
        const rest = item.slice(first.length);
        if (/\bPRIMARY\s+KEY\b/i.test(rest) || /\bUNIQUE\b/i.test(rest)) targets.push([name]);
      }
    }
  }
  const idxRe = new RegExp(
    `CREATE\\s+UNIQUE\\s+INDEX(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+${SCHEMA}${Q}\\w+${QCLOSE}\\s+ON${DELIM}${SCHEMA}${Q}${table}${QCLOSE}\\s*\\(([^)]*)\\)`,
    "gi",
  );
  for (const m of clean.matchAll(idxRe)) targets.push(colList(m[1] ?? ""));
  return targets;
}
// Every BEFORE INSERT guard on a guarded table, decomposed into its OR-disjuncts, each disjunct as the set
// of columns it compares for EQUALITY against NEW.* (a `col = NEW.col`). Non-equality refinements
// (`hash <> NEW.hash`, `NEW.x IS NOT NULL`, json_type(...)) contribute no column and are ignored.
function guardPredicateSets(clean: string, table: string): Set<string>[] {
  const sets: Set<string>[] = [];
  const re = new RegExp(
    `CREATE\\s+TRIGGER\\s+${SCHEMA}${Q}\\w+${QCLOSE}\\s+BEFORE\\s+INSERT\\s+ON${DELIM}${SCHEMA}${Q}${table}${QCLOSE}\\s+WHEN\\s+EXISTS\\s*\\(\\s*SELECT[\\s\\S]*?\\bWHERE\\b([\\s\\S]*?)\\)\\s*BEGIN`,
    "gi",
  );
  for (const m of clean.matchAll(re)) {
    for (const disj of splitTopLevel(m[1] ?? "", "or")) {
      const set = new Set<string>();
      for (const eq of disj.matchAll(/(\w+)\s*=\s*NEW\.\w+/gi)) {
        // Group 1 always participates when the pattern matches; narrowed rather than defaulted so a
        // hypothetical miss can never seed the set with an empty column name.
        const col = eq[1];
        if (col !== undefined) set.add(col.toLowerCase());
      }
      if (set.size > 0) sets.push(set);
    }
  }
  return sets;
}
function checkGuardCompleteness(clean: string, tables: ReadonlySet<string>): string[] {
  const violations: string[] = [];
  for (const t of GUARDED_TABLES) {
    if (!tables.has(t)) continue;
    const guardSets = guardPredicateSets(clean, t);
    for (const target of uniqueTargets(clean, t)) {
      if (target.length === 0) continue;
      const want = new Set(target);
      const covered = guardSets.some((s) => s.size === want.size && [...want].every((c) => s.has(c)));
      if (!covered) {
        violations.push(
          `I3 VIOLATION: append-only guard completeness — the UNIQUE target (${target.join(", ")}) on ${t} has no BEFORE INSERT guard predicate enumerating it; ` +
            `an INSERT OR REPLACE colliding on it would silently delete a chained row (D1 recursive_triggers=0). Add it to a *_guard_ins WHEN clause.`,
        );
      }
    }
  }
  return violations;
}

export function checkMigrationSql(sqlFiles: string[]): InvariantResult {
  const violations: string[] = [];
  const warnings: string[] = [];
  const tables = new Set<string>();
  // Scan comment-free SQL: commented-out DDL must never satisfy a presence check,
  // and a real mutation must never hide behind a `--`/`/* */` marker.
  const clean = stripSqlComments(sqlFiles.join("\n"));

  for (const m of clean.matchAll(new RegExp(`CREATE\\s+TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?${DELIM}${SCHEMA}${Q}(\\w+)`, "gi"))) {
    const name = m[1];
    if (name) tables.add(name.toLowerCase());
  }
  let effective = tables.size;
  for (const [part, parent] of Object.entries(PARTITION_TABLES)) {
    if (tables.has(part) && tables.has(parent)) effective -= 1; // partition shares the parent's entry
  }
  if (effective > TABLE_BUDGET) {
    violations.push(
      `I8 VIOLATION: ${effective} effective tables > budget ${TABLE_BUDGET}. A 22nd+ table requires a register amendment + written deletion.`,
    );
  } else if (effective > NAMED_TABLES) {
    warnings.push(`I8: spare table slot spent (${effective}/${TABLE_BUDGET}). This requires a written deletion note in the register.`);
  }

  // I3/I1: direct mutation of append-only tables — migrations may only CREATE/INDEX them.
  // REPLACE / INSERT OR REPLACE are delete+insert in disguise (and dodge BEFORE DELETE
  // guards unless recursive_triggers is on), so they are forbidden verbs too. ALTER TABLE is
  // handled SEPARATELY below — a NULLABLE `ADD COLUMN` is the one sanctioned exception.
  const mutate = new RegExp(
    `\\b(UPDATE|DELETE\\s+FROM|DROP\\s+TABLE|INSERT\\s+OR\\s+REPLACE\\s+INTO|REPLACE\\s+INTO)${DELIM}${SCHEMA}${Q}(events|positions|money_lines)\\b`,
    "gi",
  );
  for (const m of clean.matchAll(mutate)) {
    violations.push(`I3 VIOLATION: migrations may only CREATE/INDEX ${m[2]} — found "${m[1]}". Corrections are new events.`);
  }
  // ALTER TABLE on a guarded table: the ONE sanctioned form is a NULLABLE `ADD COLUMN`
  // (owner-approved, WP-05). RATIONALE: append-only (CLAUDE.md Law 2) bans UPDATE/DELETE of
  // existing event DATA; a nullable `ADD COLUMN` is SQLite metadata-only — it never rewrites or
  // deletes an existing row (old rows read the new column as NULL) — and is neither an UPDATE nor
  // a DELETE. Permitting ONLY it therefore ALIGNS the lint with Law 2 rather than weakening it.
  // Everything else stays a violation: DROP/RENAME COLUMN, RENAME TABLE, a NOT NULL or DEFAULT
  // column (which WOULD write into existing rows), and any other ALTER. `${QCLOSE}` after the `\b`
  // consumes a closing quote/bracket so the captured TAIL is exactly what follows the table name.
  const alterGuarded = new RegExp(
    `\\bALTER\\s+TABLE${DELIM}${SCHEMA}${Q}(events|positions|money_lines)\\b${QCLOSE}([^;]*)`,
    "gi",
  );
  // STRICT tables allow only TEXT/INTEGER/INT/REAL/BLOB/ANY; a bare nullable column is
  // `ADD [COLUMN] <name> <type>` with NOTHING after the type (no NOT NULL/DEFAULT/constraint).
  const nullableAddColumn = new RegExp(
    `^\\s+ADD\\s+(?:COLUMN\\s+)?${Q}\\w+${QCLOSE}\\s+(?:TEXT|INTEGER|INT|REAL|BLOB|ANY)\\s*$`,
    "i",
  );
  for (const m of clean.matchAll(alterGuarded)) {
    const tail = m[2] ?? "";
    if (!nullableAddColumn.test(tail)) {
      violations.push(
        `I3 VIOLATION: ALTER TABLE ${m[1]} may only ADD a NULLABLE COLUMN (no NOT NULL/DEFAULT, no DROP/RENAME/other ALTER) — ` +
          `append-only forbids editing existing event data. Found "ALTER TABLE ${m[1]}${tail.slice(0, 50)}".`,
      );
    }
  }
  // An upsert (INSERT ... ON CONFLICT ... DO UPDATE) IS a mutation of the target row — its verb is
  // UPDATE but it does not abut the table name, so the mutate matcher above cannot see it. Scan within
  // a single statement ([^;]*?) so a later legitimate upsert on a non-guarded table (e.g. invoices)
  // can never be spliced onto an earlier INSERT INTO events.
  const upsert = new RegExp(
    `\\bINSERT\\s+(?:OR\\s+(?:ROLLBACK|ABORT|FAIL|IGNORE|REPLACE)\\s+)?INTO${DELIM}${SCHEMA}${Q}(events|positions|money_lines)\\b[^;]*?\\bON\\s+CONFLICT\\b[^;]*?\\bDO\\s+UPDATE\\b`,
    "gi",
  );
  for (const m of clean.matchAll(upsert)) {
    violations.push(`I3 VIOLATION: upsert (ON CONFLICT DO UPDATE) on ${m[1]} rewrites a row — ${m[1]} is append-only. Corrections are new events.`);
  }
  // REQ-028/052 — `legs` is a MUTABLE table (a plain UPDATE/DELETE is a legal domain write, so it is NOT in
  // GUARDED_TABLES), but a REPLACE-family write or an upsert would DELETE/rewrite the row THROUGH the
  // ux_legs_slot UNIQUE INDEX (silent dock-slot theft). Banned on BOTH surfaces via the shared builders; a
  // plain UPDATE (how appointment.set claims a slot) is allowed.
  for (const m of clean.matchAll(replaceFamilyRe("legs"))) {
    violations.push(`REQ-028/052 VIOLATION: "${m[1]} ... legs" deletes the leg row THROUGH ux_legs_slot (silent slot theft) — claim a slot with a plain UPDATE.`);
  }
  for (const _m of clean.matchAll(onConflictUpdateRe("legs"))) {
    violations.push(`REQ-028/052 VIOLATION: upsert (ON CONFLICT DO UPDATE) on legs rewrites the leg row through ux_legs_slot — claim a slot with a plain UPDATE.`);
  }
  // I3: a guard trigger can never be dropped — that silently disables append-only.
  for (const m of clean.matchAll(new RegExp(`\\bDROP\\s+TRIGGER\\s+(?:IF\\s+EXISTS\\s+)?${SCHEMA}${Q}([A-Za-z0-9_]+)`, "gi"))) {
    const name = (m[1] ?? "").toLowerCase();
    if (/_guard_/.test(name) || GUARDED_TABLES.some((t) => name === t || name.startsWith(`${t}_`))) {
      violations.push(`I3 VIOLATION: DROP TRIGGER ${m[1]} disables an append-only guard — guards are permanent.`);
    }
  }
  // Triggers on guarded tables: the body must be exactly one RAISE(ABORT) statement.
  const triggerBody = new RegExp(`CREATE\\s+TRIGGER\\s+${SCHEMA}${Q}[\\w"'\`\\]]+[\\s\\S]*?\\bON\\s+${SCHEMA}${Q}(events|positions|money_lines)\\b[\\s\\S]*?\\bBEGIN\\b([\\s\\S]*?)\\bEND\\s*;`, "gi");
  for (const m of clean.matchAll(triggerBody)) {
    const body = (m[2] ?? "").trim();
    if (!/^SELECT\s+RAISE\s*\(\s*ABORT\b[^;]*;$/i.test(body)) {
      violations.push(`I3 VIOLATION: trigger on ${m[1]} may only RAISE(ABORT) — found "${body.slice(0, 60)}"`);
    }
  }
  // Guards are mandatory AND must have the correct timing — a name-only match let an
  // AFTER-INSERT (or commented-out) "guard" pass while the table stayed mutable.
  // BEFORE INSERT is mandatory too: D1 runs recursive_triggers=0, so INSERT OR REPLACE's
  // implicit DELETE never fires the BEFORE DELETE guard — only a BEFORE INSERT guard (which
  // fires while the old row still exists) closes that history-rewrite hole.
  const guardSpecs = [
    { suffix: "guard_upd", event: "UPDATE" },
    { suffix: "guard_del", event: "DELETE" },
    { suffix: "guard_ins", event: "INSERT" },
  ] as const;
  for (const t of GUARDED_TABLES) {
    if (!tables.has(t)) continue;
    for (const { suffix, event } of guardSpecs) {
      const re = new RegExp(`CREATE\\s+TRIGGER\\s+${SCHEMA}${Q}${t}_${suffix}\\b[\\s\\S]*?\\bBEFORE\\s+${event}\\s+ON\\s+${SCHEMA}${Q}${t}\\b`, "i");
      if (!re.test(clean)) {
        violations.push(`I3 VIOLATION: missing guard trigger ${t}_${suffix} (must be BEFORE ${event} ON ${t})`);
      }
    }
  }
  // Completeness: a guard-ins is only as good as the UNIQUE keys its WHEN clause enumerates. Every UNIQUE
  // target on a guarded table must be covered, or an INSERT OR REPLACE colliding on the uncovered key
  // silently deletes a chained row (recursive_triggers=0). A new unique target without coverage fails here.
  violations.push(...checkGuardCompleteness(clean, tables));
  return { ok: violations.length === 0, tableCount: effective, violations, warnings };
}

// Forward-only migration lock. A merged migration file is immutable; its SHA-256 is pinned in
// db/migrations.lock.json. The true forward-only anchor is the lock AS COMMITTED IN GIT (`committed`,
// read from `git show HEAD:...`), NOT just the on-disk lock — otherwise the bypass is: delete a merged
// migration's lock line, edit the file, `pnpm db:lock`; the deleted key reads as a brand-new file so
// write re-pins the EDITED digest and CI check then passes. Anchoring against HEAD kills that: a path
// HEAD ever pinned can NEVER be re-pinned to a different digest, whether or not its on-disk key is
// currently present. `check` (CI) never writes and fails on any divergence OR any unpinned migration.
export type LockMode = "check" | "write";
export function checkLock(
  entries: ReadonlyArray<{ path: string; digest: string }>,
  lock: Readonly<Record<string, string>>,
  mode: LockMode,
  committed: Readonly<Record<string, string>> = {},
): { ok: boolean; errors: string[]; nextLock: Record<string, string> } {
  const errors: string[] = [];
  const nextLock: Record<string, string> = {};
  for (const { path, digest } of entries) {
    const wasCommitted = committed[path]; // the git-HEAD pin — survives a locally-deleted lock line
    if (wasCommitted !== undefined && wasCommitted !== digest) {
      // Append-only: a path, once committed to the lock, cannot change digest — in EITHER mode, and
      // even if its on-disk lock line was deleted. Migrations are forward-only; add a new file.
      errors.push(`migration ${path} was EDITED after it was committed to the lock — migrations are forward-only; add a new file (deleting its lock line does not reset this).`);
      nextLock[path] = wasCommitted; // never let --write overwrite HEAD's pin with the edited digest
      continue;
    }
    const pinned = lock[path];
    if (pinned === undefined) {
      if (mode === "check") errors.push(`migration ${path} is not pinned in db/migrations.lock.json — run \`pnpm db:lock\` (forward-only).`);
    } else if (pinned !== digest) {
      errors.push(`migration ${path} was EDITED after lock — migrations are forward-only; add a new file.`);
    }
    nextLock[path] = digest;
  }
  return { ok: errors.length === 0, errors, nextLock };
}

// A .sql file is a stray (evades the I3/I8 lint) unless it is a real migration file,
// a fixture, or vendored. Only db/**/migrations/*.sql is exempt under db/ — a file
// like db/tenant/seed.sql is scanned by neither glob otherwise, so it is a stray.
export function isStraySql(path: string, migrations: ReadonlySet<string>): boolean {
  // node_modules + fixtures are vendored; `.claude/` is skills/governance prose (a skill may carry a
  // reference/example .sql), excluded exactly as the traceability scan + eslint exclude it — it is not
  // product schema. Everything else outside db/*/migrations is a real stray (an I3/I8 evasion).
  if (path.includes("node_modules") || path.startsWith("fixtures/") || path.startsWith(".claude/")) return false;
  return !migrations.has(path);
}

// The stray fence, exactly as main() runs it. globSync passes `exclude` the BASENAME
// for leaf files (and partial paths for directories), so the migration-membership test
// cannot live in `exclude` — it would flag every real migration as stray. `exclude`
// only prunes the node_modules tree (a directory-name test, safe on any arg shape); the
// real decision runs on the RESULT array, whose entries are full, cwd-relative paths.
export function findStraySql(cwd: string = process.cwd()): string[] {
  const migrations = new Set(globSync("db/**/migrations/*.sql", { cwd }));
  // GIT-AWARE scan: the fence catches a PRODUCT `.sql` sneaking outside `db/*/migrations` (an I3/I8 evasion).
  // A git-IGNORED path (`.gitignore` / `.git/info/exclude` — e.g. a separate untracked sibling project that
  // shares the repo dir) is explicitly NOT the product, so it must not trip the product invariant. `git
  // ls-files --cached --others --exclude-standard` lists tracked + untracked-but-NOT-ignored files, applying
  // every git ignore rule — so a genuinely-strayed uncommitted product `.sql` is still caught, while an
  // ignored sibling's SQL is skipped. Fall back to the filesystem glob outside a git repo.
  let candidates: string[];
  try {
    candidates = execSync("git ls-files --cached --others --exclude-standard -z -- '*.sql'", { cwd, encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
  } catch {
    candidates = globSync("**/*.sql", { cwd, exclude: (p) => p.includes("node_modules") });
  }
  return candidates.filter((p) => isStraySql(p, migrations));
}

// Defense in depth (D1 runs recursive_triggers=0): application code must never issue a REPLACE
// against a guarded table. REPLACE's implicit row-DELETE skips the BEFORE DELETE guard, so it
// could rewrite history that the DB-level BEFORE INSERT guard is meant to protect. Corrections
// are new events (I3/I1). This scans `src` trees ONLY — test files legitimately embed REPLACE
// probe SQL to prove the guards fire. Built from the SHARED replaceFamilyRe (same DELIM/SCHEMA/Q the
// migration scanner uses), so `INTO"events"` (abutting quote) and `INTO main.events` (schema-qualified)
// can no longer split the two surfaces — a parity test (invariants.test.ts) proves it.
const FORBIDDEN_REPLACE = (): RegExp => replaceFamilyRe("events|positions|money_lines");

export function scanSourceForForbiddenReplace(sources: ReadonlyArray<{ path: string; text: string }>): string[] {
  const violations: string[] = [];
  const GUARDED = "events|positions|money_lines";
  for (const { path, text } of sources) {
    for (const m of text.matchAll(FORBIDDEN_REPLACE())) {
      violations.push(
        `${path}: "${m[1]} ... ${m[2]}" — REPLACE bypasses the BEFORE DELETE guard (D1 recursive_triggers=0). Corrections are new events (I3/I1).`,
      );
    }
    // An upsert (INSERT ... ON CONFLICT DO UPDATE) IS a mutation of the guarded row — the migration scanner
    // already bans it; the source surface must too (share-lint parity: same rule, both surfaces).
    for (const m of text.matchAll(onConflictUpdateRe(GUARDED))) {
      violations.push(
        `${path}: "INSERT ... ON CONFLICT DO UPDATE ... ${m[1]}" — an upsert rewrites an append-only row. Corrections are new events (I3/I1).`,
      );
    }
  }
  return violations;
}

// REQ-028/052 — the `legs` sibling of the REPLACE ban. legs is MUTABLE (a plain UPDATE claims a dock slot),
// but a REPLACE-family write or an upsert deletes/rewrites the row THROUGH ux_legs_slot (silent slot theft),
// so those are forbidden in application source too. Same shared builders as the migration surface.
export function scanSourceForLegsReplace(sources: ReadonlyArray<{ path: string; text: string }>): string[] {
  const violations: string[] = [];
  for (const { path, text } of sources) {
    for (const m of text.matchAll(replaceFamilyRe("legs"))) {
      violations.push(`${path}: "${m[1]} ... legs" — REPLACE on legs deletes through ux_legs_slot (silent slot theft). Claim a slot with a plain UPDATE (REQ-028/052).`);
    }
    for (const _m of text.matchAll(onConflictUpdateRe("legs"))) {
      violations.push(`${path}: "INSERT ... ON CONFLICT DO UPDATE ... legs" — an upsert rewrites the leg row through ux_legs_slot. Claim a slot with a plain UPDATE (REQ-028/052).`);
    }
  }
  return violations;
}

export function findForbiddenReplaceSources(cwd: string = process.cwd()): string[] {
  // Audit §120: this scanned packages + workers, .ts only — so 4 of 6 (tree x extension) cells were blind.
  // check:chokepoint already scanned apps/ for the same class of violation; the two gates guard I3 together
  // and disagreed about where it could live. An INSERT OR REPLACE on an append-only table is forbidden
  // wherever it is written, so the glob set now matches the corpus rather than a subset of it.
  const files = [
    ...globSync("packages/*/src/**/*.ts", { cwd }),
    ...globSync("packages/*/src/**/*.tsx", { cwd }),
    ...globSync("workers/*/src/**/*.ts", { cwd }),
    ...globSync("workers/*/src/**/*.tsx", { cwd }),
    ...globSync("apps/*/src/**/*.ts", { cwd }),
    ...globSync("apps/*/src/**/*.tsx", { cwd }),
  ];
  const texts = files.map((p) => ({ path: p, text: readFileSync(join(cwd, p), "utf8") }));
  return [...scanSourceForForbiddenReplace(texts), ...scanSourceForLegsReplace(texts)];
}

// The migration lock as committed in git HEAD — the forward-only anchor `checkLock` compares against.
// `git show HEAD:<path>` reads the path relative to the repo root (independent of cwd). Any failure
// (no HEAD lockfile yet, detached/empty tree, not a git checkout) means "nothing pinned" → {}.
function committedLock(lockPath: string): Record<string, string> {
  try {
    const raw = execFileSync("git", ["show", `HEAD:${lockPath}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

// TEST SCHEMA PARITY (audit §239) — every worker test helper must apply EVERY shipped tenant migration.
// Each helper hand-maintains its own `TENANT_MIGRATIONS` array, so the list is duplicated once per worker
// and drifts silently: measured at `bb9de63`, all four had fallen behind — `workers/api` omitted 0008 and
// the other three omitted 0005, 0006 AND 0008. A suite running on a SUBSET of the shipped schema proves
// nothing about the schema the code will actually meet; 0008 in particular installs the I3/I1 append-only
// completeness triggers (duplicate `hash`, duplicate device slot), so the worker that owns the sequencer
// was testing its append path with those guards absent. Nothing failed when they were added — the fix was
// free — which is exactly why the drift was invisible. The migration LOCK pins the files; this pins that
// the tests actually apply them.
export function checkTestSchemaParity(
  tenantMigrations: readonly string[],
  helpers: ReadonlyArray<{ path: string; source: string }>,
): string[] {
  const violations: string[] = [];
  const names = tenantMigrations.map((p) => p.split("/").pop()!).sort();
  for (const { path, source } of helpers) {
    // Checks ONE half: that the migration appears as an entry in the APPLIED array. The other half — that
    // the imported SQL binding exists — belongs to the compiler and was measured, not assumed: deleting the
    // `import uniqueGuards …` line while leaving its array entry gives `TS2304: Cannot find name
    // 'uniqueGuards'` (typecheck exit 2; exit 0 once restored). A source-text check cannot add anything
    // there, and pretending to would only make this gate's green certify more than it verifies — so the
    // division is deliberate: the compiler owns the binding, this owns the list.
    const missing = names.filter((n) => !new RegExp(`path:\\s*["']${n.replace(/\./g, "\\.")}["']`).test(source));
    if (missing.length > 0) {
      violations.push(`${path} does not apply shipped tenant migration(s): ${missing.join(", ")} — a test schema that is a SUBSET of the shipped schema cannot observe a violation of what it omits (audit §239).`);
    }
  }
  return violations;
}

// DO MUTEX INTEGRITY (audit §244, closing §235's open end). Every Durable Object in this repo serializes
// its critical section by chaining onto the previous call's settlement. §235 MEASURED what happens when
// that chain is deleted: `workers/agents` stays 110/110 green and `workers/mcp` stays 177/177 green,
// because a storage-only critical section is already serialized by the DO input gate — so the chain is
// defence for the day any non-storage await (a D1 read, a fetch, a queue send) enters the method, and with
// the gate so opened the caps bypass completely (10 admitted against an allotment of 3). §235 had to end
// with a comment asking future maintainers not to "simplify" it away, and the honest admission that CI
// could not back that up. This is CI backing it up.
//
// Keyed on an explicit ROSTER, not on the guard's own text: a filter that keys on `private lock` stops
// covering the file the moment someone deletes `private lock`, which is precisely the deletion it exists to
// catch (§239 shipped that exact hole and had to be re-keyed). The roster is then checked AGAINST the
// discovered set, so a fourth DO cannot appear uncovered.
export const DO_MUTEX_ROSTER = ["ShipmentSequencer", "SparkMeter", "CapsMeter"] as const;

export function checkDoMutexIntact(files: ReadonlyArray<{ path: string; source: string }>): string[] {
  const violations: string[] = [];
  const declared = new Set<string>();
  for (const { path, source } of files) {
    for (const m of source.matchAll(/export class (\w+) extends DurableObject/g)) declared.add(m[1]!);
    for (const cls of DO_MUTEX_ROSTER) {
      if (!new RegExp(`export class ${cls} extends DurableObject`).test(source)) continue;
      // All three limbs, or the chain is broken: the field, the chain-on, and the poison-proof re-arm.
      const hasField = /private lock: Promise<unknown> = Promise\.resolve\(\)/.test(source);
      const hasChain = /const run = this\.lock\.then\(\(\) =>/.test(source);
      const hasRearm = /this\.lock = run\.catch\(\(\) => undefined\)/.test(source);
      if (!hasField || !hasChain || !hasRearm) {
        const missing = [!hasField && "the `private lock` field", !hasChain && "the `this.lock.then(...)` chain", !hasRearm && "the `this.lock = run.catch(...)` re-arm"].filter(Boolean).join(", ");
        violations.push(`${path}: ${cls} is missing ${missing} — the DO serialization mutex. Deleting it is SILENT in that worker's suite (§235 measured 110/110 and 177/177 still green) because the input gate already serializes a storage-only critical section; it becomes a cap bypass the moment any non-storage await enters. If you are deliberately removing it, remove this roster entry and say why.`);
      }
    }
  }
  // The roster must equal the discovered set — a NEW DurableObject cannot arrive uncovered.
  for (const cls of declared) {
    if (!(DO_MUTEX_ROSTER as readonly string[]).includes(cls)) {
      violations.push(`a DurableObject "${cls}" is not in DO_MUTEX_ROSTER (tools/checks/invariants.ts) — every DO in this repo serializes its critical section; add it to the roster (and give it the mutex), or record why it needs none (audit §244).`);
    }
  }
  return violations;
}

// CONTROL-PLANE MIGRATION COVERAGE (audit §244, closing §243's restart trigger 2). The tenant rule is
// "every helper applies every migration" (checkTestSchemaParity). Control migrations are different in kind
// — 0002 and 0003 are DATA seeds (the platform tenant, the pool sentinels) that only the suites exercising
// provisioning want — so requiring every helper to apply them would be wrong. The real requirement is
// weaker and is what §240 verified by hand: each one is applied by AT LEAST ONE test file, importing the
// real shipped SQL rather than hand-copying its rows. That held when measured; nothing pinned it, so a
// FOURTH control migration could land with no test applying it and §240's verdict would silently expire.
export function checkControlMigrationsExercised(
  controlMigrations: readonly string[],
  testSources: ReadonlyArray<{ path: string; source: string }>,
): string[] {
  const violations: string[] = [];
  for (const migration of controlMigrations) {
    const name = migration.split("/").pop()!;
    const exercised = testSources.some((t) => t.source.includes(`db/control/migrations/${name}`));
    if (!exercised) {
      violations.push(`control migration ${name} is applied by NO test file — it ships to production but nothing exercises the state it creates (audit §244). Import it in the suite that needs it, as signup.test.ts / provision.test.ts do for 0002 and 0003.`);
    }
  }
  return violations;
}

// THE SURFACE BUDGET (audit §245). CLAUDE.md heads its budget list "Hard budgets (CI-enforced; exceeding =
// the PR is wrong)" and names "3 surfaces"; it separately lists "a fourth surface" under Do-not-build-ever
// without a register amendment. Six of the seven budgets had an executable pin — ≤22 tables
// (checkMigrationSql), 12 canonical views (assertViewBudget + registry.test), 35 event kinds (two contract
// tests), 5 colour tokens and 2 font families (design/test/tokens), 0 shadows/gradients/radius>4px
// (audit:design). The surface count had none: `check:surfaces` governs wrangler DEPLOY targets, not how many
// apps exist, so a fourth surface would pass every gate in the repo. Either the doc's "CI-enforced" was
// wrong or the gate was missing; this is the gate.
//
// A surface = a directory under apps/ carrying a package.json (a deployable app), not any directory.
// Roster-keyed and checked BOTH directions, per §244: a fourth app fails, and so does deleting one, because
// either is a register-amendment decision rather than an edit.
export const SURFACE_ROSTER = ["command", "driver", "portal"] as const;

export function checkSurfaceBudget(discovered: readonly string[]): string[] {
  const found = [...discovered].sort();
  const expected = [...SURFACE_ROSTER].sort();
  if (found.length === expected.length && found.every((s, i) => s === expected[i])) return [];
  const extra = found.filter((s) => !(SURFACE_ROSTER as readonly string[]).includes(s));
  const missing = expected.filter((s) => !found.includes(s));
  const parts = [
    extra.length > 0 ? `UNREGISTERED surface(s): ${extra.join(", ")} — CLAUDE.md forbids a fourth surface without a register amendment signed by the owner` : "",
    missing.length > 0 ? `MISSING surface(s): ${missing.join(", ")} — removing one is also a register decision, not an edit` : "",
  ].filter(Boolean);
  return [`surface budget (3 surfaces, CLAUDE.md hard budgets): ${parts.join("; ")} (audit §245)`];
}

function main(): void {
  const mode: LockMode = process.argv.includes("--write") ? "write" : "check";
  const migrations = globSync("db/**/migrations/*.sql");

  // Exactly the three registered surfaces ship (see checkSurfaceBudget). Guarded on `apps/` existing at
  // all: the CLI's own end-to-end tests run it inside a temp fixture repo that has no apps/, and an
  // unguarded check reads that as "all three surfaces missing" and exits 1 — which is precisely what the
  // "positive control (was exit 1 under the bug)" test caught when this landed. A tree with no apps/ is not
  // a SHUDDL checkout, not a violation; deleting apps/ wholesale is still caught by the roster-identity
  // test, which resolves against the real repo root rather than the cwd.
  if (existsSync("apps")) {
    const surfaceViolations = checkSurfaceBudget(
      globSync("apps/*/package.json").map((p) => p.split("/")[1]!),
    );
    if (surfaceViolations.length > 0) {
      for (const v of surfaceViolations) console.error(`FAIL ${v}`);
      process.exit(1);
    }
  }

  // Every shipped control-plane migration is exercised by at least one test (see above).
  const controlViolations = checkControlMigrationsExercised(
    globSync("db/control/migrations/*.sql"),
    globSync("workers/*/test/**/*.ts").map((p) => ({ path: p, source: readFileSync(p, "utf8") })),
  );
  if (controlViolations.length > 0) {
    for (const v of controlViolations) console.error(`FAIL ${v}`);
    process.exit(1);
  }

  // Every tenant table is classified append-only or mutable (see checkTableClassification).
  const created: string[] = [];
  for (const f of globSync("db/tenant/migrations/*.sql")) {
    for (const m of readFileSync(f, "utf8").matchAll(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+["'`\[]?([a-z_]+)/gi)) {
      created.push(m[1]!.toLowerCase());
    }
  }
  const classViolations = checkTableClassification(created);
  if (classViolations.length > 0) {
    for (const v of classViolations) console.error(`FAIL ${v}`);
    process.exit(1);
  }

  // Every Durable Object still holds its serialization mutex (see checkDoMutexIntact).
  const doViolations = checkDoMutexIntact(
    globSync("workers/*/src/**/*.ts").map((p) => ({ path: p, source: readFileSync(p, "utf8") })),
  );
  if (doViolations.length > 0) {
    for (const v of doViolations) console.error(`FAIL ${v}`);
    process.exit(1);
  }

  // The test schema must equal the shipped schema (see checkTestSchemaParity).
  const tenantMigrations = globSync("db/tenant/migrations/*.sql");
  const helperPaths = globSync("workers/*/test/helpers.ts");
  const parityViolations = checkTestSchemaParity(
    tenantMigrations,
    helperPaths
      .map((p) => ({ path: p, source: readFileSync(p, "utf8") }))
      // In scope = any helper that stands up a tenant schema, detected by an import FROM the tenant
      // migrations directory. Keyed on that rather than on the array's NAME: the first cut of this filter
      // matched `TENANT_MIGRATIONS` and silently skipped `workers/agents` and `workers/translator`, which
      // call theirs `MIGRATIONS` — the gate covered two of four helpers and still printed OK. It was caught
      // only by mutating all four (audit §239); a single-instance probe would have blessed it.
      .filter((h) => h.source.includes("db/tenant/migrations/")),
  );
  if (parityViolations.length > 0) {
    for (const v of parityViolations) console.error(`FAIL ${v}`);
    process.exit(1);
  }
  const strays = findStraySql();
  if (strays.length > 0) {
    console.error(`FAIL stray SQL outside db/*/migrations (evades I3/I8 lint): ${strays.join(", ")}`);
    process.exit(1);
  }

  // Defense in depth: no application-source REPLACE against a guarded table (recursive_triggers=0).
  const replaceViolations = findForbiddenReplaceSources();
  if (replaceViolations.length > 0) {
    for (const v of replaceViolations) console.error(`FAIL ${v}`);
    process.exit(1);
  }

  // Invariants first — never pin (or, in check mode, never bless) a migration that fails I3/I8.
  const result = checkMigrationSql(migrations.map((f) => readFileSync(f, "utf8")));
  for (const w of result.warnings) console.warn(`WARN ${w}`);
  if (!result.ok) {
    for (const v of result.violations) console.error(`FAIL ${v}`);
    process.exit(1);
  }

  const lockPath = "db/migrations.lock.json";
  const lock = existsSync(lockPath) ? (JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, string>) : {};
  // The forward-only anchor: the lock as committed in git HEAD. A locally-deleted lock line cannot
  // reset it, so `--write` can never re-pin an edited migration. Missing/unparseable (first migration
  // ever, or not a git tree) degrades to no anchor — never a false failure.
  const committed = committedLock(lockPath);
  const entries = migrations.map((f) => ({ path: f, digest: createHash("sha256").update(readFileSync(f)).digest("hex") }));
  const lockResult = checkLock(entries, lock, mode, committed);
  if (!lockResult.ok) {
    for (const e of lockResult.errors) console.error(`FAIL ${e}`);
    process.exit(1);
  }
  if (mode === "write") writeFileSync(lockPath, JSON.stringify(lockResult.nextLock, null, 2) + "\n");

  console.log(`invariants OK — ${result.tableCount}/${TABLE_BUDGET} tables, events append-only (${migrations.length} migration files, lock: ${mode})`);
}

if (process.argv[1]?.endsWith("invariants.ts")) main();
