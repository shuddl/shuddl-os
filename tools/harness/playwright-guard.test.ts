import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { repoRoot } from "../checks/repo-root.js";
import { classifyRun, MIN_ASSERTIONS, parseArgs, parseStats, type RunOutcome } from "./playwright-guard.js";
import { gateResultProblem, EVIDENCE_EXIT, type GateMode } from "../release/evidence.js";

// V1 remediation Task 14 (REQ-288/REQ-158/REQ-285) — THE NEGATIVE CONTROLS.
//
// A browser gate has three ways to look green while proving nothing:
//   1. the browser/tooling was never installed,
//   2. the run discovered NO tests,
//   3. every discovered test was skipped.
// Playwright exits 0 for (3) and — depending on flags — for (2). Under `--mode merge|release` all three
// MUST be non-promotable. These tests are the proof, and they are the reason the guard reads Playwright's
// MACHINE-READABLE json stats instead of its human line output (the same law tools/release/evidence.ts
// states: a gate returns a structured result, it never parses prose).

const MODES: GateMode[] = ["merge", "release"];

function runOutcome(
  exitCode: number | null,
  stats: { expected: number; unexpected: number; flaky: number; skipped: number } | null,
): RunOutcome {
  return { kind: "ran", exitCode, stats };
}

describe("negative control 1 — absent browser/tooling", () => {
  const absent: RunOutcome = { kind: "tooling-absent", reason: "@playwright/test is not installed" };

  it.each(MODES)("BLOCKS under --mode %s and never reports PASS", (mode) => {
    const { result, exitCode } = classifyRun("visual", mode, false, absent);
    expect(result.status).toBe("BLOCKED");
    expect(result.executed).toBe(false);
    expect(result.assertions).toBe(0);
    expect(exitCode).toBe(EVIDENCE_EXIT.PREREQ_BLOCKED);
  });

  it("stays an advisory exit-0 skip locally (the browser is deliberately out of the default install)", () => {
    const { result, exitCode } = classifyRun("visual", "local", false, absent);
    expect(result.status).toBe("PENDING");
    expect(exitCode).toBe(EVIDENCE_EXIT.OK);
  });

  it("stays exit 0 locally even under --strict: you cannot run a browser you do not have", () => {
    expect(classifyRun("visual", "local", true, absent).exitCode).toBe(EVIDENCE_EXIT.OK);
  });
});

describe("negative control 2 — no tests discovered", () => {
  const nothing = runOutcome(0, { expected: 0, unexpected: 0, flaky: 0, skipped: 0 });

  it.each(MODES)("BLOCKS under --mode %s even though Playwright exited 0", (mode) => {
    const { result, exitCode } = classifyRun("a11y", mode, false, nothing);
    expect(result.status).toBe("BLOCKED");
    expect(result.executed).toBe(false);
    expect(result.assertions).toBe(0);
    expect(result.detail).toMatch(/no tests/i);
    expect(exitCode).toBe(EVIDENCE_EXIT.PREREQ_BLOCKED);
  });

  it("fails a local --strict run: the tooling is present, so an empty suite is a real defect", () => {
    expect(classifyRun("a11y", "local", true, nothing).exitCode).toBe(EVIDENCE_EXIT.ASSERTIONS_FAILED);
  });
});

describe("negative control 3 — every test skipped", () => {
  const allSkipped = runOutcome(0, { expected: 0, unexpected: 0, flaky: 0, skipped: 4 });

  it.each(MODES)("BLOCKS under --mode %s: a suite that only skipped asserted nothing", (mode) => {
    const { result, exitCode } = classifyRun("e2e", mode, false, allSkipped);
    expect(result.status).toBe("BLOCKED");
    expect(result.executed).toBe(false);
    expect(result.assertions).toBe(0);
    expect(result.detail).toMatch(/skip/i);
    expect(exitCode).toBe(EVIDENCE_EXIT.PREREQ_BLOCKED);
  });
});

