import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, globSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { stripSqlComments } from "@shuddl/ledger/migrate";

// I8 (doc 10): ≤22 tables — 21 named, the spare requires a written deletion (register note).
export const TABLE_BUDGET = 22;
const NAMED_TABLES = 21;

// Doc 10 entry 9: physical partitions sharing one budget entry with their parent.
// Expanding this map requires a register note (test pins its keys).
export const PARTITION_TABLES: Record<string, string> = { positions: "events" };

// Append-only tables that MUST carry RAISE(ABORT) guard triggers once created (I3, I1).
const GUARDED_TABLES = ["events", "positions", "money_lines"] as const;

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
const onConflictUpdateRe = (tables: string): RegExp =>
  new RegExp(`\\bINSERT\\s+(?:OR\\s+(?:ROLLBACK|ABORT|FAIL|IGNORE|REPLACE)\\s+)?INTO${DELIM}${SCHEMA}${Q}(${tables})\\b[^;]*?\\bON\\s+CONFLICT\\b[^;]*?\\bDO\\s+UPDATE\\b`, "gi");

export type InvariantResult = { ok: boolean; tableCount: number; violations: string[]; warnings: string[] };

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
  const files = [...globSync("packages/*/src/**/*.ts", { cwd }), ...globSync("workers/*/src/**/*.ts", { cwd })];
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

function main(): void {
  const mode: LockMode = process.argv.includes("--write") ? "write" : "check";
  const migrations = globSync("db/**/migrations/*.sql");
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
