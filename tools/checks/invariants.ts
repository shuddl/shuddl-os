import { createHash } from "node:crypto";
import { existsSync, globSync, readFileSync, writeFileSync } from "node:fs";
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

// Optional opening quote/bracket before an identifier (', ", `, [) — closes the
// evasion where `[events]` / `"events"` slipped past the bare-name matchers.
const Q = `["'\`\\[]?`;

export type InvariantResult = { ok: boolean; tableCount: number; violations: string[]; warnings: string[] };

export function checkMigrationSql(sqlFiles: string[]): InvariantResult {
  const violations: string[] = [];
  const warnings: string[] = [];
  const tables = new Set<string>();
  // Scan comment-free SQL: commented-out DDL must never satisfy a presence check,
  // and a real mutation must never hide behind a `--`/`/* */` marker.
  const clean = stripSqlComments(sqlFiles.join("\n"));

  for (const m of clean.matchAll(new RegExp(`CREATE TABLE(?: IF NOT EXISTS)?\\s+${Q}(\\w+)`, "gi"))) {
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
  // guards unless recursive_triggers is on), so they are forbidden verbs too.
  const mutate = new RegExp(
    `\\b(UPDATE|DELETE\\s+FROM|DROP\\s+TABLE|ALTER\\s+TABLE|INSERT\\s+OR\\s+REPLACE\\s+INTO|REPLACE\\s+INTO)\\s+${Q}(events|positions|money_lines)\\b`,
    "gi",
  );
  for (const m of clean.matchAll(mutate)) {
    violations.push(`I3 VIOLATION: migrations may only CREATE/INDEX ${m[2]} — found "${m[1]}". Corrections are new events.`);
  }
  // I3: a guard trigger can never be dropped — that silently disables append-only.
  for (const m of clean.matchAll(new RegExp(`\\bDROP\\s+TRIGGER\\s+(?:IF\\s+EXISTS\\s+)?${Q}([A-Za-z0-9_]+)`, "gi"))) {
    const name = (m[1] ?? "").toLowerCase();
    if (/_guard_/.test(name) || GUARDED_TABLES.some((t) => name === t || name.startsWith(`${t}_`))) {
      violations.push(`I3 VIOLATION: DROP TRIGGER ${m[1]} disables an append-only guard — guards are permanent.`);
    }
  }
  // Triggers on guarded tables: the body must be exactly one RAISE(ABORT) statement.
  const triggerBody = new RegExp(`CREATE\\s+TRIGGER\\s+[\\w"'\`]+[\\s\\S]*?\\bON\\s+${Q}(events|positions|money_lines)\\b[\\s\\S]*?\\bBEGIN\\b([\\s\\S]*?)\\bEND\\s*;`, "gi");
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
      const re = new RegExp(`CREATE\\s+TRIGGER\\s+${Q}${t}_${suffix}\\b[\\s\\S]*?\\bBEFORE\\s+${event}\\s+ON\\s+${Q}${t}\\b`, "i");
      if (!re.test(clean)) {
        violations.push(`I3 VIOLATION: missing guard trigger ${t}_${suffix} (must be BEFORE ${event} ON ${t})`);
      }
    }
  }
  return { ok: violations.length === 0, tableCount: effective, violations, warnings };
}

// Forward-only migration lock. A merged migration file is immutable; its SHA-256 is
// pinned in db/migrations.lock.json. `check` (CI) never writes and fails on any
// divergence OR any on-disk migration missing from the lock — so the "delete the key
// then let CI re-pin" bypass is dead. `write` (pnpm db:lock) pins NEW files only and
// still refuses to re-pin an edited one.
export type LockMode = "check" | "write";
export function checkLock(
  entries: ReadonlyArray<{ path: string; digest: string }>,
  lock: Readonly<Record<string, string>>,
  mode: LockMode,
): { ok: boolean; errors: string[]; nextLock: Record<string, string> } {
  const errors: string[] = [];
  const nextLock: Record<string, string> = {};
  for (const { path, digest } of entries) {
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
  if (path.includes("node_modules") || path.startsWith("fixtures/")) return false;
  return !migrations.has(path);
}

// The stray fence, exactly as main() runs it. globSync passes `exclude` the BASENAME
// for leaf files (and partial paths for directories), so the migration-membership test
// cannot live in `exclude` — it would flag every real migration as stray. `exclude`
// only prunes the node_modules tree (a directory-name test, safe on any arg shape); the
// real decision runs on the RESULT array, whose entries are full, cwd-relative paths.
export function findStraySql(cwd: string = process.cwd()): string[] {
  const migrations = new Set(globSync("db/**/migrations/*.sql", { cwd }));
  return globSync("**/*.sql", { cwd, exclude: (p) => p.includes("node_modules") }).filter((p) => isStraySql(p, migrations));
}

// Defense in depth (D1 runs recursive_triggers=0): application code must never issue a REPLACE
// against a guarded table. REPLACE's implicit row-DELETE skips the BEFORE DELETE guard, so it
// could rewrite history that the DB-level BEFORE INSERT guard is meant to protect. Corrections
// are new events (I3/I1). This scans `src` trees ONLY — test files legitimately embed REPLACE
// probe SQL to prove the guards fire.
const FORBIDDEN_REPLACE = /\b(INSERT\s+OR\s+REPLACE\s+INTO|REPLACE\s+INTO)\s+["'`[]?(events|positions|money_lines)\b/gi;

export function scanSourceForForbiddenReplace(sources: ReadonlyArray<{ path: string; text: string }>): string[] {
  const violations: string[] = [];
  for (const { path, text } of sources) {
    for (const m of text.matchAll(FORBIDDEN_REPLACE)) {
      violations.push(
        `${path}: "${m[1]} ... ${m[2]}" — REPLACE bypasses the BEFORE DELETE guard (D1 recursive_triggers=0). Corrections are new events (I3/I1).`,
      );
    }
  }
  return violations;
}

export function findForbiddenReplaceSources(cwd: string = process.cwd()): string[] {
  const files = [...globSync("packages/*/src/**/*.ts", { cwd }), ...globSync("workers/*/src/**/*.ts", { cwd })];
  return scanSourceForForbiddenReplace(files.map((p) => ({ path: p, text: readFileSync(join(cwd, p), "utf8") })));
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
  const entries = migrations.map((f) => ({ path: f, digest: createHash("sha256").update(readFileSync(f)).digest("hex") }));
  const lockResult = checkLock(entries, lock, mode);
  if (!lockResult.ok) {
    for (const e of lockResult.errors) console.error(`FAIL ${e}`);
    process.exit(1);
  }
  if (mode === "write") writeFileSync(lockPath, JSON.stringify(lockResult.nextLock, null, 2) + "\n");

  console.log(`invariants OK — ${result.tableCount}/${TABLE_BUDGET} tables, events append-only (${migrations.length} migration files, lock: ${mode})`);
}

if (process.argv[1]?.endsWith("invariants.ts")) main();