describe("negative control 4 — an unprovable run (no machine-readable report)", () => {
  it.each(MODES)("BLOCKS under --mode %s when Playwright exited 0 but wrote no stats", (mode) => {
    const { result, exitCode } = classifyRun("visual", mode, false, runOutcome(0, null));
    expect(result.status).toBe("BLOCKED");
    expect(result.executed).toBe(false);
    expect(exitCode).toBe(EVIDENCE_EXIT.PREREQ_BLOCKED);
  });

  it("is a FAIL, not a BLOCK, when the run also exited non-zero", () => {
    const { result, exitCode } = classifyRun("visual", "merge", false, runOutcome(1, null));
    expect(result.status).toBe("FAIL");
    expect(exitCode).toBe(EVIDENCE_EXIT.ASSERTIONS_FAILED);
  });
});

describe("a real regression", () => {
  const regression = runOutcome(1, { expected: 3, unexpected: 2, flaky: 0, skipped: 0 });

  it.each(MODES)("FAILS under --mode %s with the executed assertion count", (mode) => {
    const { result, exitCode } = classifyRun("e2e", mode, false, regression);
    expect(result.status).toBe("FAIL");
    expect(result.executed).toBe(true);
    expect(result.assertions).toBe(5);
    expect(exitCode).toBe(EVIDENCE_EXIT.ASSERTIONS_FAILED);
  });

  it("is reported but advisory locally (REQ-158 — pixel law must not stall ledger work)", () => {
    expect(classifyRun("e2e", "local", false, regression).exitCode).toBe(EVIDENCE_EXIT.OK);
  });

  it("fails a local --strict run", () => {
    expect(classifyRun("e2e", "local", true, regression).exitCode).toBe(EVIDENCE_EXIT.ASSERTIONS_FAILED);
  });
});

describe("a genuine green", () => {
  it("PASSES with executed=true and the real assertion count", () => {
    const { result, exitCode } = classifyRun("e2e", "merge", false, runOutcome(0, { expected: 7, unexpected: 0, flaky: 0, skipped: 0 }));
    expect(result.status).toBe("PASS");
    expect(result.executed).toBe(true);
    expect(result.assertions).toBe(7);
    expect(exitCode).toBe(EVIDENCE_EXIT.OK);
  });

  it("counts a flaky-but-eventually-passing test as executed", () => {
    const { result } = classifyRun("e2e", "merge", false, runOutcome(0, { expected: 5, unexpected: 0, flaky: 1, skipped: 0 }));
    expect(result.status).toBe("PASS");
    expect(result.assertions).toBe(6);
  });

  // §609: the label here is deliberately one with NO corpus floor. This case is about SKIP semantics — real
  // tests ran, so a skip alongside them is not a failure — and it used "e2e" only incidentally. Under the
  // floor added in §609, 2 executed against e2e's floor of 6 now FAILS, which is correct and is pinned by
  // "a partial skip below the floor FAILS" below. Keeping "e2e" here would have conflated two rules.
  it("still PASSES when some tests skipped, provided real ones executed", () => {
    const { result } = classifyRun("floorless-sample", "merge", false, runOutcome(0, { expected: 2, unexpected: 0, flaky: 0, skipped: 3 }));
    expect(result.status).toBe("PASS");
    expect(result.assertions).toBe(2);
  });
});

