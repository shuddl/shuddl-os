import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// REQ-025 §614 — THE CROSS-TENANT ISOLATION SUITE HAS A NAME, AND IT CANNOT SHRINK QUIETLY.
//
// CLAUDE.md rule 8: "Tenant isolation suite runs on every merge; a cross-tenant read anywhere is a build
// failure." genesis/14 §07 lists it as a distinct PR gate: "... → traceability → isolation suite".
//
// It does run — every file below is collected by its package's vitest config and executes under the
// `unit-tests` merge gate. What did not exist was any statement of WHAT THE SUITE IS. There is no gate named
// `isolation` in `gatesFor("merge")`; the suite was a set of files nobody had enumerated, so deleting one
// removed the proof and nothing said so.
//
// MEASURED (§614) — `plg-isolation-matrix.test.ts`, EIGHT cases proving cross-tenant reads fail across the
// PLG surface, deleted and the deletion STAGED as a real PR would have it:
//
//     test:tools → 3 failed | 920 passed   (the pre-existing register baseline, unchanged)
//
// Silent. Two other members happened to be caught, and only incidentally: deleting them broke
// `check:citations` because some document cites those paths — protection that exists for the cited files and
// not for the uncited one, which is no protection at all.
//
// A NAMED GATE was considered and rejected. Re-running these files under a second runner would duplicate what
// `unit-tests` already does across three different vitest pools (api and mcp are vitest-pool-workers,
// translator is node) — the two-mechanisms trap, where the copy becomes the thing that rots. What was missing
// was never the execution; it was the roster.

/** The suite, BY IDENTITY. Adding a file here is how a new isolation proof joins the set. */
const SUITE: readonly string[] = [
  "workers/api/test/isolation.test.ts",
  "workers/api/test/lens-adversarial.test.ts",
  "workers/api/test/platform-tenant-isolation.test.ts",
  "workers/api/test/plg-isolation-matrix.test.ts",
  "workers/mcp/test/isolation.test.ts",
  "workers/translator/test/isolation.test.ts",
];

/**
 * Aggregate case floor. MEASURED at 149 when this landed (64 + 44 + 9 + 8 + 15 + 9).
 *
 * A floor rather than an exact count, for the reason `bundle-ratchet` and §609's browser ratchet use one: it
 * MAY RISE freely as isolation proofs are added, and MAY NOT FALL without an edit here saying which proof was
 * retired. The file list alone would not catch cases deleted from INSIDE a file, which is the same shrinkage
 * by a quieter route.
 */
const MIN_CASES = 149;

function tracked(root: string): Set<string> {
  return new Set(execSync("git ls-files", { cwd: root, encoding: "utf8" }).trim().split("\n"));
}

function caseCount(root: string, file: string): number {
  // A DELETED member reads as zero rather than an ENOENT stack trace: the roster test above owns that
  // diagnosis and states it in the language of the defect ("a cross-tenant isolation proof left the repo"),
  // which is strictly more useful than node:fs naming a path. §608 made the same repair to
  // authority-coverage, where a missing registered file failed closed but only as a crash.
  if (!existsSync(`${root}/${file}`)) return 0;
  return (readFileSync(`${root}/${file}`, "utf8").match(/^\s+(it|test)(\.each)?\(/gm) ?? []).length;
}

describe("REQ-025 §614: the isolation suite is enumerated and may not shrink", () => {
  const root = repoRoot();

  it("every member of the suite is still a tracked file", () => {
    // `git ls-files` rather than existsSync ON PURPOSE: a PR deletes by staging, and an unstaged `mv` trips
    // unrelated file scanners in a way that reads like protection but is not (§614 measured exactly that).
    const files = tracked(root);
    const missing = SUITE.filter((f) => !files.has(f));
    expect(
      missing,
      "a cross-tenant isolation proof left the repo. CLAUDE.md rule 8 calls a cross-tenant read a BUILD " +
        "FAILURE, and genesis/14 §07 lists this suite as a PR gate — removing one of its members retires that " +
        "proof silently, because the suite runs inside `unit-tests` and simply has less to run:\n  " +
        missing.join("\n  "),
    ).toEqual([]);
  });

  it("the suite's aggregate case count has not fallen", () => {
    const counts = SUITE.map((f) => ({ f, n: caseCount(root, f) }));
    const total = counts.reduce((a, c) => a + c.n, 0);
    expect(
      total,
      "the isolation suite SHRANK. Nothing failed — cases were removed, so there is simply less proof that a " +
        "cross-tenant read is refused. Restore them, or lower MIN_CASES here and say which isolation " +
        `proof was retired and why:\n  ${counts.map((c) => `${c.f}: ${c.n}`).join("\n  ")}`,
    ).toBeGreaterThanOrEqual(MIN_CASES);
  });

  it("the case scan actually reads the files (non-vacuity)", () => {
    // A changed test idiom would count 0 everywhere and the floor above would fail loudly rather than pass —
    // but this states the failure in terms of the SCAN so the reader is not sent hunting for deleted tests
    // that were never deleted. The class this repo met in thirteen gates (§487 … §613).
    const empty = SUITE.filter((f) => caseCount(root, f) === 0);
    expect(empty, `no test cases parsed from these files — the scan is stale, not the suite:\n  ${empty.join("\n  ")}`).toEqual([]);
  });
});
