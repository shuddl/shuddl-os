import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §1713 (REQ-118/119, filed row: "Every KPI/metric scans the tenant's WHOLE event history, per request")
//
// THE SUBJECT. Every KPI and metric query reads `events` with no time bound, so each is linear in tenant
// lifetime forever. Nothing is WRONG — the numbers are correct at every scale — it only gets slower, which is
// the §1293 shape no test catches. The fix is a register decision and stays the owner's: a time window changes
// what the KPI MEANS (a "cost ratio" over 90 days is a different metric from one over all history), and an
// unbilled alarm bounded to a window stops alarming on the oldest unbilled POD, which is the one that matters.
//
// SO THIS GATE DOES THE PART THAT IS IN SCOPE: it stops the surface widening while that decision is open. A
// twelfth unbounded scan should cost a conversation, not a merge.
//
// THE COUNT IS HIGHER THAN THE ROW SAYS, and finding that is why this file scopes by DIRECTORY rather than by
// the two files the row names. The row measured `kpis/compute.ts` (2) and `queries/metrics.ts` (6) — both
// re-confirmed here. `queries/unbilled.ts` adds **3** more, and it is the sharpest of the eleven: it is the
// SHARED anti-join consumed by BOTH the command's "unbilled = 0" tile AND the Watchtower's durable alarm, so
// one unbounded predicate backs two surfaces. Enumerating by named file missed a file; enumerating by
// directory does not.
//
// WHAT IT CANNOT SEE, stated: a scan reached through a helper in another module, and a bound applied in code
// after the rows come back rather than in SQL. Both would read as unbounded here — the count therefore
// OVER-reports rather than under-reports, which is the safe direction for a ceiling.

/** FROZEN at §1713: 11 unbounded `FROM events` reads across the KPI/metrics/queries corpus. May FALL (a bound
 *  is added, or a query is deleted) — never grow. */
const FROZEN_UNBOUNDED = 11;

const DIRS = ["workers/api/src/kpis", "packages/ledger/src/queries"];
const FROM_EVENTS = /FROM\s+events\b/i;
const TIME_BOUND = /(ts|recorded_at)\s*>=/i;

/** PURE: unbounded `FROM events` sites in one file, by line. Separate so a synthetic corpus proves it. */
export function unboundedEventScans(text: string): number[] {
  const lines = text.split("\n");
  const out: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!FROM_EVENTS.test(lines[i] as string)) continue;
    // The enclosing statement, approximated by a window — a template-literal query spans lines, and the bound
    // (when one exists) sits in the same template as its FROM.
    const window = lines.slice(Math.max(0, i - 6), Math.min(lines.length, i + 10)).join("\n");
    if (!TIME_BOUND.test(window)) out.push(i + 1);
  }
  return out;
}

function corpus(root: string): string[] {
  return execSync(`git ls-files ${DIRS.map((d) => `"${d}"`).join(" ")}`, { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".ts") && !f.includes(".test."));
}

describe("§1713 REQ-118: the whole-history scan surface does not widen while the window decision is open", () => {
  const root = repoRoot();

  it("counts an unbounded scan and clears a bounded one (positive control)", () => {
    // Without this, a matcher that stopped recognising `FROM events` would report ZERO unbounded scans over a
    // corpus full of them — §1387's shape, where green means "found none".
    expect(unboundedEventScans("const q = `SELECT id FROM events WHERE tenant = ?`;")).toHaveLength(1);
    expect(unboundedEventScans("const q = `SELECT id FROM events WHERE ts >= ?1`;"), "a time bound clears it").toHaveLength(0);
    expect(unboundedEventScans("no query here")).toHaveLength(0);
  });

  it("reads the real corpus, and it still contains the sites the row names (non-vacuity)", () => {
    const files = corpus(root);
    expect(files.length, "the KPI/queries corpus is empty — the dirs moved, not the tree").toBeGreaterThanOrEqual(3);
    const named = ["workers/api/src/kpis/compute.ts", "packages/ledger/src/queries/metrics.ts"];
    for (const n of named) {
      expect(files, `${n} is no longer in the corpus — repoint this gate before trusting its count`).toContain(n);
    }
  });

  it("no NEW unbounded whole-history scan is added", () => {
    const files = corpus(root);
    const sites = files.flatMap((f) => unboundedEventScans(readFileSync(`${root}/${f}`, "utf8")).map((ln) => `${f}:${ln}`));
    expect(
      sites.length,
      `${sites.length} unbounded \`FROM events\` reads in the KPI/metrics corpus, frozen at ${FROZEN_UNBOUNDED} ` +
        "by §1713. Each is linear in tenant lifetime forever — correct at every scale, and slower every day, " +
        "which is why no test catches it. Add a time bound in SQL (the count then FALLS, and this number with " +
        "it), or raise this number in the same commit that says which metric's MEANING changed. Sites:\n  " +
        sites.join("\n  "),
    ).toBeLessThanOrEqual(FROZEN_UNBOUNDED);
  });
});
