import { createHash } from "node:crypto";
import { existsSync, globSync, readFileSync, writeFileSync } from "node:fs";

// I8 (doc 10): ≤22 tables — 21 named, the spare requires a written deletion (register note).
export const TABLE_BUDGET = 22;
const NAMED_TABLES = 21;

// Doc 10 entry 9: physical partitions sharing one budget entry with their parent.
// Expanding this map requires a register note (test pins its keys).
export const PARTITION_TABLES: Record<string, string> = { positions: "events" };

// Append-only tables that MUST carry RAISE(ABORT) guard triggers once created (I3, I1).
const GUARDED_TABLES = ["events", "positions", "money_lines"] as const;

export type InvariantResult = { ok: boolean; tableCount: number; violations: string[]; warnings: string[] };

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
    violations.push(
      `I8 VIOLATION: ${effective} effective tables > budget ${TABLE_BUDGET}. A 22nd+ table requires a register amendment + written deletion.`,
    );
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

function main(): void {
  const files = globSync("db/**/migrations/*.sql");
  const strays = globSync("**/*.sql", { exclude: (p) => p.includes("node_modules") || p.startsWith("db/") || p.startsWith("fixtures/") });
  if (strays.length > 0) {
    console.error(`FAIL stray SQL outside db/*/migrations (evades I3/I8 lint): ${strays.join(", ")}`);
    process.exit(1);
  }
  // Forward-only: a merged migration file is immutable (hash-pinned in db/migrations.lock.json).
  const lockPath = "db/migrations.lock.json";
  const lock = existsSync(lockPath) ? (JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, string>) : {};
  for (const f of files) {
    const digest = createHash("sha256").update(readFileSync(f)).digest("hex");
    if (lock[f] && lock[f] !== digest) {
      console.error(`FAIL migration ${f} was EDITED after lock — migrations are forward-only; add a new file.`);
      process.exit(1);
    }
    lock[f] = lock[f] ?? digest;
  }
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
  const result = checkMigrationSql(files.map((f) => readFileSync(f, "utf8")));
  for (const w of result.warnings) console.warn(`WARN ${w}`);
  if (!result.ok) {
    for (const v of result.violations) console.error(`FAIL ${v}`);
    process.exit(1);
  }
  console.log(`invariants OK — ${result.tableCount}/${TABLE_BUDGET} tables, events append-only (${files.length} migration files)`);
}

if (process.argv[1]?.endsWith("invariants.ts")) main();