describe("every emitted result satisfies the promotion evidence contract", () => {
  // The binding invariant: run-gate consumes these results verbatim, and evidence.ts rejects a PASS that
  // never executed or asserted nothing. No input may produce a result that violates that.
  const outcomes: RunOutcome[] = [
    { kind: "tooling-absent", reason: "no browser" },
    runOutcome(0, null),
    runOutcome(1, null),
    runOutcome(0, { expected: 0, unexpected: 0, flaky: 0, skipped: 0 }),
    runOutcome(0, { expected: 0, unexpected: 0, flaky: 0, skipped: 9 }),
    runOutcome(1, { expected: 1, unexpected: 1, flaky: 0, skipped: 0 }),
    runOutcome(0, { expected: 4, unexpected: 0, flaky: 0, skipped: 1 }),
  ];

  it("never emits a malformed GateResult in any mode", () => {
    for (const mode of ["local", "merge", "release"] as GateMode[]) {
      for (const strict of [false, true]) {
        for (const outcome of outcomes) {
          const { result } = classifyRun("gate", mode, strict, outcome);
          expect(gateResultProblem(result), `${mode}/${String(strict)}/${outcome.kind}`).toBeNull();
        }
      }
    }
  });

  it("never emits PASS unless real tests executed", () => {
    for (const mode of ["local", "merge", "release"] as GateMode[]) {
      for (const outcome of outcomes) {
        const { result } = classifyRun("gate", mode, false, outcome);
        if (result.status === "PASS") {
          expect(result.executed).toBe(true);
          expect(result.assertions).toBeGreaterThan(0);
        }
      }
    }
  });

  it("never returns exit 0 for a non-PASS under merge or release", () => {
    // COUNT the non-PASS classifications and pin the count (audit §181). The assertion below is
    // conditional on a non-PASS, so if classifyRun ever graded EVERY outcome as PASS this test would pass
    // having checked nothing — and "the harness calls everything PASS" is precisely the failure this file
    // exists to prevent. The vacuous form cannot distinguish a correct harness from a blind one.
    let nonPass = 0;
    for (const mode of MODES) {
      for (const outcome of outcomes) {
        const { result, exitCode } = classifyRun("gate", mode, false, outcome);
        if (result.status !== "PASS") {
          nonPass++;
          expect(exitCode, `${mode}/${outcome.kind}`).not.toBe(0);
        }
      }
    }
    expect(nonPass, "classifyRun graded EVERY outcome as PASS — this assertion checked nothing").toBeGreaterThan(0);
  });
});

describe("argument parsing", () => {
  // The exact invocation pnpm produces: `pnpm test:a11y -- --mode merge` appends its own `--` separator
  // to the script's own flags. The label and the --project value are the SAME word here, which is what
  // broke a set-membership filter — it ate the label and the gate died with a usage error instead of
  // running. A gate that cannot parse its own arguments reports nothing at all.
  it("keeps the label when it collides with the --project value", () => {
    const parsed = parseArgs(["a11y", "playwright.config.ts", "--project", "a11y", "--", "--mode", "merge"]);
    expect(parsed.label).toBe("a11y");
    expect(parsed.configPath).toBe("playwright.config.ts");
    expect(parsed.project).toBe("a11y");
    expect(parsed.strict).toBe(false);
  });

  it("never mistakes a flag value for the config path", () => {
    expect(parseArgs(["perf", "packages/map/playwright.config.ts", "--mode", "release"]).configPath).toBe("packages/map/playwright.config.ts");
  });

  it("reads --strict and tolerates unknown flags", () => {
    const parsed = parseArgs(["visual", "playwright.config.ts", "--strict", "--future-flag"]);
    expect(parsed.strict).toBe(true);
    expect(parsed.configPath).toBe("playwright.config.ts");
  });

  it("reports a missing config path rather than guessing one", () => {
    expect(parseArgs(["visual"]).configPath).toBeUndefined();
  });
});

describe("parseStats reads Playwright's json report, never its prose", () => {
  it("extracts the four counters from a real report shape", () => {
    const report = JSON.stringify({
      config: { version: "1.56.0" },
      suites: [],
      errors: [],
      stats: { startTime: "2026-07-24T00:00:00.000Z", duration: 1234, expected: 6, unexpected: 1, flaky: 2, skipped: 3 },
    });
    expect(parseStats(report)).toEqual({ expected: 6, unexpected: 1, flaky: 2, skipped: 3 });
  });

  it("returns null for a report with no stats block", () => {
    expect(parseStats(JSON.stringify({ suites: [] }))).toBeNull();
  });

  it("returns null for non-numeric counters rather than coercing them to zero", () => {
    expect(parseStats(JSON.stringify({ stats: { expected: "6", unexpected: 0, flaky: 0, skipped: 0 } }))).toBeNull();
  });

  it("returns null for unparseable output (a crashed reporter must not read as an empty green)", () => {
    expect(parseStats("Error: Executable doesn't exist at /root/.cache/ms-playwright")).toBeNull();
    expect(parseStats("")).toBeNull();
  });
});

