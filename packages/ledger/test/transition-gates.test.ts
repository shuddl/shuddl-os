// REQ-007/044/045/046/049/050 — the Gatekeeper transition gates (WP-05 Task 3).
//
// These evaluators are PURE (no D1, no Date, no random): they decide a transition from the stream's
// prior events + the incoming event. So this suite needs no `cloudflare:test` D1 harness — it builds
// LedgerEvents with the deterministic `eventFixture` and asserts the decision directly.
//
// The server-side truth (REQ-030): a UI cannot bypass these; Task 5 loads `prior` from D1 and calls
// them inside the sequencer before it appends `incoming`. Here we prove each gate blocks with the
// EXACT required_evidence, passes on complete evidence, and honors a named+reasoned override.
import { describe, expect, it } from "vitest";
import { eventFixture, type LedgerEvent, type JsonValue } from "@shuddl/contracts";
import {
  assertPickupDepart,
  assertDelivery,
  assertInterline,
  assertException,
  GateError,
  GateValidationError,
  REQUIRED_EVIDENCE,
  type Fence,
  type Override,
} from "../src/gates/transition-gates.js";

// A valid 64-hex hash (the contracts fixture signature hash). photo_hash / placed_photo_hash shape.
const HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const GEO = { lat_e6: 37_421_000, lon_e6: -122_084_000 };
const FENCE: Fence = { lat_e6: 37_421_000, lon_e6: -122_084_000, radius_m: 200 };
const OK_OVERRIDE: Override = { by: "dispatcher-42", reason: "shipper waived the recount at the dock" };

// ---- event builders (deterministic; wrappers over eventFixture) ----
function freightCounted(): LedgerEvent {
  return eventFixture("freight.counted", { payload: { pieces: 12 } });
}
function freightPhoto(kind: "freight" | "placed"): LedgerEvent {
  return eventFixture("freight.photographed", { payload: { photo_hash: HASH, photo_kind: kind } });
}
function custody(): LedgerEvent {
  // co-signed (actor.device present via the fixture actor for custody events).
  return eventFixture("custody.transferred", {
    payload: { from_party: "party-shipper", to_party: "party-carrier" },
  });
}
function custodyUnwitnessed(): LedgerEvent {
  // I4-valid but NOT co-signed by a device (no receiver ack).
  return eventFixture("custody.transferred", {
    actor: { party: "party-carrier" },
    payload: { from_party: "party-shipper", to_party: "party-carrier", unwitnessed: true },
  });
}
function dims(): LedgerEvent {
  return eventFixture("dims.captured");
}
function pickupDepart(): LedgerEvent {
  return eventFixture("stop.departed");
}
function arrived(geo: { lat_e6: number; lon_e6: number; accuracy_m?: number }): LedgerEvent {
  return eventFixture("stop.arrived", { payload: { geo, auto: true } });
}
function podSigned(): LedgerEvent {
  return eventFixture("pod.signed");
}
function delivery(): LedgerEvent {
  return eventFixture("delivery.evidenced");
}
// A delivery.evidenced whose payload lacks placed_photo_hash — the schema normally forces it, so we
// build it raw + cast to drive the gate's DEFENSIVE branch (incoming placed photo NOT present, so
// only a prior freight.photographed{placed} can satisfy the placed-photo requirement).
function deliveryNoPlacedPhoto(): LedgerEvent {
  const base = delivery();
  const geo = (base.payload as { geo: unknown }).geo;
  return { ...base, payload: { geo } } as unknown as LedgerEvent;
}
function sealApplied(): LedgerEvent {
  return eventFixture("seal.applied");
}
function osd(): LedgerEvent {
  return eventFixture("osd.captured");
}
function exceptionRaised(payload: Record<string, JsonValue>): LedgerEvent {
  return eventFixture("exception.raised", { payload });
}

