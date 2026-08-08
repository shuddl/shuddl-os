import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmptyGlobError, scanCorpus } from "./scan-corpus.js";

// REQ-118 §627 — THE HELPER THAT ENFORCES NON-VACUITY NEEDS ITS OWN.
//
// §625 shipped `scanCorpus()` while retracting a false finding; §626 reviewed it and named the gap this file
// closes: `mayBeEmpty` had no test. It is not speculative generality — `append-chokepoint.ts` carries
// `EXPECTED_EMPTY_GLOBS` for exactly this reason, so the concept is proven necessary in this repo. It was
// simply unexercised, which is §579's shape: a guard whose discriminating input takes setup ends up unwatched.
//
// Here the setup is four files in a temp git repo, so "expensive" was never the real reason.
//
// The case worth the fixture is the THIRD one. `scanCorpus` judges emptiness on the RAW `git ls-files` result,
// before `excludeTests` filters — because a glob matching only test files HAS matched, and reporting it empty
// would send the reader hunting for a renamed directory that is fine. That ordering was a comment §625 wrote
// and nothing checked; swapping the two lines is silent without it.

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "scan-corpus-"));
  execFileSync("git", ["init", "--quiet"], { cwd: repo });
  mkdirSync(join(repo, "src", "nested"), { recursive: true });
  mkdirSync(join(repo, "only-tests"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "src", "a.test.ts"), "export const at = 1;\n");
  writeFileSync(join(repo, "src", "nested", "b.ts"), "export const b = 2;\n");
  writeFileSync(join(repo, "only-tests", "c.test.ts"), "export const c = 3;\n");
  execFileSync("git", ["add", "."], { cwd: repo });
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("REQ-118 §627: scanCorpus enforces per-glob non-vacuity", () => {
  it("returns the union, deduplicated and sorted", () => {
    // Both globs match src/a.ts — git pathspec `*` crosses `/`, which is the fact §625 got wrong by deriving
    // the union through addition instead of measuring it. Asserting the UNION here pins that behaviour.
    expect(scanCorpus(["src/*.ts", "src/nested/*.ts"], repo)).toEqual([
      "src/a.test.ts",
      "src/a.ts",
      "src/nested/b.ts",
    ]);
  });

  it("excludeTests drops test files from the RESULT", () => {
    expect(scanCorpus(["src/*.ts"], repo, { excludeTests: true })).toEqual(["src/a.ts", "src/nested/b.ts"]);
  });

  it("a glob matching ONLY test files is not empty — emptiness is judged before the filter", () => {
    // The subtle one. With `excludeTests` the result is [], but the glob DID match, so this must not throw:
    // a thrown EmptyGlobError would say "renamed directory or typo" about a directory that is perfectly fine.
    expect(() => scanCorpus(["only-tests/*.ts"], repo, { excludeTests: true })).not.toThrow();
    expect(scanCorpus(["only-tests/*.ts"], repo, { excludeTests: true })).toEqual([]);
  });

  it("a glob matching nothing THROWS, naming the glob", () => {
    expect(() => scanCorpus(["does-not-exist/*.ts"], repo)).toThrow(EmptyGlobError);
    expect(() => scanCorpus(["does-not-exist/*.ts"], repo)).toThrow(/does-not-exist/);
  });

  it("one empty glob throws even when a sibling matches plenty — this is the whole point", () => {
    // §466's rule, which is why the helper exists: an aggregate floor is satisfied by one member, so it says
    // nothing about the others. Here `src/*.ts` returns three files and must NOT excuse the broken sibling.
    expect(() => scanCorpus(["src/*.ts", "does-not-exist/*.ts"], repo)).toThrow(EmptyGlobError);
  });

  it("mayBeEmpty excuses a named glob, and only that one", () => {
    expect(() => scanCorpus(["does-not-exist/*.ts"], repo, { mayBeEmpty: new Set(["does-not-exist/*.ts"]) })).not.toThrow();
    // Exact-string membership, not a prefix or pattern match: an exemption that fuzzy-matched would excuse
    // globs nobody reviewed, which is the failure mode every allowlist in this repo is written to avoid.
    expect(() => scanCorpus(["does-not-exist/*.ts"], repo, { mayBeEmpty: new Set(["does-not-exist/"]) })).toThrow(EmptyGlobError);
  });
});
