import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { gatesFor, reconcileSentinel } from "./run-gate.js";
import type { GateResult } from "./evidence.js";

// 2026-08-01 audit (test-debt): runCmd preferred the LAST ##SHUDDL-GATE## sentinel found anywhere in a
// child's combined output over the child's exit code, with no consistency check. A gate that prints a PASS
// sentinel and then exits non-zero — or a wrapper gate (unit-tests captures the full output of 17 workspace
// runs) whose NESTED child emitted a PASS sentinel before the wrapper failed — recorded PASS. The rule now:
// the exit code and the sentinel must agree in direction, and where they disagree the PESSIMISTIC verdict
// wins. A sentinel may still degrade an exit-0 run (BLOCKED under --mode with a clean exit is legitimate);
// it may never upgrade a failing one.

function pass(gate: string): GateResult {
  return { gate, status: "PASS", executed: true, assertions: 5, detail: "5 passed" };
}

// Narrow `GateResult | undefined` for the cases that must produce a result — a missing one is a test failure.
function must(r: GateResult | undefined): GateResult {
  if (r === undefined) throw new Error("expected a reconciled result, got undefined");
  return r;
}

describe("reconcileSentinel — the exit code can never be out-greened by a nested sentinel", () => {
  it("exit 0 + PASS sentinel → the sentinel stands (renamed to the outer gate)", () => {
    const r = must(reconcileSentinel("unit-tests", pass("inner"), 0));
    expect(r.status).toBe("PASS");
    expect(r.gate).toBe("unit-tests");
    expect(r.assertions).toBe(5);
  });

  it("exit 1 + PASS sentinel → FAIL, never PASS — the disagreement is named in the detail", () => {
    const r = must(reconcileSentinel("unit-tests", pass("inner"), 1));
    expect(r.status).toBe("FAIL");
    expect(r.executed).toBe(true);
    expect(r.detail).toContain("exited 1");
  });

  it("exit 2 + PASS sentinel → BLOCKED, never PASS (exit 2 is a prerequisite hold)", () => {
    const r = must(reconcileSentinel("fixtures", pass("inner"), 2));
    expect(r.status).toBe("BLOCKED");
  });

  it("null exit + PASS sentinel → FAIL (a killed/timed-out child proves nothing)", () => {
    const r = must(reconcileSentinel("perf", pass("inner"), null));
    expect(r.status).toBe("FAIL");
  });

  it("a non-PASS sentinel is never upgraded by a clean exit — BLOCKED + exit 0 stays BLOCKED", () => {
    const blocked: GateResult = { gate: "identity-leak", status: "BLOCKED", executed: false, assertions: 0, detail: "no denylist" };
    const r = must(reconcileSentinel("identity-leak", blocked, 0));
    expect(r.status).toBe("BLOCKED");
  });

  it("a FAIL sentinel with a failing exit passes through untouched (they agree)", () => {
    const fail: GateResult = { gate: "e2e", status: "FAIL", executed: true, assertions: 6, detail: "1 failed" };
    const r = must(reconcileSentinel("e2e", fail, 1));
    expect(r.status).toBe("FAIL");
    expect(r.detail).toBe("1 failed");
  });

  it("no sentinel → undefined (the caller synthesizes from the exit code as before)", () => {
    expect(reconcileSentinel("lint", undefined, 0)).toBeUndefined();
  });
});

describe("gatesFor — the deployed-surface proof is part of the release record (REQ-288)", () => {
  // 2026-08-01 audit (test-debt, Low → closed iteration 2): the surfaces field gate existed only as a
  // manual runbook step, so no REQ-288 structured release record ever carried the deployed-surface
  // verdict — unlike the three other field gates (deploy-preflight, restore-verify, staging-smoke),
  // which run under the release profile and BLOCK when their environment input is absent.
  it("the release profile runs test:surfaces; the merge profile does not (it needs the public internet)", () => {
    const release = gatesFor("release");
    const surfaces = release.find((g) => g.gate === "surfaces");
    expect(surfaces).toBeDefined();
    expect(surfaces).toMatchObject({ kind: "cmd", script: "test:surfaces" });
    expect(gatesFor("merge").find((g) => g.gate === "surfaces")).toBeUndefined();
  });
});

// ── §16 (REQ-288) — the PromotionContext must be RE-OBSERVED, never copied from the record ────────────
//
// `evaluateEvidence` compares a record against a context. Its mismatch logic is real and covered in
// evidence.test.ts — but run-gate built the context out of the same four variables it had just used to
// build the record, so every comparison compared a value with itself and the SHA/environment/fixtures/
// deployment checks could never fire in the ONE live consumer. The unit tests passed throughout; the
// wiring was the defect. That is un-unit-testable from outside (main() is not exported and shells out to
// git), so this pin reads the source: the context's fields must come from the observation functions and
// the environment, NOT from `record.*` or from the variables bound before the gates ran.
describe("§16 — the release-record binding is re-observed, so the mismatch checks can actually fire", () => {
  const src = readFileSync(new URL("./run-gate.ts", import.meta.url), "utf8");
  const ctxBlock = src.slice(src.indexOf("const context: PromotionContext"), src.indexOf("const evaluation ="));

  it("the context block exists and is not empty", () => {
    expect(ctxBlock.length).toBeGreaterThan(0);
  });

  it("commit and fixturesHash are RE-READ through their observation functions", () => {
    expect(ctxBlock).toMatch(/commit:\s*gitHead\(\)/);
    expect(ctxBlock).toMatch(/fixturesHash:\s*fixturesHash\(\)/);
  });

  it("NO field is copied off the record — that is precisely what made the checks self-satisfied", () => {
    expect(ctxBlock).not.toMatch(/record\./);
  });

  it("environment and deployment are re-read from the process env, not from the pre-gate bindings", () => {
    expect(ctxBlock).toMatch(/process\.env\["RELEASE_ENVIRONMENT"\]/);
    expect(ctxBlock).toMatch(/process\.env\["DEPLOYMENT_VERSION"\]/);
  });
});