describe("stampFieldProvenance — the surfaces record row names the zone it drove (2026-08-01 review)", () => {
  const pass = { gate: "surfaces", status: "PASS", executed: true, assertions: 5, detail: "5 passed" } as const;

  it("appends the zone for the surfaces label", async () => {
    const { stampFieldProvenance } = await import("./playwright-guard.js");
    expect(stampFieldProvenance({ ...pass }, "shuddl.tech").detail).toBe("5 passed — against shuddl.tech");
  });

  it("leaves every other gate and an unset zone untouched", async () => {
    const { stampFieldProvenance } = await import("./playwright-guard.js");
    expect(stampFieldProvenance({ ...pass, gate: "a11y" }, "shuddl.tech").detail).toBe("5 passed");
    expect(stampFieldProvenance({ ...pass }, undefined).detail).toBe("5 passed");
    expect(stampFieldProvenance({ ...pass }, "").detail).toBe("5 passed");
  });
});

// REQ-118 §609 — THE CORPUS RATCHET.
//
// §607 (acceptance) and §608 (visual) were the same class in two directions: a gate whose corpus can shrink
// without the gate noticing. §609 found the third instance here, and this one had the widest blast radius —
// renaming `portal-isolation.spec.ts` out of the e2e project's testMatch produced `e2e: PASS — 3 passed` at
// exit 0 under --mode merge, retiring the browser-level proof of tenant isolation (REQ-025, CLAUDE.md rule 8)
// with nothing to show for it.
//
// The two pre-existing guards floor the suite at ZERO. That protects a suite with exactly one source of
// tests and no other — every multi-file or multi-case suite was open.
describe("REQ-118 §609: a suite that shrank does not pass", () => {
  const stats = (expected: number): RunOutcome =>
    runOutcome(0, { expected, unexpected: 0, flaky: 0, skipped: 0 });

  it("e2e at its floor passes", () => {
    const { result, exitCode } = classifyRun("e2e", "merge", false, stats(MIN_ASSERTIONS["e2e"]!));
    expect(result.status).toBe("PASS");
    expect(exitCode).toBe(0);
  });

  it("e2e one test below its floor FAILS, even with nothing red", () => {
    // The exact measured defect: 3 of 6 ran because a spec file left testMatch. Zero failures, and the old
    // ladder returned PASS.
    const { result, exitCode } = classifyRun("e2e", "merge", false, stats(MIN_ASSERTIONS["e2e"]! - 1));
    expect(result.status, "a shrunken suite must not report PASS").toBe("FAIL");
    expect(result.detail).toMatch(/below this suite's floor/);
    expect(exitCode).not.toBe(0);
  });

  it("a partial skip below the floor FAILS — a skip is not a pass, at any scale", () => {
    // The pre-existing ladder only caught ALL-skipped. Half a suite skipped reduces coverage exactly as a
    // renamed spec file does, and REQ-025's browser proof could be among the skipped half.
    const { result, exitCode } = classifyRun("e2e", "merge", false, runOutcome(0, { expected: 2, unexpected: 0, flaky: 0, skipped: 4 }));
    expect(result.status, "2 of 6 executed is not a pass merely because the other 4 were skipped").toBe("FAIL");
    expect(exitCode).not.toBe(0);
  });

  it("a suite ABOVE its floor passes — the ratchet may rise freely", () => {
    // Adding tests must never require editing this file; only shrinkage is the reviewed event.
    const { result } = classifyRun("visual", "merge", false, stats(MIN_ASSERTIONS["visual"]! + 7));
    expect(result.status).toBe("PASS");
  });

  it("every guard label used by a package script carries a floor", () => {
    // Derived from package.json rather than restated (§582): a NEW browser gate added without a floor is
    // exactly the omission this catches, and a hand-kept list here would not.
    const scripts = JSON.parse(readFileSync(`${repoRoot()}/package.json`, "utf8")).scripts as Record<string, string>;
    const labels = Object.values(scripts)
      .filter((s) => s.includes("playwright-guard.ts"))
      .map((s) => /playwright-guard\.ts\s+(\S+)/.exec(s)?.[1])
      .filter((l): l is string => l !== undefined);
    expect(labels.length, "no playwright-guard scripts found — the scan is stale, not the config").toBeGreaterThanOrEqual(4);
    // `surfaces` is release-only and returns BLOCKED before any count exists (see MIN_ASSERTIONS' comment).
    const missing = labels.filter((l) => l !== "surfaces" && MIN_ASSERTIONS[l] === undefined);
    expect(
      missing,
      `browser gate(s) with no corpus floor — the suite could shrink to one test and still report PASS:\n  ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
