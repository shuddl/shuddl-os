import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// REQ-118 §616 — genesis/14 §01 CALLS ITSELF "exact". IT MUST BE.
//
// §611 gated CLAUDE.md's six numeric budgets against the constants that enforce them. This is the same shape
// applied to STRUCTURE: a source-of-truth document stating a layout, and a tree that can grow without it.
//
// MEASURED (§616): the block named 11 modules; the tree held 18. Nothing stated was missing — the drift was
// growth only, and every one of the seven unlisted modules is registered scope (3 to 22 register rows cited
// apiece, `check:traceability` clean in both directions). So this was a RECORD defect, not a scope defect:
// a reader taking "exact" literally would have questioned seven legitimate modules, `packages/agents` among
// them — the one place CLAUDE.md permits an LLM call to live.
//
// Both directions matter, and for different reasons:
//   · in the tree, not in the doc → the document silently stops describing the repo (what §616 found);
//   · in the doc, not in the tree → the document describes a module that no longer exists, which is how a
//     reader ends up looking for code that was deleted.

const FENCE = /## \(01\) MONOREPO LAYOUT.*?```\n(.*?)```/s;

/** The module paths listed in §01's fenced block. */
function documentedModules(root: string): string[] {
  const spec = readFileSync(`${root}/genesis/14-BUILD-EXECUTION-SPEC.md`, "utf8");
  const block = FENCE.exec(spec)?.[1];
  if (block === undefined) return [];
  const out = new Set<string>();
  for (const line of block.split("\n")) {
    const m = /^\s+((?:apps|workers|packages)\/[\w-]+|fixtures)\//.exec(line);
    if (m) out.add(m[1]!);
  }
  return [...out].sort();
}

/** The modules that actually exist, derived from tracked files rather than a directory walk (a stray
 *  untracked scratch directory is not a module, and `git ls-files` is what every other gate here reads). */
function actualModules(root: string): string[] {
  const out = new Set<string>();
  for (const f of execSync("git ls-files", { cwd: root, encoding: "utf8" }).trim().split("\n")) {
    const p = f.split("/");
    if ((p[0] === "apps" || p[0] === "workers" || p[0] === "packages") && p.length > 1) out.add(`${p[0]}/${p[1]}`);
    else if (p[0] === "fixtures") out.add("fixtures");
  }
  return [...out].sort();
}

describe("REQ-118 §616: genesis/14 §01 is the exact monorepo layout", () => {
  const root = repoRoot();

  it("the layout block parses (non-vacuity)", () => {
    // A reworded heading or a removed fence yields [] and would compare empty to empty — the class this repo
    // met in fourteen gates (§487 … §614). It bit THIS phase directly: the first parse returned 0 documented
    // modules and printed "18 undocumented", an alarming result produced entirely by a wrong indentation
    // assumption in the probe, not by the tree.
    expect(
      documentedModules(root).length,
      "genesis/14 §01's layout block did not parse — the heading or the fence moved. That is a broken scan, " +
        "not an empty layout; fix the parse before believing the comparison below",
    ).toBeGreaterThan(10);
  });

  it("every module in the tree is listed, and every listed module exists", () => {
    const documented = documentedModules(root);
    const actual = actualModules(root);
    const undocumented = actual.filter((m) => !documented.includes(m));
    const phantom = documented.filter((m) => !actual.includes(m));
    expect(
      { undocumented, phantom },
      "genesis/14 §01 calls itself the EXACT layout and no longer matches the tree.\n" +
        "  · undocumented: a module exists that the layout never records. It is probably legitimate — " +
        "traceability would already have failed if its code cited no register row — but the document stops " +
        "describing the repo, and that is what a session reads first.\n" +
        "  · phantom: the layout names a module that is gone, which sends a reader hunting for deleted code.\n" +
        `  Add or remove the line in genesis/14 §01:\n${JSON.stringify({ undocumented, phantom }, null, 2)}`,
    ).toEqual({ undocumented: [], phantom: [] });
  });
});
