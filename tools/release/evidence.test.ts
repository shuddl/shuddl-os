import { describe, expect, it } from "vitest";
import {
  EVIDENCE_EXIT,
  EvidenceError,
  evaluateEvidence,
  gateResultProblem,
  parseMode,
  unavailableStatus,
  parseGateResults,
  formatGateResult,
  type EvidenceRecord,
  type GateResult,
  type PromotionContext,
} from "./evidence.js";

// V1 remediation Task 3 (REQ-288) — release promotion consumes ONLY complete evidence records tied to
// the exact commit / environment / fixtures / deployment, with executed assertions. A skip, a pending, an
// advisory, a stale record, or a mismatch must NEVER promote. This is the pure state machine that decides.

const NOW = "2026-07-24T00:00:00.000Z";

function passGate(gate: string, assertions = 3): GateResult {
  return { gate, status: "PASS", executed: true, assertions };
}

function baseRecord(over: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    commit: "a4acfe7bc32a7fcdd3111a32c08571862263c0f4",
    environment: "merge",
    profile: "merge",
    generatedAt: "2026-07-23T23:00:00.000Z",
    expiresAt: "2026-07-24T05:00:00.000Z",
    fixturesHash: "f".repeat(64),
    deployment: "n/a",
    gates: [passGate("typecheck"), passGate("test", 1131)],
    ...over,
  };
}

function context(over: Partial<PromotionContext> = {}): PromotionContext {
  return {
    commit: "a4acfe7bc32a7fcdd3111a32c08571862263c0f4",
    environment: "merge",
    fixturesHash: "f".repeat(64),
    deployment: "n/a",
    ...over,
  };
}

describe("gateResultProblem — a PASS must be backed by execution and assertions", () => {
  it("accepts an executed gate with assertions>0", () => {
    expect(gateResultProblem(passGate("x"))).toBeNull();
  });
  it("rejects a PASS that never executed", () => {
    expect(gateResultProblem({ gate: "x", status: "PASS", executed: false, assertions: 5 })).toMatch(/executed/);
  });
  it("rejects a PASS with zero assertions (the skip masquerading as green)", () => {
    expect(gateResultProblem({ gate: "x", status: "PASS", executed: true, assertions: 0 })).toMatch(/assertions/);
  });
  it("accepts a BLOCKED gate with no assertions", () => {
    expect(gateResultProblem({ gate: "browser", status: "BLOCKED", executed: false, assertions: 0 })).toBeNull();
  });
});

describe("evaluateEvidence — PASS only on a complete, matching, unexpired, executed record", () => {
  it("promotes a fully-executed matching record (exit 0)", () => {
    const e = evaluateEvidence(baseRecord(), context(), NOW);
    expect(e.ok).toBe(true);
    expect(e.exitCode).toBe(EVIDENCE_EXIT.OK);
    expect(e.status).toBe("PASS");
  });

  it("a BLOCKED prerequisite cannot promote (exit 2)", () => {
    const e = evaluateEvidence(
      baseRecord({ gates: [passGate("typecheck"), { gate: "identity", status: "BLOCKED", executed: false, assertions: 0, detail: "no denylist" }] }),
      context(),
      NOW,
    );
    expect(e.ok).toBe(false);
    expect(e.exitCode).toBe(EVIDENCE_EXIT.PREREQ_BLOCKED);
    expect(e.status).toBe("BLOCKED");
    expect(e.reasons.join(" ")).toMatch(/identity/);
  });

  it("a PENDING prerequisite cannot promote (exit 2)", () => {
    const e = evaluateEvidence(
      baseRecord({ gates: [passGate("typecheck"), { gate: "rater-parity", status: "PENDING", executed: false, assertions: 0 }] }),
      context(),
      NOW,
    );
    expect(e.exitCode).toBe(EVIDENCE_EXIT.PREREQ_BLOCKED);
    expect(e.status).toBe("BLOCKED");
  });

  it("an executed assertion failure exits 1 and outranks a BLOCKED sibling", () => {
    const e = evaluateEvidence(
      baseRecord({
        gates: [
          { gate: "test", status: "FAIL", executed: true, assertions: 1131, detail: "3 failing" },
          { gate: "browser", status: "BLOCKED", executed: false, assertions: 0 },
        ],
      }),
      context(),
      NOW,
    );
    expect(e.exitCode).toBe(EVIDENCE_EXIT.ASSERTIONS_FAILED);
    expect(e.status).toBe("FAIL");
  });

  it("NOT_APPLICABLE gates do not block promotion", () => {
    const e = evaluateEvidence(
      baseRecord({ gates: [passGate("typecheck"), { gate: "deploy-smoke", status: "NOT_APPLICABLE", executed: false, assertions: 0 }] }),
      context(),
      NOW,
    );
    expect(e.ok).toBe(true);
    expect(e.exitCode).toBe(EVIDENCE_EXIT.OK);
  });

  it("commit mismatch cannot promote (exit 3)", () => {
    const e = evaluateEvidence(baseRecord(), context({ commit: "deadbeef".repeat(5) }), NOW);
    expect(e.exitCode).toBe(EVIDENCE_EXIT.MALFORMED);
    expect(e.reasons.join(" ")).toMatch(/commit/);
  });

  it("environment mismatch cannot promote (exit 3)", () => {
    const e = evaluateEvidence(baseRecord(), context({ environment: "prod" }), NOW);
    expect(e.exitCode).toBe(EVIDENCE_EXIT.MALFORMED);
    expect(e.reasons.join(" ")).toMatch(/environment/);
  });

  it("fixtures-hash mismatch cannot promote (exit 3)", () => {
    const e = evaluateEvidence(baseRecord(), context({ fixturesHash: "0".repeat(64) }), NOW);
    expect(e.exitCode).toBe(EVIDENCE_EXIT.MALFORMED);
    expect(e.reasons.join(" ")).toMatch(/fixture/);
  });

  it("deployment mismatch cannot promote (exit 3)", () => {
    const e = evaluateEvidence(baseRecord({ deployment: "v99" }), context({ deployment: "v1" }), NOW);
    expect(e.exitCode).toBe(EVIDENCE_EXIT.MALFORMED);
    expect(e.reasons.join(" ")).toMatch(/deployment/);
  });

  it("expired evidence cannot promote (exit 3)", () => {
    const e = evaluateEvidence(baseRecord({ expiresAt: "2026-07-23T23:30:00.000Z" }), context(), NOW);
    expect(e.exitCode).toBe(EVIDENCE_EXIT.MALFORMED);
    expect(e.reasons.join(" ")).toMatch(/expired/);
  });

  it("a fabricated PASS (executed=false) is malformed, not a promotion (exit 3)", () => {
    const e = evaluateEvidence(
      baseRecord({ gates: [{ gate: "test", status: "PASS", executed: false, assertions: 1131 }] }),
      context(),
      NOW,
    );
    expect(e.exitCode).toBe(EVIDENCE_EXIT.MALFORMED);
  });

  it("an empty gate set is malformed (exit 3) — a record that asserted nothing proves nothing", () => {
    const e = evaluateEvidence(baseRecord({ gates: [] }), context(), NOW);
    expect(e.exitCode).toBe(EVIDENCE_EXIT.MALFORMED);
  });
});

