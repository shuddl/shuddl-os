import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// REQ-025/015 §765 — AN `OR` CLAUSE IN AN `AND`-JOINED CHAIN MUST BE PARENTHESISED.
//
// §764's defect, generalised. SQL binds AND tighter than OR, so a clause containing a bare `OR` that is joined
// into a `" AND "` chain does not narrow the query — it splits it:
//
//     (c1 AND c2 AND  a OR b )   parses as   (c1 AND c2 AND a)  OR  (b)
//
// The right-hand branch carries NONE of the preceding clauses. In `lens.ts` that branch carried none of the
// LENS, so a portal client paging through its own stream would have received every event on it — internal ones
// included (REQ-025 / I6). The outer parentheses were the only thing preventing it, and removing them left
// `packages/ledger` at 667/667 GREEN because no test combined a non-tenant lens with a cursor.
//
// §764 pinned that intersection behaviourally, which covers the clause that exists TODAY. This covers the next
// one. The two are the `two-mechanisms` pair on purpose: the behavioural test proves the lens holds for the
// cursor we ship, this proves the SHAPE holds for any clause anyone adds.
//
// SCOPE, stated: exactly two AND-joined chains exist in shipped code (`lens.ts`, `gl/export.ts` — measured,
// derived below rather than listed). The GL journal export's clauses are pure narrowings today. A gate over a
// two-member population is cheap because the population is small, not because the risk is: one of the two is
// the highest-stakes WHERE in the repo.

/** Files that join SQL clauses with " AND " — derived, so a third chain is covered on the day it lands. */
function andChainFiles(root: string): string[] {
  const files = execSync('git ls-files "packages/**/*.ts" "workers/**/*.ts"', { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => f && !f.includes(".test.") && !f.includes("/test/"));
  return files.filter((f) => /join\(\s*["'`]\s*AND\s*["'`]\s*\)/.test(readFileSync(`${root}/${f}`, "utf8")));
}

/** Every string literal in the file that reads like a SQL clause and contains a bare `OR`. */
function orClauses(src: string): string[] {
  const out: string[] = [];
  // String literals that mention ` OR `. SINGLE-LINE ONLY — the first cut allowed newlines inside the literal
  // and promptly matched from one backtick in a COMMENT to another several lines later, reporting prose as an
  // unparenthesised clause. Every real clause fragment here is one line; allowing more only lets the matcher
  // span code it was never reading.
  for (const m of src.matchAll(/(["'`])((?:(?!\1)[^\\\n])*?\sOR\s(?:(?!\1)[^\\\n])*?)\1/g)) {
    const body = m[2]!;
    // Comments and prose mentioning OR are not clauses; require it to look like SQL (a comparison or a column).
    if (!/[<>=]|\bIN\b|\bIS\b/.test(body)) continue;
    out.push(body);
  }
  return out;
}

/** A clause is safe when the WHOLE fragment is wrapped, so the OR cannot bind past it. */
function isWrapped(clause: string): boolean {
  const t = clause.trim();
  if (!t.startsWith("(") || !t.endsWith(")")) return false;
  // The opening paren must still be open at the last character — `(a) OR (b)` starts and ends with parens but
  // is NOT wrapped, and is exactly the shape that would slip through a naive startsWith/endsWith check.
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "(") depth += 1;
    else if (t[i] === ")") {
      depth -= 1;
      if (depth === 0 && i < t.length - 1) return false;
    }
  }
  return depth === 0;
}

describe("REQ-025/015 §765: an OR clause joined into an AND chain is parenthesised", () => {
  const root = repoRoot();
  const files = andChainFiles(root);

  it("finds the AND-joined chains (non-vacuity — an empty scan must not read as clean)", () => {
    // If the join idiom is reworded, this file silently guards nothing. Measured today: exactly two.
    expect(files.length, "no AND-joined SQL clause chains found — the scan broke, not the tree").toBeGreaterThanOrEqual(2);
  });

  it.each(andChainFiles(repoRoot()))("%s: every OR-bearing clause is fully wrapped", (file) => {
    const bare = orClauses(readFileSync(`${root}/${file}`, "utf8")).filter((c) => !isWrapped(c));
    expect(
      bare,
      `an OR-bearing SQL clause in ${file} is not fully parenthesised. Joined into a " AND " chain, SQL's ` +
        "precedence turns it into `(everything AND left) OR (right)` — and the right branch carries NONE of the " +
        "preceding clauses, including the LENS. That is how a portal client reads another party's events " +
        "(§764). Wrap the whole fragment in parentheses:\n  " +
        bare.join("\n  "),
    ).toEqual([]);
  });

  it("the wrapper check rejects `(a) OR (b)` — balanced at the ends, split in the middle", () => {
    // Non-vacuity for isWrapped itself: a naive startsWith("(")/endsWith(")") passes this string, and it is
    // precisely the dangerous shape. Without this assertion the gate above could be trivially satisfiable.
    expect(isWrapped("(e.a = ?) OR (e.b = ?)")).toBe(false);
    expect(isWrapped("(e.a = ? OR e.b = ?)")).toBe(true);
  });
});
