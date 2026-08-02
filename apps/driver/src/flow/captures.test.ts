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

// The POD heartbeat at the FLOW layer (WP-05 Task 9, REQ-046): the delivery flow's terminal step
// (`delivered`) must emit the `delivery.evidenced` POD carrying the forced placed-freight photo hash
// (threaded from photo_placed via CaptureContext.placedPhotoHash) + the arrival geo — the single event
// the Biller (WP-06) later projects to invoice.issued + the consignee evidence email. WP-05 proves the
// POD FIRES with its evidence bundle; the money + <5s email is WP-06 and is NOT emitted here.
describe("captures — the delivery terminal fires the POD (delivery.evidenced) with placed hash + geo (REQ-046)", () => {
  const PLACED_HASH = "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00";
  // The arrival geo threaded into the POD. Task 11 removed the hardcoded MOCK_GEO — geo now comes from
  // CaptureContext.geo (GatedFlow's foreground watchPosition fix), so the test SUPPLIES it and asserts it
  // flows through verbatim. A regression that dropped/zeroed the geo still fails — the POD's whole semantic
  // is WHERE it was left. WP-05 fires ONLY this POD; the invoice + email is the Biller (WP-06).
  const ARRIVAL_GEO = { lat_e6: 45_523_100, lon_e6: -122_676_500, accuracy_m: 5 };

  it("`delivered` emits EXACTLY the delivery.evidenced POD with the threaded placed_photo_hash + arrival geo", () => {
    const caps = capturesForStep("delivery", "delivered", { shipmentId: "s1", ts: 1, geo: ARRIVAL_GEO, placedPhotoHash: PLACED_HASH });
    expect(caps).toHaveLength(1); // the flow-layer WP-06 boundary: ONE event, the POD — no invoice, no email
    const pod = caps[0];
    expect(pod?.kind).toBe("delivery.evidenced");
    expect(pod?.payload.placed_photo_hash).toBe(PLACED_HASH); // the forced placed photo (REQ-063), not re-hashed
    expect(pod?.payload.geo).toEqual(ARRIVAL_GEO); // exact coordinate — where it was left
  });

  it("emits NOTHING (never a schema-invalid POD) if the placed photo somehow never threaded through", () => {
    // The photo is FORCED upstream (photo_placed is untypassable), so this is defensive: absent the
    // placed hash the terminal emits no event rather than a delivery.evidenced missing its required field.
    expect(capturesForStep("delivery", "delivered", { shipmentId: "s1", ts: 1 })).toEqual([]);
  });
});

// 2026-08-01 convergence audit — the fabrication cluster is CLOSED and pinned: a hardcoded pieces:6 was
// recorded on every real pickup, dims were a fixed 48x40x36, and custody/POD named fictional parties
// (u:driver / p:shipper / p:carrier). Physical facts now arrive through CaptureContext or the capture
// THROWS (the geo precedent: absence never fabricates).
describe("captures — physical facts are never fabricated (CAPTURE_INPUT_MISSING fail-closed)", () => {
  const GEO = { lat_e6: 45_523_100, lon_e6: -122_676_500, accuracy_m: 5 };

  it("count records the REAL entered pieces and refuses to build without them", () => {
    const caps = capturesForStep("pickup", "count", { shipmentId: "s1", ts: 1, pieces: 4 });
    expect(caps).toHaveLength(1);
    expect(caps[0]?.payload).toEqual({ pieces: 4 });
    expect(() => capturesForStep("pickup", "count", { shipmentId: "s1", ts: 1 })).toThrow(/CAPTURE_INPUT_MISSING/);
  });

  it("dims refuses to build without real measurements (latent V2 lane — fail-closed, not fabricated)", () => {
    expect(() => capturesForStep("pickup", "dims", { shipmentId: "s1", ts: 1 })).toThrow(/CAPTURE_INPUT_MISSING/);
    const caps = capturesForStep("pickup", "dims", { shipmentId: "s1", ts: 1, dims: { l_in: 40, w_in: 30, h_in: 20, pieces: 2 } });
    expect(caps[0]?.payload).toEqual({ l_in: 40, w_in: 30, h_in: 20, pieces: 2, method: "manual" });
  });

  it("pickup custody carries the REAL party pair + authenticated driver, and refuses their absence", () => {
    const [c] = capturesForStep("pickup", "sign", {
      shipmentId: "s1", ts: 1, geo: GEO, driverUserId: "u-d1",
      custodyParties: { from: "p-real-shipper", to: "p-real-carrier" },
    });
    expect(c?.kind).toBe("custody.transferred");
    expect(c?.actor_user).toBe("u-d1");
    expect(c?.payload.from_party).toBe("p-real-shipper");
    expect(c?.payload.to_party).toBe("p-real-carrier");
    expect(() => capturesForStep("pickup", "sign", { shipmentId: "s1", ts: 1, geo: GEO, driverUserId: "u-d1" })).toThrow(/CAPTURE_INPUT_MISSING/);
  });

  it("pod.signed's actor is the authenticated driver, never a constant", () => {
    const [pod] = capturesForStep("delivery", "sign", { shipmentId: "s1", ts: 1, geo: GEO, driverUserId: "u-d1" });
    expect(pod?.kind).toBe("pod.signed");
    expect(pod?.actor_user).toBe("u-d1");
    expect(() => capturesForStep("delivery", "sign", { shipmentId: "s1", ts: 1, geo: GEO })).toThrow(/CAPTURE_INPUT_MISSING/);
  });
});
