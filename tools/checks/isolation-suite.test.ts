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

/**
 * The suite, BY IDENTITY, each with its OWN case floor. Adding a file here is how a new isolation proof joins
 * the set.
 *
 * PER-FILE, not just aggregate (audit §827). The aggregate floor alone is blind to REDISTRIBUTION, and that
 * is not theoretical — measured: disabling 5 of the translator's 9 cross-tenant proofs and padding the MCP
 * file with 5 `expect(1).toBe(1)` fillers held the total at 149 and left this gate GREEN. Five real proofs
 * traded for five that prove nothing, silently, on REQ-025. The earlier probe that zeroed a file entirely was
 * caught, but only by the non-vacuity test and only because the count hit 0 — a partial trade walks through.
 *
 * Each number MAY RISE freely and MAY NOT FALL without an edit here naming the retired proof.
 */
const PER_FILE_FLOOR: Readonly<Record<string, number>> = {
  "workers/api/test/isolation.test.ts": 64,
  "workers/api/test/lens-adversarial.test.ts": 44,
  "workers/api/test/platform-tenant-isolation.test.ts": 9,
  "workers/api/test/plg-isolation-matrix.test.ts": 8,
  "workers/mcp/test/isolation.test.ts": 15,
  "workers/translator/test/isolation.test.ts": 9,
};

const SUITE: readonly string[] = Object.keys(PER_FILE_FLOOR);

/**
 * Aggregate floor, DERIVED from the per-file floors rather than written twice (§823's lesson: two numbers
 * that mean the same thing drift, and the one nobody compares is the one that rots — that audit found a
 * checklist claiming 7 sites beside a roster holding 8). It is kept because it states the suite's total size
 * in one place for a reader; it can no longer disagree with the parts.
 */
const MIN_CASES = Object.values(PER_FILE_FLOOR).reduce((a, b) => a + b, 0);

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

  it("§827: no INDIVIDUAL file's proofs fell — redistribution is not a defence", () => {
    // The hole the aggregate floor left. A file may grow freely; it may not shrink while a sibling covers for
    // it. Nothing here can tell a real isolation proof from a filler with the same shape — a count never can —
    // but it forces the trade to be a visible edit in THIS file rather than an invisible one in a suite file.
    const fallen = SUITE.map((f) => ({ f, n: caseCount(root, f), floor: PER_FILE_FLOOR[f]! })).filter(
      (c) => c.n < c.floor,
    );
    expect(
      fallen.map((c) => `${c.f}: ${c.n} cases, floor ${c.floor}`),
      "a cross-tenant isolation FILE lost proofs. The aggregate total may still hold — another file can have " +
        "grown, and growth elsewhere is not evidence about THIS file. Restore them, or lower this file's " +
        "floor and say which proof was retired and why:",
    ).toEqual([]);
  });

  it("the case scan actually reads the files (non-vacuity)", () => {
    // A changed test idiom would count 0 everywhere and the floor above would fail loudly rather than pass —
    // but this states the failure in terms of the SCAN so the reader is not sent hunting for deleted tests
    // that were never deleted. The class this repo met in thirteen gates (§487 … §613).
    const empty = SUITE.filter((f) => caseCount(root, f) === 0);
    expect(empty, `no test cases parsed from these files — the scan is stale, not the suite:\n  ${empty.join("\n  ")}`).toEqual([]);
  });
});
