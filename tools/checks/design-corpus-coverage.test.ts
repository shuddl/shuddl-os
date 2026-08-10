import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §895 — THE DESIGN CORPUS MAY NOT EXCLUDE A DIRECTORY BY DEFAULT.
//
// §894 enumerated `tools/design/audit.ts`'s file list and closed on the structural point: it is a HAND-WRITTEN
// glob list, and nothing derives it from the surfaces actually shipped. So a new top-level directory is
// excluded by DEFAULT rather than by DECISION, and those two look identical from the outside.
//
// That is the roster-half of the shape this repo keeps meeting (§802/§822/§833): a roster finds what it lists;
// only a scan finds what arrives. This is the scan.
//
// MEASURED AT §895: style-bearing files (css/tsx/jsx/html) live in `apps` (62), `packages` (16) and `docs` (2).
// The two under `docs` are marketing HTML carrying 15 raw hexes and no shadows or gradients. Their exclusion is
// CORRECT — marketing collateral is not one of the three product surfaces the design law governs, and this repo
// hosts a launch-site workstream alongside the product. But nothing SAID so: they were outside the corpus
// because `docs` was never listed, which is indistinguishable from a decision until a third directory appears.

/** Extensions the design law can meaningfully judge — a palette/shadow/radius rule needs markup or styles. */
const STYLE_EXT = /\.(css|tsx|jsx|html)$/;

/**
 * Top-level directories the audit's OWN glob list covers, parsed from its source rather than restated here.
 * §830's rule: read one side and COMPUTE the other, so this gate cannot drift from the thing it checks. A
 * copied list would agree with the audit on the day it was written and never again.
 */
function corpusRoots(root: string): Set<string> {
  const src = readFileSync(`${root}/tools/design/audit.ts`, "utf8");
  const roots = new Set<string>();
  for (const m of src.matchAll(/"([a-z][a-z0-9_-]*)\/\*\*\/[^"]*"/g)) roots.add(m[1] as string);
  return roots;
}

/**
 * Directories deliberately outside the design law, each with the reason. A row here is a DECISION; its absence
 * is what this gate exists to make impossible.
 */
const EXEMPT: Record<string, string> = {
  docs: "marketing collateral and audit prose, not a product surface. docs/marketing/*.html are launch-site " +
    "artifacts; the design law governs Command, Driver and Portal, and a palette rule for those has no " +
    "business failing a promo page.",
};

describe("§895: every directory holding style-bearing files is covered or exempted", () => {
  const root = repoRoot();

  const dirsWithStyle = (): Map<string, number> => {
    const out = new Map<string, number>();
    for (const f of execSync("git ls-files", { cwd: root, encoding: "utf8" }).split("\n")) {
      if (!f || !f.includes("/") || !STYLE_EXT.test(f)) continue;
      const top = f.split("/")[0] as string;
      out.set(top, (out.get(top) ?? 0) + 1);
    }
    return out;
  };

  it("both sides parse (non-vacuity — two empty sets agree about nothing)", () => {
    // §819's failure mode. A changed glob shape in audit.ts, or a broken ls-files read, yields empty sets and
    // the assertion below passes over nothing. Floors sit well under the values measured at §895.
    const roots = corpusRoots(root);
    expect(roots.size, "no globs parsed from tools/design/audit.ts — the scan is broken, not the audit").toBeGreaterThanOrEqual(2);
    expect(roots, "the audit no longer covers apps/ — that is a finding, not a parse problem").toContain("apps");
    expect(dirsWithStyle().size, "no style-bearing files found anywhere — ls-files or the extension set broke").toBeGreaterThanOrEqual(2);
  });

  it("no directory holding style-bearing files is silently outside the design corpus", () => {
    const roots = corpusRoots(root);
    const uncovered = [...dirsWithStyle().entries()]
      .filter(([d]) => !roots.has(d) && !(d in EXEMPT))
      .map(([d, n]) => `${d}/ (${n} style-bearing file(s))`);
    expect(
      uncovered,
      "a top-level directory holds .css/.tsx/.jsx/.html that `pnpm audit:design` never scans. Either add it " +
        "to the glob list in tools/design/audit.ts so the design law applies, or add it to EXEMPT here with " +
        "the reason it is not a product surface. Excluding it by SILENCE is the failure this gate exists " +
        "for — §894 found `docs/` in exactly that state:\n  " + uncovered.join("\n  "),
    ).toEqual([]);
  });

  it("no EXEMPT row outlives its subject (§672)", () => {
    // Two ways a row rots: the directory stops carrying style-bearing files (dead weight that reads as a
    // considered decision), or the audit starts covering it anyway (the exemption now hides a real overlap).
    const roots = corpusRoots(root);
    const present = dirsWithStyle();
    for (const [dir, why] of Object.entries(EXEMPT)) {
      expect(present.has(dir), `${dir}/ is exempted but holds no style-bearing files — delete the row ("${why.slice(0, 44)}…")`).toBe(true);
      expect(roots.has(dir), `${dir}/ is exempted AND covered by the audit's globs — one of the two is wrong`).toBe(false);
    }
  });
});