// Helper: run a gate and return the required_evidence of the thrown GateError (fails if it did NOT throw a GateError).
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
describe("REQ-044 assertPickupDepart — pickup departure needs count + freight photo + custody (+dims)", () => {
  const full = () => [freightCounted(), freightPhoto("freight"), custody()];

  it("passes when count + freight photo + custody are all present", () => {
    expect(() => assertPickupDepart(full(), pickupDepart())).not.toThrow();
  });

  it("blocks with ['freight.counted'] when only the count is missing", () => {
    expect(blockedEvidence(() => assertPickupDepart([freightPhoto("freight"), custody()], pickupDepart())))
      .toEqual([REQUIRED_EVIDENCE.freight_counted]);
  });

  it("blocks with ['freight.photographed'] when the freight photo is missing", () => {
    expect(blockedEvidence(() => assertPickupDepart([freightCounted(), custody()], pickupDepart())))
      .toEqual([REQUIRED_EVIDENCE.freight_photo]);
  });

  it("a PLACED photo does not satisfy the pickup gate — still blocks ['freight.photographed']", () => {
    expect(blockedEvidence(() => assertPickupDepart([freightCounted(), freightPhoto("placed"), custody()], pickupDepart())))
      .toEqual([REQUIRED_EVIDENCE.freight_photo]);
  });

  it("blocks with ['custody.transferred'] when the handoff is missing", () => {
    expect(blockedEvidence(() => assertPickupDepart([freightCounted(), freightPhoto("freight")], pickupDepart())))
      .toEqual([REQUIRED_EVIDENCE.custody_transferred]);
  });

  it("collects the FULL missing list when nothing is present", () => {
    expect(blockedEvidence(() => assertPickupDepart([], pickupDepart())))
      .toEqual(["freight.counted", "freight.photographed", "custody.transferred"]);
  });

  it("dimsRequired adds dims.captured to the required set", () => {
    expect(blockedEvidence(() => assertPickupDepart(full(), pickupDepart(), { dimsRequired: true })))
      .toEqual([REQUIRED_EVIDENCE.dims_captured]);
    // present → passes
    expect(() => assertPickupDepart([...full(), dims()], pickupDepart(), { dimsRequired: true })).not.toThrow();
    // all-missing WITH dims required → full four-item list, dims last
    expect(blockedEvidence(() => assertPickupDepart([], pickupDepart(), { dimsRequired: true })))
      .toEqual(["freight.counted", "freight.photographed", "custody.transferred", "dims.captured"]);
  });

  it("a valid override passes despite all evidence missing (REQ-049)", () => {
    expect(() => assertPickupDepart([], pickupDepart(), { override: OK_OVERRIDE })).not.toThrow();
  });

  it("a malformed override (empty reason / empty by) THROWS GateValidationError — an override must be named + reasoned", () => {
    expect(() => assertPickupDepart(full(), pickupDepart(), { override: { by: "x", reason: "" } })).toThrow(GateValidationError);
    expect(() => assertPickupDepart(full(), pickupDepart(), { override: { by: "x", reason: "" } })).toThrow(/VALIDATION_FAILED/);
    expect(() => assertPickupDepart(full(), pickupDepart(), { override: { by: "  ", reason: "y" } })).toThrow(/VALIDATION_FAILED/);
  });
});