describe("EvidenceError carries the dedicated malformed exit code", () => {
  it("uses exit 3", () => {
    expect(new EvidenceError("bad").exitCode).toBe(EVIDENCE_EXIT.MALFORMED);
  });
});

describe("parseMode / unavailableStatus — the local↔merge/release disposition", () => {
  it("defaults to local", () => {
    expect(parseMode([])).toBe("local");
  });
  it("reads --mode merge / release / local", () => {
    expect(parseMode(["--mode", "merge"])).toBe("merge");
    expect(parseMode(["--mode", "release"])).toBe("release");
    expect(parseMode(["--mode", "local"])).toBe("local");
  });
  // 2026-08-01 convergence audit — a PRESENT but unrecognized --mode is MALFORMED, never a silent
  // downgrade to advisory. The old coercion turned `--mode releas` into `local`, where every skippable
  // gate's blocked prerequisite exits 0: a typo bought a green.
  it("a typo'd or wrong-case --mode is MALFORMED — it never coerces to local", () => {
    const seen: string[] = [];
    const onMalformed = ((v: string) => {
      seen.push(v);
      return "local" as const; // stand-in for the CLI's process.exit, so the assertion can observe it
    }) as unknown as (value: string) => never;
    parseMode(["--mode", "releas"], onMalformed);
    parseMode(["--mode", "Release"], onMalformed);
    parseMode(["--mode"], onMalformed); // flag present, value missing
    expect(seen).toEqual(["releas", "Release", ""]);
  });
  it("local: an absent prerequisite is PENDING and exits 0", () => {
    expect(unavailableStatus("local")).toEqual({ status: "PENDING", exitCode: EVIDENCE_EXIT.OK });
  });
  it("merge/release: an absent prerequisite is BLOCKED and exits 2", () => {
    expect(unavailableStatus("merge")).toEqual({ status: "BLOCKED", exitCode: EVIDENCE_EXIT.PREREQ_BLOCKED });
    expect(unavailableStatus("release")).toEqual({ status: "BLOCKED", exitCode: EVIDENCE_EXIT.PREREQ_BLOCKED });
  });
});

describe("gate-result wire protocol — structured, not prose", () => {
  it("round-trips a result through the sentinel line", () => {
    const g: GateResult = { gate: "identity", status: "BLOCKED", executed: false, assertions: 0, detail: "no denylist" };
    const out = `some human log\n${formatGateResult(g)}\nmore log`;
    expect(parseGateResults(out)).toEqual([g]);
  });
  it("returns [] when no sentinel is present", () => {
    expect(parseGateResults("just prose, no machine line")).toEqual([]);
  });
});
