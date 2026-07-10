// Strip SQL line (--) and block (/* */) comments that are NOT inside a string
// literal ('...') or a quoted identifier ("..." / [...]). Comment spans collapse
// to a single space so tokens stay separated; string/identifier contents are kept
// verbatim — a '--' or ';' inside a string is data, not a comment/terminator.
export function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql.charAt(i);
    const next = sql.charAt(i + 1);
    if (c === "'" || c === '"') {
      // String literal / double-quoted identifier: copy verbatim to its close.
      out += c;
      i += 1;
      while (i < n) {
        const d = sql.charAt(i);
        out += d;
        if (d === c) {
          if (c === "'" && sql.charAt(i + 1) === "'") {
            out += "'"; // doubled '' escape inside a string
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (c === "[") {
      // Bracket-quoted identifier: copy verbatim to its close.
      out += c;
      i += 1;
      while (i < n) {
        const d = sql.charAt(i);
        out += d;
        i += 1;
        if (d === "]") break;
      }
      continue;
    }
    if (c === "-" && next === "-") {
      i += 2;
      while (i < n && sql.charAt(i) !== "\n") i += 1;
      out += " ";
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(sql.charAt(i) === "*" && sql.charAt(i + 1) === "/")) i += 1;
      i += 2; // skip the closing */
      out += " ";
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// Test/dev migration applier. Comments are stripped first (string-aware), so a
// statement can be flattened to one line for D1's newline-splitting `exec` without
// an inline '--' swallowing the rest of it. Splits on ';' at top level only —
// trigger bodies (BEGIN ... END;) are kept whole. A trailing fragment with real
// content but no terminating ';' is a hard error (no silent drops — CLAUDE.md 10).
export function splitSql(sql: string): string[] {
  const clean = stripSqlComments(sql);
  const out: string[] = [];
  let buf = "";
  let depth = 0;
  for (const line of clean.split("\n")) {
    if (/\bBEGIN\b/i.test(line)) depth += 1;
    if (/\bEND\s*;/i.test(line)) depth -= 1;
    buf += line + "\n";
    if (depth === 0 && /;\s*$/.test(line.trimEnd())) {
      const stmt = buf.trim();
      if (stmt.length > 0) out.push(stmt);
      buf = "";
    }
  }
  const tail = buf.trim();
  if (tail.length > 0) {
    throw new Error(`splitSql: trailing SQL without a terminating ';' (no silent drops — CLAUDE.md rule 10): "${tail.slice(0, 80)}"`);
  }
  return out;
}

export async function applyMigrations(db: D1Database, files: ReadonlyArray<{ path: string; sql: string }>): Promise<void> {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : 1));
  for (const f of sorted) for (const stmt of splitSql(f.sql)) await db.exec(stmt.replaceAll("\n", " "));
}