// =====================================================================================
describe("REQ-046 assertDelivery — geofence + signature + placed-freight photo", () => {
  it("passes when arrived-in-fence + pod.signed exist and the incoming carries the placed photo", () => {
    expect(() => assertDelivery([arrived(GEO), podSigned()], delivery(), { fence: FENCE })).not.toThrow();
  });

  it("a stop.arrived OUTSIDE the fence blocks with ['geofence']", () => {
    const outside = arrived({ lat_e6: 37_439_000, lon_e6: -122_084_000 }); // ~2 km north of the fence
    expect(blockedEvidence(() => assertDelivery([outside, podSigned()], delivery(), { fence: FENCE })))
      .toEqual([REQUIRED_EVIDENCE.geofence]);
  });

  it("an AMBIGUOUS in-fence reading (accuracy overlaps the boundary) blocks with ['geofence']", () => {
    const ambiguous = arrived({ ...GEO, accuracy_m: 250 }); // |0 - 200| = 200 <= 250 → ambiguous
    expect(blockedEvidence(() => assertDelivery([ambiguous, podSigned()], delivery(), { fence: FENCE })))
      .toEqual([REQUIRED_EVIDENCE.geofence]);
  });

  it("a POISONED prior stop.arrived (out-of-range geo → insideFence throws) is a clean ['geofence'] block, not a crash", () => {
    // lat_e6 200_000_000 is a valid SafeInt (so it parsed into the ledger) but is out of the ±90°
    // range insideFence enforces → insideFence THROWS. The gate must fail-safe to a geofence block.
    const poisoned = arrived({ lat_e6: 200_000_000, lon_e6: 0 });
    expect(blockedEvidence(() => assertDelivery([poisoned, podSigned()], delivery(), { fence: FENCE })))
      .toEqual([REQUIRED_EVIDENCE.geofence]);
  });

  it("no stop.arrived at all blocks with ['geofence']", () => {
    expect(blockedEvidence(() => assertDelivery([podSigned()], delivery(), { fence: FENCE })))
      .toEqual([REQUIRED_EVIDENCE.geofence]);
  });

  it("blocks with ['pod.signed'] when the signature is missing", () => {
    expect(blockedEvidence(() => assertDelivery([arrived(GEO)], delivery(), { fence: FENCE })))
      .toEqual([REQUIRED_EVIDENCE.pod_signed]);
  });

  it("placed photo satisfied by the INCOMING payload (default delivery.evidenced carries it)", () => {
    expect(() => assertDelivery([arrived(GEO), podSigned()], delivery(), { fence: FENCE })).not.toThrow();
  });

  it("placed photo satisfied by a PRIOR freight.photographed{placed} when the incoming lacks it", () => {
    const prior = [arrived(GEO), podSigned(), freightPhoto("placed")];
    expect(() => assertDelivery(prior, deliveryNoPlacedPhoto(), { fence: FENCE })).not.toThrow();
  });

  it("blocks with ['placed_freight_photo'] when neither the incoming nor a prior placed photo exists", () => {
    expect(blockedEvidence(() => assertDelivery([arrived(GEO), podSigned()], deliveryNoPlacedPhoto(), { fence: FENCE })))
      .toEqual([REQUIRED_EVIDENCE.placed_freight_photo]);
  });

  it("collects the FULL missing list (geofence, pod.signed, placed_freight_photo) when nothing is present", () => {
    expect(blockedEvidence(() => assertDelivery([], deliveryNoPlacedPhoto(), { fence: FENCE })))
      .toEqual(["geofence", "pod.signed", "placed_freight_photo"]);
  });

  it("a valid override passes despite everything missing — and without needing a fence", () => {
    expect(() => assertDelivery([], deliveryNoPlacedPhoto(), { override: OK_OVERRIDE })).not.toThrow();
  });

  it("a malformed override THROWS GateValidationError", () => {
    expect(() => assertDelivery([arrived(GEO), podSigned()], delivery(), { fence: FENCE, override: { by: "", reason: "z" } }))
      .toThrow(/VALIDATION_FAILED/);
  });

  it("a missing fence with no override is a loud caller error (GateValidationError, not a silent pass)", () => {
    expect(() => assertDelivery([arrived(GEO), podSigned()], delivery(), {})).toThrow(GateValidationError);
    expect(() => assertDelivery([arrived(GEO), podSigned()], delivery(), {})).toThrow(/ctx\.fence/);
  });
});

// =====================================================================================
describe("REQ-045 assertInterline — interline handoff needs a seal + a co-signed (device) receiver ack", () => {
  it("passes with a seal AND a co-signed custody transfer", () => {
    // Guard the fixture assumption the receiver-ack check depends on: custody() must be device-signed.
    expect(custody().actor.device).toBeDefined();
    expect(() => assertInterline([sealApplied()], custody(), true)).not.toThrow();
  });

  it("no seal blocks with ['seal.applied']", () => {
    expect(blockedEvidence(() => assertInterline([], custody(), true)))
      .toEqual([REQUIRED_EVIDENCE.seal_applied]);
  });

  it("a seal but NOT co-signed (unwitnessed handoff) blocks with ['receiver_ack']", () => {
    expect(blockedEvidence(() => assertInterline([sealApplied()], custodyUnwitnessed(), true)))
      .toEqual([REQUIRED_EVIDENCE.receiver_ack]);
  });

  it("collects the FULL missing list when neither the seal nor the ack is present", () => {
    expect(blockedEvidence(() => assertInterline([], custodyUnwitnessed(), true)))
      .toEqual(["seal.applied", "receiver_ack"]);
  });

  it("NOT an interline handoff (isInterline === false / a consignee handoff) → the gate does not apply (no-op pass)", () => {
    expect(() => assertInterline([], custodyUnwitnessed(), false)).not.toThrow();
  });

  it("a valid override passes despite missing seal + ack", () => {
    expect(() => assertInterline([], custodyUnwitnessed(), true, { override: OK_OVERRIDE })).not.toThrow();
  });

  it("a malformed override THROWS GateValidationError", () => {
    expect(() => assertInterline([sealApplied()], custody(), true, { override: { by: "x", reason: "" } }))
      .toThrow(/VALIDATION_FAILED/);
  });
});

