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
import { UNKNOWN_JURISDICTION } from "../src/geo/jurisdiction.js";
import {
  assertPickupDepart,
  assertDelivery,
  assertInterline,
  assertException,
  assertConsentBeforeGps,
  GateError,
  GateValidationError,
  REQUIRED_EVIDENCE,
  type Fence,
  type Override,
} from "../src/gates/transition-gates.js";

// A valid 64-hex hash (the contracts fixture signature hash). photo_hash / placed_photo_hash shape.
const HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
// A DISTINCT 64-hex hash — a placed photo whose hash does NOT match the POD's placed_photo_hash.
const HASH_B = "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00";
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
  // I4-valid but NOT co-signed by a device (no receiver ack), and NO receiver cosig on the payload.
  return eventFixture("custody.transferred", {
    actor: { party: "party-carrier" },
    payload: { from_party: "party-shipper", to_party: "party-carrier", unwitnessed: true },
  });
}
function custodyWithCosig(): LedgerEvent {
  // The interline ack is the RECEIVER's cosig on the payload — NOT the sender's actor.device signature.
  return eventFixture("custody.transferred", {
    payload: { from_party: "party-shipper", to_party: "party-carrier", cosig: "receiver-cosign-abc" },
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
// A GPS/geo stamp — the incoming event the consent gate guards.
function position(): LedgerEvent {
  return eventFixture("position.updated");
}
// A `document.attached` carrying a valid ConsentAck for `state` (rides the loose JsonObject kind).
function consentDoc(state: string): LedgerEvent {
  return eventFixture("document.attached", {
    payload: { doc_kind: "consent", policy_version: "loc-2026-01", operating_state: state, acknowledged: true },
  });
}
// A `document.attached` that is NOT a valid ConsentAck (unacknowledged) → must not satisfy the gate.
function consentDocUnacknowledged(state: string): LedgerEvent {
  return eventFixture("document.attached", {
    payload: { doc_kind: "consent", policy_version: "loc-2026-01", operating_state: state, acknowledged: false },
  });
}
// A `document.attached` that is a plain non-consent doc (e.g. a BOL) → must not satisfy the gate.
function nonConsentDoc(): LedgerEvent {
  return eventFixture("document.attached", { payload: { doc_kind: "bol", doc_id: "bol-1" } });
}
// A consent doc that ALSO carries a stray `doc_id` on the SAME payload object. ConsentAck is
// `.strict()`, so this superset must FAIL safeParse and NOT satisfy the gate (the load-bearing seam:
// an emitter that puts a natural id/hash INSIDE the consent payload would silently block GPS forever).
function consentDocWithExtraKey(state: string): LedgerEvent {
  return eventFixture("document.attached", {
    payload: { doc_kind: "consent", policy_version: "loc-2026-01", operating_state: state, acknowledged: true, doc_id: "doc-9" },
  });
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
// REQ-046 — the delivery gate. The placed-photo pillar is BOUND (WP-05 exit audit): the POD's
// placed_photo_hash must equal a PRIOR freight.photographed{placed}.photo_hash, not merely be 64-hex.
// `delivery()` carries placed_photo_hash === HASH, and `freightPhoto("placed")` has photo_hash === HASH,
// so the two bind. Every geofence/signature isolation case includes freightPhoto("placed") so ONLY the
// pillar under test fails.
describe("REQ-046 assertDelivery — geofence + signature + placed-freight photo bound to the POD", () => {
  const placed = () => freightPhoto("placed"); // photo_hash === HASH (matches delivery()'s placed_photo_hash)

  it("passes when arrived-in-fence + pod.signed exist AND a prior placed photo binds the POD hash", () => {
    expect(() => assertDelivery([arrived(GEO), podSigned(), placed()], delivery(), { fence: FENCE })).not.toThrow();
  });

  // §1543 (REQ-046/252/030) — THE ABSENT-FENCE REFUSAL, ON AN EVIDENCE-COMPLETE FIXTURE.
  //
  // This branch matters more than its one line suggests: in this repo `legs.geo` is written ONCE, as the literal
  // `'{}'` skeleton, and NOTHING ever updates it (audit §1543). `#deliveryFence` therefore resolves to undefined
  // for every real shipment, so this throw is what every production delivery currently meets. The authoritative
  // stop centroid is REQ-252 (V2-E scope), so the refusal is CORRECT and must stay exactly this loud — an edit
  // that "helpfully" treated an absent fence as nothing-to-check would turn a loud 400 into a silently UNGATED
  // delivery, the REQ-030 failure this gate exists to prevent.
  //
  // IT WAS ALREADY PINNED, and the first draft of this comment said otherwise — a grep for the message text
  // found nothing because `:288` asserts the throw without quoting it. What `:288` does NOT have is a clean
  // fixture: it passes `[arrived(GEO), podSigned()]` with no `placed()`, so that evidence is INCOMPLETE and the
  // gate has TWO reasons to refuse it. It survives today only because the fence check runs first. These two add
  // what that leaves open — an evidence-COMPLETE fixture, so nothing but the fence can explain the throw, and
  // the override control below, so the explanation is positively confirmed rather than merely un-contradicted.
  it("§1543 NO fence is a hard GateValidationError even when every evidence pillar is present", () => {
    expect(() => assertDelivery([arrived(GEO), podSigned(), placed()], delivery(), {})).toThrow(GateValidationError);
    expect(() => assertDelivery([arrived(GEO), podSigned(), placed()], delivery(), {})).toThrow(/ctx\.fence/);
  });

  it("§1543 …and it is the FENCE that is missing, not evidence — the same fixture passes under an override", () => {
    expect(() => assertDelivery([arrived(GEO), podSigned(), placed()], delivery(), { override: OK_OVERRIDE })).not.toThrow();
  });

  it("a stop.arrived OUTSIDE the fence blocks with ['geofence']", () => {
    const outside = arrived({ lat_e6: 37_439_000, lon_e6: -122_084_000 }); // ~2 km north of the fence
    expect(blockedEvidence(() => assertDelivery([outside, podSigned(), placed()], delivery(), { fence: FENCE })))
      .toEqual([REQUIRED_EVIDENCE.geofence]);
  });

  it("an AMBIGUOUS in-fence reading (accuracy overlaps the boundary) blocks with ['geofence']", () => {
    const ambiguous = arrived({ ...GEO, accuracy_m: 250 }); // |0 - 200| = 200 <= 250 → ambiguous
    expect(blockedEvidence(() => assertDelivery([ambiguous, podSigned(), placed()], delivery(), { fence: FENCE })))
      .toEqual([REQUIRED_EVIDENCE.geofence]);
  });

  it("a POISONED prior stop.arrived (out-of-range geo → insideFence throws) is a clean ['geofence'] block, not a crash", () => {
    // lat_e6 200_000_000 is a valid SafeInt (so it parsed into the ledger) but is out of the ±90°
    // range insideFence enforces → insideFence THROWS. The gate must fail-safe to a geofence block.
    const poisoned = arrived({ lat_e6: 200_000_000, lon_e6: 0 });
    expect(blockedEvidence(() => assertDelivery([poisoned, podSigned(), placed()], delivery(), { fence: FENCE })))
      .toEqual([REQUIRED_EVIDENCE.geofence]);
  });

  it("no stop.arrived at all blocks with ['geofence']", () => {
    expect(blockedEvidence(() => assertDelivery([podSigned(), placed()], delivery(), { fence: FENCE })))
      .toEqual([REQUIRED_EVIDENCE.geofence]);
  });

  it("blocks with ['pod.signed'] when the signature is missing", () => {
    expect(blockedEvidence(() => assertDelivery([arrived(GEO), placed()], delivery(), { fence: FENCE })))
      .toEqual([REQUIRED_EVIDENCE.pod_signed]);
  });

  // ── the placed-photo BINDING (WP-05 exit audit — a fabricated hash must not clear the pillar) ────────
  it("a FABRICATED incoming hash with NO prior placed photo blocks ['placed_freight_photo']", () => {
    // geofence + pod present; delivery() carries a real 64-hex placed_photo_hash but it is bound to NO
    // captured photo on the stream — the old bypass. It must NOT satisfy the pillar.
    expect(blockedEvidence(() => assertDelivery([arrived(GEO), podSigned()], delivery(), { fence: FENCE })))
      .toEqual([REQUIRED_EVIDENCE.placed_freight_photo]);
  });

  it("a prior placed photo with a DIFFERENT hash than the POD still blocks ['placed_freight_photo']", () => {
    const otherPlaced = eventFixture("freight.photographed", { payload: { photo_hash: HASH_B, photo_kind: "placed" } });
    // delivery()'s placed_photo_hash === HASH ≠ HASH_B → not bound.
    expect(blockedEvidence(() => assertDelivery([arrived(GEO), podSigned(), otherPlaced], delivery(), { fence: FENCE })))
      .toEqual([REQUIRED_EVIDENCE.placed_freight_photo]);
  });

  it("a prior placed photo whose hash MATCHES the POD's placed_photo_hash passes", () => {
    expect(() => assertDelivery([arrived(GEO), podSigned(), placed()], delivery(), { fence: FENCE })).not.toThrow();
  });

  it("blocks with ['placed_freight_photo'] when the POD carries no placed_photo_hash at all", () => {
    expect(blockedEvidence(() => assertDelivery([arrived(GEO), podSigned(), placed()], deliveryNoPlacedPhoto(), { fence: FENCE })))
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
describe("REQ-045 assertInterline — interline handoff needs a seal + the RECEIVER's cosig (not the sender's device)", () => {
  it("passes with a seal AND a receiver cosig on the custody payload", () => {
    // The ack is the receiver's cosig, NOT the transferring party's actor.device signature.
    expect((custodyWithCosig().payload as { cosig?: string }).cosig).toBeDefined();
    expect(() => assertInterline([sealApplied()], custodyWithCosig(), true)).not.toThrow();
  });

  it("no seal blocks with ['seal.applied']", () => {
    expect(blockedEvidence(() => assertInterline([], custodyWithCosig(), true)))
      .toEqual([REQUIRED_EVIDENCE.seal_applied]);
  });

  it("the SENDER signed (actor.device) but there is NO receiver cosig → blocks ['receiver_ack'] (the bypass)", () => {
    // custody() is device-signed BY THE SENDER but carries no cosig — REQ-045 needs the RECEIVER's ack.
    expect(custody().actor.device).toBeDefined();
    expect(blockedEvidence(() => assertInterline([sealApplied()], custody(), true)))
      .toEqual([REQUIRED_EVIDENCE.receiver_ack]);
  });

  it("a seal but an unwitnessed handoff (no cosig) blocks with ['receiver_ack']", () => {
    expect(blockedEvidence(() => assertInterline([sealApplied()], custodyUnwitnessed(), true)))
      .toEqual([REQUIRED_EVIDENCE.receiver_ack]);
  });

  it("collects the FULL missing list when neither the seal nor the cosig is present", () => {
    expect(blockedEvidence(() => assertInterline([], custodyUnwitnessed(), true)))
      .toEqual(["seal.applied", "receiver_ack"]);
  });

  it("NOT an interline handoff (isInterline === false / a consignee handoff) → the gate does not apply (no-op pass)", () => {
    expect(() => assertInterline([], custodyUnwitnessed(), false)).not.toThrow();
  });

  it("a valid override passes despite missing seal + cosig", () => {
    expect(() => assertInterline([], custodyUnwitnessed(), true, { override: OK_OVERRIDE })).not.toThrow();
  });

  // §1266 — WHY the cosig guard's `typeof` half is REDUNDANT here, pinned as a precondition rather than
  // asserted in prose. Dropping `typeof cosig === "string"` leaves this file green, and the tempting reading is
  // "the gate is blind". It is not: unlike `exception.raised`, `custody.transferred` carries a STRICTLY TYPED
  // payload, so Zod rejects a numeric cosig before the gate is ever called — the state the typeof defends
  // against is unreachable. A green mutation has two explanations and this is the other one.
  //
  // What is fragile is the PRECONDITION, not the guard. If that payload is ever loosened to a JsonObject (the
  // way `exception.raised` deliberately is), the typeof becomes load-bearing immediately — and its absence
  // would be a TypeError out of a gate instead of a refusal. This case fails the moment that assumption dies.
  it("§1266 REQ-045: the doc-10 ASYMMETRY is what decides which typeof guards can fire", () => {
    // TYPED payloads refuse the bad type before any gate runs — so their `typeof` guards defend an
    // unreachable state. Both are asserted, because both mutated GREEN and the reason must be on the record.
    expect(() =>
      eventFixture("custody.transferred", { payload: { from_party: "party-shipper", to_party: "party-carrier", cosig: 42 } }),
    ).toThrow(/expected string/);
    expect(() =>
      eventFixture("delivery.evidenced", { payload: { placed_photo_hash: [HASH], geo: { lat_e6: 1, lon_e6: 1 } } }),
    ).toThrow();
    // The LOOSE payload accepts it — which is exactly why the two `exception.raised` guards above are the only
    // ones a caller can actually reach, and the only two that were genuinely undefended.
    expect(() => exceptionRaised({ photo_hash: [HASH], reason_code: 42 })).not.toThrow();
  });

  it("a malformed override THROWS GateValidationError", () => {
    expect(() => assertInterline([sealApplied()], custodyWithCosig(), true, { override: { by: "x", reason: "" } }))
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

  // §1266 — WRONG TYPE, not merely wrong value. Every case above varies the VALUE of a string field; none
  // supplies a NON-string, so the `typeof … === "string"` half of each guard was exercised by nothing
  // (measured: dropping it from all four gate guards left this file at 56/56 GREEN).
  //
  // This payload is the one place a client controls the type. Doc 10 makes `exception.raised` a DELIBERATELY
  // loose JsonObject — the gate's own comment says its fields must be "read DEFENSIVELY off an unknown
  // payload" — so the gate is the only thing between a caller and REQ-050's evidence pillar.
  //
  // The two shapes are not interchangeable, which is why both are here:
  //   · an ARRAY holding a valid hash — `HASH64.test()` COERCES its argument, so `test([HASH])` stringifies to
  //     the hash and PASSES. Without the typeof, the exception gate clears carrying no photo hash at all.
  //   · a NUMBER where a trimmed string is expected — `.trim()` is undefined on it, so the guard THROWS a
  //     TypeError instead of blocking. A gate that 500s is not a gate that refuses (REQ-030): the caller gets
  //     a fault instead of a required-evidence list, and `blockedEvidence` fails its `instanceof GateError`.
  it("§1266 REQ-050: photo_hash as an ARRAY holding a valid hash is NOT a photo → blocks ['exception_photo']", () => {
    expect(blockedEvidence(() => assertException(exceptionRaised({ photo_hash: [HASH], reason_code: "damage" }))))
      .toEqual([REQUIRED_EVIDENCE.exception_photo]);
  });

  it("§1266 REQ-050: reason_code as a NUMBER blocks with a GateError — never a TypeError", () => {
    expect(blockedEvidence(() => assertException(exceptionRaised({ photo_hash: HASH, reason_code: 42 }))))
      .toEqual([REQUIRED_EVIDENCE.reason_code]);
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
describe("REQ-166 assertConsentBeforeGps — a GPS stamp is blocked until consent-for-this-state precedes it", () => {
  it("a position.updated with NO prior consent blocks with ['consent']", () => {
    expect(blockedEvidence(() => assertConsentBeforeGps([], position(), { operating_state: "TX" })))
      .toEqual([REQUIRED_EVIDENCE.consent]);
  });

  // REQ-166 — THE BRACES, and an honest note about the belt (audit §359).
  //
  // `assertConsentBeforeGps` blocks an UNKNOWN jurisdiction two ways: the explicit branch the source calls
  // "the belt" (`ctx.operating_state === UNKNOWN_JURISDICTION` → GateError), and the braces — `ConsentAck`
  // REFUSES to parse a payload whose `operating_state` is "XX", so no consent for an unknown jurisdiction can
  // exist to satisfy the gate in the first place.
  //
  // MEASURED (§359, and RE-MEASURED 2026-08-08 at §778 — 668 ledger / 803 api, and the belt is still the ONLY
  // one of this file's TEN `GateError` throws whose deletion is silent; the other nine red): deleting the belt
  // leaves both suites green — INCLUDING the test below, which was written to cover the belt and does not,
  // because the braces block first. The belt is therefore unreachable by any test that does not first weaken
  // `ConsentAck`, and testing it would mean asserting against a payload the schema forbids constructing.
  //
  // The redundancy is SAFE because its precondition is itself gated, which is the thing to keep true:
  // `packages/contracts/test/physical-events.test.ts` → "rejects operating_state 'XX'". That test is what
  // makes this one sufficient.
  //
  // So this pair pins the OUTCOME (an unknown jurisdiction never yields a GPS stamp) and the braces that
  // currently deliver it. **If `ConsentAck` is ever relaxed to accept "XX", the belt becomes the only guard
  // and acquires no coverage by that change** — that is the trigger to write a belt-specific test.
  it("an UNKNOWN jurisdiction never yields a GPS stamp — via the braces (ConsentAck refuses \"XX\")", () => {
    const consented = consentDoc(UNKNOWN_JURISDICTION);
    expect(blockedEvidence(() => assertConsentBeforeGps([consented], position(), { operating_state: UNKNOWN_JURISDICTION })))
      .toEqual([REQUIRED_EVIDENCE.consent]);
  });

  it("the SAME consent shape in a known state does NOT block — so the block is the jurisdiction, not the consent", () => {
    // Negative control. Without it, a gate that rejected every consent would pass the assertion above while
    // blocking every legitimate GPS stamp in the country.
    expect(() => assertConsentBeforeGps([consentDoc("TX")], position(), { operating_state: "TX" })).not.toThrow();
  });

  it("a stop.arrived with NO prior consent blocks with ['consent'] (geofence auto-arrive is a GPS stamp)", () => {
    expect(blockedEvidence(() => assertConsentBeforeGps([], arrived(GEO), { operating_state: "TX" })))
      .toEqual([REQUIRED_EVIDENCE.consent]);
  });

  it("a position.updated AFTER a matching-state consent passes", () => {
    expect(() => assertConsentBeforeGps([consentDoc("TX")], position(), { operating_state: "TX" })).not.toThrow();
  });

  it("a stop.arrived AFTER a matching-state consent passes", () => {
    expect(() => assertConsentBeforeGps([consentDoc("TX")], arrived(GEO), { operating_state: "TX" })).not.toThrow();
  });

  it("consent for a DIFFERENT operating_state does NOT cover this event → still blocks (per-state)", () => {
    expect(blockedEvidence(() => assertConsentBeforeGps([consentDoc("CA")], position(), { operating_state: "TX" })))
      .toEqual([REQUIRED_EVIDENCE.consent]);
  });

  it("a document.attached that is NOT a valid ConsentAck (acknowledged:false) does NOT satisfy → blocks", () => {
    expect(blockedEvidence(() => assertConsentBeforeGps([consentDocUnacknowledged("TX")], position(), { operating_state: "TX" })))
      .toEqual([REQUIRED_EVIDENCE.consent]);
  });

  it("a plain non-consent document.attached (a BOL) does NOT satisfy → blocks", () => {
    expect(blockedEvidence(() => assertConsentBeforeGps([nonConsentDoc()], position(), { operating_state: "TX" })))
      .toEqual([REQUIRED_EVIDENCE.consent]);
  });

  it("a consent doc with an EXTRA key (superset) fails .strict() safeParse → still blocks ['consent']", () => {
    // Locks the seam: an emitter that puts a natural doc_id/hash INSIDE the consent payload would be
    // silently rejected — proving .strict() is doing its job and that the exact-match contract holds.
    expect(blockedEvidence(() => assertConsentBeforeGps([consentDocWithExtraKey("TX")], position(), { operating_state: "TX" })))
      .toEqual([REQUIRED_EVIDENCE.consent]);
  });

  it("a non-geo incoming kind (freight.counted) is a no-op pass — consent does not gate the whole stream", () => {
    expect(() => assertConsentBeforeGps([], freightCounted(), { operating_state: "TX" })).not.toThrow();
  });

  it("a blank ctx.operating_state is a caller error → GateValidationError (not a GateError)", () => {
    expect(() => assertConsentBeforeGps([consentDoc("TX")], position(), { operating_state: "" })).toThrow(GateValidationError);
    expect(() => assertConsentBeforeGps([consentDoc("TX")], position(), { operating_state: "   " })).toThrow(/VALIDATION_FAILED/);
  });

  it("PRECEDENCE: a non-geo incoming with a BLANK operating_state does NOT throw — the scope no-op precedes the blank-state check", () => {
    expect(() => assertConsentBeforeGps([], freightCounted(), { operating_state: "" })).not.toThrow();
  });

  // WP-05 exit audit (REQ-166): an UNKNOWN jurisdiction ("XX", the fail-closed derive sentinel) can't be
  // consented — the stamp is blocked regardless of any consent on the stream.
  it("an 'XX' (unknown-jurisdiction) derived state blocks with ['consent'] even WITH a valid consent present", () => {
    expect(blockedEvidence(() => assertConsentBeforeGps([consentDoc("CA")], arrived(GEO), { operating_state: "XX" })))
      .toEqual([REQUIRED_EVIDENCE.consent]);
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
