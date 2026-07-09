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
    buf += line + "\n";
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
