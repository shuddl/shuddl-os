import { describe, expect, it } from "vitest";
import { AnswerResult, EventRef } from "../src/index.js";

// WP-10 Task 7 (REQ-038/024) — the COPILOT contract: cite-or-abstain, ENFORCED in the schema. The whole
// honesty law is that an ungrounded answer cannot even be constructed — a non-abstained answer needs ≥1
// citation, an abstention carries zero. These tests pin that boundary.

describe("EventRef — a real event handle", () => {
  it("accepts a full ref (event_id + kind + shipment_id)", () => {
    expect(EventRef.safeParse({ event_id: "evt-1", kind: "pod.signed", shipment_id: "shp-1" }).success).toBe(true);
  });

  it("accepts a ref without shipment_id (a stream-less event)", () => {
    expect(EventRef.safeParse({ event_id: "evt-1", kind: "message.received" }).success).toBe(true);
  });

  it("rejects an empty event_id (a citation must point at a real event)", () => {
    expect(EventRef.safeParse({ event_id: "", kind: "pod.signed" }).success).toBe(false);
  });

  it("rejects an extra key — the ref is .strict()", () => {
    expect(EventRef.safeParse({ event_id: "evt-1", kind: "pod.signed", forged: true }).success).toBe(false);
  });
});

describe("AnswerResult — cite-or-abstain enforced by the contract", () => {
  it("accepts a grounded answer (≥1 citation, abstained:false)", () => {
    const ok = AnswerResult.safeParse({
      text: "Shipment shp-1: latest event is pod.signed.",
      citations: [{ event_id: "evt-1", kind: "pod.signed", shipment_id: "shp-1" }],
      abstained: false,
    });
    expect(ok.success).toBe(true);
  });

  it("accepts a well-formed abstention (zero citations, abstained:true)", () => {
    expect(AnswerResult.safeParse({ text: "I can't answer that from the ledger.", citations: [], abstained: true }).success).toBe(true);
  });

  it("REJECTS a non-abstained answer with ZERO citations (a claim with no citation is a fabrication)", () => {
    expect(AnswerResult.safeParse({ text: "The invoice is paid.", citations: [], abstained: false }).success).toBe(false);
  });

  it("REJECTS an abstention that still carries citations (an abstention says nothing)", () => {
    const bad = AnswerResult.safeParse({
      text: "I can't answer that from the ledger.",
      citations: [{ event_id: "evt-1", kind: "pod.signed" }],
      abstained: true,
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an extra key — the answer is .strict()", () => {
    expect(AnswerResult.safeParse({ text: "x", citations: [{ event_id: "e", kind: "k" }], abstained: false, sources: [] }).success).toBe(false);
  });
});