// =====================================================================================
describe("REQ-050 assertException — an exception/OS&D needs a photo + a reason code", () => {
  it("osd.captured (typed) with photo + reason passes", () => {
    expect(() => assertException(osd())).not.toThrow();
  });

  it("exception.raised (loose payload) with a valid photo_hash + reason_code passes", () => {
    expect(() => assertException(exceptionRaised({ photo_hash: HASH, reason_code: "lumper_dispute" }))).not.toThrow();
  });

  it("a loose exception.raised with NEITHER photo nor reason blocks ['exception_photo','reason_code']", () => {
    expect(blockedEvidence(() => assertException(exceptionRaised({}))))
      .toEqual([REQUIRED_EVIDENCE.exception_photo, REQUIRED_EVIDENCE.reason_code]);
  });

  it("missing photo only blocks ['exception_photo']", () => {
    expect(blockedEvidence(() => assertException(exceptionRaised({ reason_code: "damage" }))))
      .toEqual([REQUIRED_EVIDENCE.exception_photo]);
  });

  it("missing reason only blocks ['reason_code']", () => {
    expect(blockedEvidence(() => assertException(exceptionRaised({ photo_hash: HASH }))))
      .toEqual([REQUIRED_EVIDENCE.reason_code]);
  });

  it("a photo_hash that is not 64-hex is treated as no photo → blocks ['exception_photo']", () => {
    expect(blockedEvidence(() => assertException(exceptionRaised({ photo_hash: "not-a-hash", reason_code: "damage" }))))
      .toEqual([REQUIRED_EVIDENCE.exception_photo]);
  });

  it("a whitespace-only reason_code is treated as no reason → blocks ['reason_code']", () => {
    expect(blockedEvidence(() => assertException(exceptionRaised({ photo_hash: HASH, reason_code: "   " }))))
      .toEqual([REQUIRED_EVIDENCE.reason_code]);
  });

  it("a valid override passes despite missing photo + reason", () => {
    expect(() => assertException(exceptionRaised({}), { override: OK_OVERRIDE })).not.toThrow();
  });

  it("a malformed override THROWS GateValidationError", () => {
    expect(() => assertException(exceptionRaised({}), { override: { by: "x", reason: "" } })).toThrow(/VALIDATION_FAILED/);
  });
});

// =====================================================================================
describe("error envelopes — RPC-safe CODE:{json} messages, reused not redefined", () => {
  it("GateError carries required_evidence AND encodes it into the message (GATE_BLOCKED:{json})", () => {
    let caught: unknown;
    try {
      assertPickupDepart([], pickupDepart());
    } catch (e) {
      caught = e;
    }
    const err = caught as GateError;
    expect(err.name).toBe("GateError");
    expect(err.required_evidence).toEqual(["freight.counted", "freight.photographed", "custody.transferred"]);
    expect(err.message).toBe(
      'GATE_BLOCKED:{"required_evidence":["freight.counted","freight.photographed","custody.transferred"]}',
    );
  });

  it("GateValidationError is a DISTINCT envelope (VALIDATION_FAILED:{json}), not a GateError", () => {
    let caught: unknown;
    try {
      assertDelivery([], delivery(), { override: { by: "", reason: "" } });
    } catch (e) {
      caught = e;
    }
    const err = caught as GateValidationError;
    expect(err).toBeInstanceOf(GateValidationError);
    expect(err).not.toBeInstanceOf(GateError);
    expect(err.name).toBe("GateValidationError");
    expect(err.message.startsWith("VALIDATION_FAILED:")).toBe(true);
    expect(JSON.parse(err.message.slice("VALIDATION_FAILED:".length))).toEqual({ reason: err.detail });
  });
});
