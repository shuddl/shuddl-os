import { describe, expect, it } from "vitest";
import { GateError } from "@shuddl/ledger/gates/invoice-gate";
import { GATE_BLOCKED_PREFIX } from "@shuddl/contracts";
import { gateBlock } from "../src/booking.js";

// WP-08 T8 hardening (share-lint / I1) — the GATE_BLOCKED WIRE CONTRACT, bound producer→consumer IN-ISOLATE
// (no DO harness, no D1). The Booking agent's `gateBlock` recognizes a gate-blocked booking by the SHARED
// GATE_BLOCKED_PREFIX; the PRODUCER (`GateError`, packages/ledger) builds its message from the SAME constant.
// If the two ever drifted (a rename, a hand-edited literal), a gate-blocked booking would silently return null
// → every held booking would DLQ-loop instead of holding for ops. Binding the real producer to the real
// consumer here pins that contract WITHOUT relying on the DO to reproduce the RPC serialization — so a regression
// is caught by a millisecond unit test, not only by the full DO+D1 integration suite.
describe("Booking agent — the GATE_BLOCKED wire contract (producer ⇄ consumer, in-isolate)", () => {
  it("gateBlock parses a real GateError's message → its required_evidence (the producer's format IS the consumer's)", () => {
    expect(gateBlock(new GateError(["credit_clear"]))).toEqual(["credit_clear"]);
    expect(gateBlock(new GateError(["evidence_recipient"]))).toEqual(["evidence_recipient"]);
    expect(gateBlock(new GateError(["credit_clear", "evidence_recipient"]))).toEqual(["credit_clear", "evidence_recipient"]);
  });

  it("the producer builds its message from the SHARED prefix (drift from ErrorCode would break both sides)", () => {
    expect(new GateError(["credit_clear"]).message.startsWith(GATE_BLOCKED_PREFIX)).toBe(true);
    // The exact wire bytes the DO re-emits verbatim across the RPC hop.
    expect(new GateError(["credit_clear"]).message).toBe(`${GATE_BLOCKED_PREFIX}${JSON.stringify({ required_evidence: ["credit_clear"] })}`);
  });

  it("a NON-gate error → null (the agent re-throws for redelivery, never swallows it as held)", () => {
    expect(gateBlock(new Error("boom"))).toBeNull(); // a transient/unexpected fault
    expect(gateBlock(new Error("VALIDATION_FAILED:{}"))).toBeNull(); // a different DO refusal (an agent bug) → DLQ, not held
    expect(gateBlock(new Error("FORBIDDEN:{}"))).toBeNull();
    expect(gateBlock("not an error")).toBeNull();
    expect(gateBlock(undefined)).toBeNull();
  });

  it("a GATE_BLOCKED message with a malformed json tail → [] (a gate block with no token, still a block not a throw)", () => {
    expect(gateBlock(new Error(`${GATE_BLOCKED_PREFIX}not json`))).toEqual([]);
  });
});
