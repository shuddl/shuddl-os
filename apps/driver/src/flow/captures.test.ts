import { describe, expect, it } from "vitest";
import { assertConsentBeforeGps } from "@shuddl/ledger/gates/transition-gates";
import type { LedgerEvent } from "@shuddl/contracts";
import { capturesForStep } from "./captures.js";

// The gate reads only `kind` + `payload`; a minimal shape is enough to exercise it as the server would.
function asEvents(caps: ReturnType<typeof capturesForStep>): LedgerEvent[] {
  return caps.map((c) => ({ kind: c.kind, payload: c.payload }) as unknown as LedgerEvent);
}

describe("captures — consent precedes the first GPS stamp on EVERY stream (REQ-166 mirror)", () => {
  for (const kind of ["pickup", "delivery"] as const) {
    it(`${kind} arrive emits a consent doc before stop.arrived → assertConsentBeforeGps does NOT throw`, () => {
      const events = asEvents(capturesForStep(kind, "arrive", { shipmentId: "s1", ts: 1 }));
      const arrivedIdx = events.findIndex((e) => e.kind === "stop.arrived");
      expect(arrivedIdx).toBeGreaterThan(0); // a consent doc sits before the arrival stamp
      const prior = events.slice(0, arrivedIdx);
      const incoming = events[arrivedIdx];
      expect(incoming).toBeDefined();
      // "OR" mirrors SESSION_CONSENT.operating_state (Task 5 derives this from the stamp's jurisdiction).
      expect(() => assertConsentBeforeGps(prior, incoming as LedgerEvent, { operating_state: "OR" })).not.toThrow();
    });
  }

  it("WITHOUT the consent doc on the stream, the gate blocks with GATE_BLOCKED (the hole this guards)", () => {
    const events = asEvents(capturesForStep("pickup", "arrive", { shipmentId: "s1", ts: 1 }));
    const incoming = events.find((e) => e.kind === "stop.arrived");
    expect(incoming).toBeDefined();
    expect(() => assertConsentBeforeGps([], incoming as LedgerEvent, { operating_state: "OR" })).toThrow(/GATE_BLOCKED/);
  });

  it("the consent payload is EXACTLY the four strict ConsentAck fields (no id/hash/ts leaks in)", () => {
    const [consent] = capturesForStep("pickup", "arrive", { shipmentId: "s1", ts: 1 });
    expect(consent?.kind).toBe("document.attached");
    expect(Object.keys(consent?.payload ?? {}).sort()).toEqual(
      ["acknowledged", "doc_kind", "operating_state", "policy_version"],
    );
  });
});
