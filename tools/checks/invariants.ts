import { globSync, readFileSync } from "node:fs";

// I8 (doc 10): ≤22 tables — 21 named, the spare requires a written deletion (register note).
export const TABLE_BUDGET = 22;
const NAMED_TABLES = 21;

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
  if (tables.size > TABLE_BUDGET) {
    violations.push(
      `I8 VIOLATION: ${tables.size} tables > budget ${TABLE_BUDGET}. A 22nd+ table requires a register amendment + written deletion.`,
    );
  } else if (tables.size > NAMED_TABLES) {
    warnings.push(`I8: spare table slot spent (${tables.size}/${TABLE_BUDGET}). This requires a written deletion note in the register.`);
  }

  // I3 (doc 10 / genesis/14 §07): any migration touching events beyond CREATE/INDEX fails.
  for (const m of all.matchAll(/\b(UPDATE|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE)\s+["'`]?events\b/gi)) {
    violations.push(`I3 VIOLATION: migrations may only CREATE/INDEX the events table — found "${m[0]}". Corrections are new events.`);
  }
  for (const m of all.matchAll(/CREATE\s+TRIGGER[^;]+\bON\s+["'`]?events\b.*?(UPDATE|DELETE)/gis)) {
    violations.push(`I3 VIOLATION: trigger performing ${m[1]} involving events.`);
  }

  return { ok: violations.length === 0, tableCount: tables.size, violations, warnings };
}

function main(): void {
  const files = globSync("**/migrations/*.sql", { exclude: (p) => p.includes("node_modules") });
  const sql = files.map((f) => readFileSync(f, "utf8"));
  const result = checkMigrationSql(sql);
  for (const w of result.warnings) console.warn(`WARN ${w}`);
  if (!result.ok) {
    for (const v of result.violations) console.error(`FAIL ${v}`);
    process.exit(1);
  }
  console.log(`invariants OK — ${result.tableCount}/${TABLE_BUDGET} tables, events append-only (${files.length} migration files)`);
}

if (process.argv[1]?.endsWith("invariants.ts")) main();
