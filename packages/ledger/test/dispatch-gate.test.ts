// REQ-043 (WP-08 T7) — PURE unit tests for the dispatch gate. Like every transition gate, assertDispatch is a
// pure decision (no D1, no Date): the DO (Task 7) loads the SERVER-SOURCED context from the read-models — a
// leg's claimed dock slot (legs.appt_slot_key, set by T5's appointment.set) AND the required carrier
// paperwork (a documents row of the dispatch-required kind) — and calls this before it appends
// dispatch.assigned. Neither fact comes from the client event: a dispatcher cannot spoof "the appointment is
// set" or "the rate-con exists".
//
// dispatch.assigned is BLOCKED until the shipment has BOTH a claimed APPOINTMENT and the required DOCS — the
// freight reality that you do not roll a driver before the stop is scheduled and the paperwork exists. The
// EXACT missing subset is emitted in a DETERMINISTIC order (appointment, then docs). GATE_BLOCKED (missing
// prerequisite), like the physical/booking gates — NOT the appointment gate's VALIDATION_FAILED. OVERRIDABLE
// (REQ-049): an accountable named+reasoned override releases the gate.
import { describe, expect, it } from "vitest";
import {
  assertDispatch,
  DISPATCH_REQUIRED_DOC_KIND,
  GateError,
  GateValidationError,
  REQUIRED_EVIDENCE,
  type DispatchCtx,
  type Override,
} from "../src/gates/transition-gates.js";

const OK_OVERRIDE: Override = { by: "dispatcher-7", reason: "rate-con on file in the partner portal; appt confirmed by phone" };

// The SERVER-SOURCED context, defaulting to "nothing present" (fail-closed); each test flips one lever.
function ctx(over: Partial<DispatchCtx> = {}): DispatchCtx {
  return { hasAppointment: false, hasDocs: false, ...over };
}

function blockedEvidence(fn: () => void): string[] {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(GateError);
    return (e as GateError).required_evidence;
  }
  throw new Error("expected the gate to throw a GateError, but it passed");
}

// =====================================================================================
describe("REQ-043 assertDispatch — dispatch blocked until BOTH appointment + docs (overridable)", () => {
  it("neither appointment nor docs → ['appointment','docs'] (deterministic order)", () => {
    expect(blockedEvidence(() => assertDispatch(ctx()))).toEqual([
      REQUIRED_EVIDENCE.appointment,
      REQUIRED_EVIDENCE.docs,
    ]);
  });

  it("appointment claimed but NO docs → ['docs'] (the exact missing subset)", () => {
    expect(blockedEvidence(() => assertDispatch(ctx({ hasAppointment: true })))).toEqual([REQUIRED_EVIDENCE.docs]);
  });

  it("docs present but NO appointment → ['appointment'] (the exact missing subset)", () => {
    expect(blockedEvidence(() => assertDispatch(ctx({ hasDocs: true })))).toEqual([REQUIRED_EVIDENCE.appointment]);
  });

  it("both present → passes", () => {
    expect(() => assertDispatch(ctx({ hasAppointment: true, hasDocs: true }))).not.toThrow();
  });

  it("a valid named override releases a missing-prereq dispatch (REQ-049)", () => {
    expect(() => assertDispatch(ctx({ override: OK_OVERRIDE }))).not.toThrow();
    // even with BOTH missing, the accountable override is honored (runs first)
    expect(() => assertDispatch(ctx({ hasAppointment: false, hasDocs: false, override: OK_OVERRIDE }))).not.toThrow();
  });

  it("a blank/unaccountable override is a VALIDATION_FAILED (never a silent pass)", () => {
    expect(() => assertDispatch(ctx({ override: { by: "  ", reason: "" } }))).toThrow(GateValidationError);
    expect(() => assertDispatch(ctx({ override: { by: "x", reason: "" } }))).toThrow(/VALIDATION_FAILED/);
  });

  it("the block is a GATE_BLOCKED envelope, not the appointment gate's VALIDATION_FAILED", () => {
    let caught: unknown;
    try {
      assertDispatch(ctx());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GateError);
    expect((caught as Error).message).toContain("GATE_BLOCKED");
    expect((caught as Error).message).not.toContain("VALIDATION_FAILED");
  });

  it("required_evidence tokens are the stable literals ['appointment','docs']", () => {
    expect(REQUIRED_EVIDENCE.appointment).toBe("appointment");
    expect(REQUIRED_EVIDENCE.docs).toBe("docs");
  });

  it("DISPATCH_REQUIRED_DOC_KIND is the shared 'ratecon' constant (a rename must fail HERE + the DO in lockstep)", () => {
    // The ONE canonical dispatch-required doc kind, imported by the DO's server-side documents read. It MUST
    // stay a member of the documents.kind CHECK in db/tenant/migrations/0002_domain.sql — this pin is the
    // canary that a rename which forgot to update the migration (or the DO) fails loudly instead of silently
    // fail-closing every dispatch.
    expect(DISPATCH_REQUIRED_DOC_KIND).toBe("ratecon");
  });
});
