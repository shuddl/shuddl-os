import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { repoRoot } from "./repo-root.js";

// §997 — NO FILE-SYNC DUPLICATE (`name 2.ext`) MAY SIT IN A DIRECTORY THE REPO OWNS.
//
// This checkout lives on an iCloud-synced Desktop, and the sync resolves conflicts by writing a SECOND file
// beside the first: `foo.ts` → `foo 2.ts`. Nothing in git ever sees it — the copies are untracked, so
// `git status` hides them under an ignored/untracked directory and every git-based gate is blind by
// construction.
//
// MEASURED AT §997: **six** duplicates had accumulated in `tools/checks/` — stale copies of six gates written
// earlier in this same audit. Five were byte-identical to their originals; the sixth was an older snapshot
// (104 lines against 151) whose content was a strict SUBSET, i.e. it contained nothing that would have been
// lost. Removing all six left `pnpm test:tools` bit-identical (96 files / 1220 passed / the same 3 baseline
// failures), so they were **inert, not active** — which is exactly why nobody noticed them for days.
//
// WHY GATE AN INERT PROBLEM. The duplicates were harmless *here* only because of where they landed. Vitest
// collects `tools/**/*.test.ts`, and `wrangler-absence-claims.test 2.ts` ends in `t 2.ts`, so it was never
// run. A duplicate of a SOURCE file has no such luck: `packages/ledger/src/positions 2.ts` matches every
// `**/*.ts` glob in this repo — the lint scanners, the invariant scanners, the LLM-import bans, the budget
// counters. It would be linted, type-checked and COUNTED as a real module, against budgets CLAUDE.md declares
// (≤22 tables, 3 surfaces, 12 views). A stale copy of a guard is also a copy a future reader can edit by
// mistake, believing it is the live one.
//
// SELF-SCOPING, so it never nags about someone else's files: a directory is "owned by the repo" iff it
// contains at least one TRACKED file. `tools/checks/` qualifies; a fully-untracked sibling workstream living
// in the same checkout does not, and its 46 duplicates are correctly none of this gate's business.
//
// SCOPE, STATED: this catches the sync's naming convention (` <digits>.<ext>`), not every possible stale copy.
// A duplicate named `positions-old.ts` is ordinary dead code and belongs to a different question.

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", "artifacts", ".wrangler", ".turbo", ".vite", ".next"]);
/** The sync's signature: a space, one or more digits, then the extension. `foo 2.ts`, `_metadata 2.json`. */
const DUPLICATE = / \d+\.[A-Za-z0-9]+$/;

function trackedDirs(root: string): Set<string> {
  const out = new Set<string>();
  const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter((l) => l !== "");
  for (const f of files) {
    // every ancestor directory of a tracked file is repo-owned
    let d = dirname(f);
    while (d !== "." && d !== "/" && !out.has(d)) { out.add(d); d = dirname(d); }
    out.add(".");
  }
  return out;
}

function walk(root: string, owned: Set<string>): { visited: number; duplicates: string[] } {
  const duplicates: string[] = [];
  let visited = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(join(dir, e.name));
        continue;
      }
      visited += 1;
      if (!DUPLICATE.test(e.name)) continue;
      const rel = relative(root, join(dir, e.name));
      // Only a directory the repo OWNS — one holding at least one tracked file.
      if (owned.has(dirname(rel))) duplicates.push(rel);
    }
  }
  return { visited, duplicates };
}

describe("§997: no file-sync duplicate sits in a repo-owned directory", () => {
  const root = repoRoot();
  const owned = trackedDirs(root);
  const { visited, duplicates } = walk(root, owned);

  it("the walk and the ownership set are real (non-vacuity — §968's rule)", () => {
    // Both floors can fail independently. A broken walk visits nothing; a broken `git ls-files` owns nothing.
    // Either would report a clean tree over an empty corpus — the failure mode this whole audit keeps finding.
    expect(visited, "the tree walk visited almost no files — the walk is broken, not the repo").toBeGreaterThanOrEqual(500);
    expect(owned.size, "no repo-owned directories resolved from `git ls-files` — the ownership scan is broken").toBeGreaterThanOrEqual(20);
    expect(owned.has("tools/checks"), "`tools/checks` is not recognised as repo-owned — the ownership rule broke").toBe(true);
  });

  it("no duplicate files", () => {
    expect(
      duplicates.sort(),
      "file-sync duplicate(s) in repo-owned director(ies):\n  " +
        duplicates.sort().join("\n  ") +
        "\n\nThis checkout syncs through iCloud, which resolves conflicts by writing `name 2.ext` beside the " +
        "original. They are UNTRACKED, so git-based gates cannot see them — §997 found six stale copies of " +
        "gate files sitting in `tools/checks/` for days.\n" +
        "They were inert only because vitest's `*.test.ts` glob skips `…test 2.ts`. A duplicated SOURCE file " +
        "(`positions 2.ts`) matches every `**/*.ts` scanner here and would be linted, type-checked and counted " +
        "against the CLAUDE.md budgets as a real module.\n" +
        "Diff each against its original and delete it. If one holds unique work, rename it properly first — " +
        "the §997 duplicates were five byte-identical copies and one strict subset, so nothing was lost.",
    ).toEqual([]);
  });
});
