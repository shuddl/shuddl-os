// REQ-007/044/045/046/049/050 — the Gatekeeper transition-gate catalog (WP-05 Task 3).
//
// L7 evaluators that BLOCK a physical transition until its required evidence is on the stream. Each
// is a PURE, deterministic decision over (the stream's prior events, the incoming event, a context):
// no D1, no R2, no Date, no random, no LLM (REQ-024). Task 5 loads `prior` from D1 and calls these
// inside the sequencer BEFORE it appends `incoming` — that is where REQ-030 lives (a UI cannot
// bypass the gate; it is enforced in the ledger, and every API path that reaches the transition hits
// the same check). Keeping the decision pure here is what makes it exhaustively unit-testable.
//
// Two error envelopes, both encoded into Error.message as `CODE:{json}` so the machine-readable
// detail survives the Durable Object → Workers RPC hop (which preserves only Error.name + message):
//   - GateError            → GATE_BLOCKED:{required_evidence}   (evidence missing; maps to a 4xx gate block)
//   - GateValidationError  → VALIDATION_FAILED:{reason}         (malformed caller input; maps to a 400)
// Both codes are members of the contracts ErrorCode enum (packages/contracts/src/errors.ts), and the
// {reason} envelope shape matches the sequencer's own rpcError (workers/api/src/do/sequencer.ts).
//
// OVERRIDE PERSISTENCE (REQ-049): this task proves the gate HONORS a valid named+reasoned override
// (passes) and BLOCKS without one. Making the override permanently visible — recording the
// {by, reason} onto the appended event so the ledger carries who overrode what and why — is wired in
// Task 5 (the sequencer stamps the override on the event it writes). Task 3 is only the pure decision.
import { ConsentAck, type LedgerEvent } from "@shuddl/contracts";
import { GateError } from "./invoice-gate.js";
import { insideFence, type Fence } from "../geo/fence.js";

// Re-exported so a caller (Task 5) can import the one canonical GateError + Fence from this module.
export { GateError };
export type { Fence };

/**
 * The single enumerated vocabulary of evidence tokens the gates emit in `required_evidence`. Task 5
 * (server) and Task 8 (driver PWA) import THIS — a typo becomes a compile error instead of silent
 * drift between the gate and the UI that renders the missing-evidence checklist. Some tokens equal an
 * event-kind string (`freight.counted`), others are abstract requirements (`geofence`, `receiver_ack`).
 */
export const REQUIRED_EVIDENCE = {
  freight_counted: "freight.counted",
  freight_photo: "freight.photographed",
  custody_transferred: "custody.transferred",
  dims_captured: "dims.captured",
  geofence: "geofence",
  pod_signed: "pod.signed",
  placed_freight_photo: "placed_freight_photo",
  seal_applied: "seal.applied",
  receiver_ack: "receiver_ack",
  exception_photo: "exception_photo",
  reason_code: "reason_code",
  consent: "consent",
} as const;
export type RequiredEvidence = (typeof REQUIRED_EVIDENCE)[keyof typeof REQUIRED_EVIDENCE];

/**
 * A malformed-caller-input error (VALIDATION_FAILED), NOT a gate block. Mirrors GateError's
 * RPC-safe envelope so Task 5 maps it to a clean 400 across the DO→Workers hop instead of a 500. Used
 * for an unaccountable override and a delivery gate called without its required fence.
 */
export class GateValidationError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(`VALIDATION_FAILED:${JSON.stringify({ reason: detail })}`);
    this.name = "GateValidationError";
    this.detail = detail;
  }
}

/** A named, reasoned gate override (REQ-049): who is overriding and why. Both are load-bearing —
 *  an accountable override is the only thing that lets a transition proceed without its evidence. */
export interface Override {
  by: string;
  reason: string;
}

/**
 * Per-transition context supplied by the Task-5 caller (from tenant config / lane policy):
 * - `fence`: the delivery geofence (REQUIRED by assertDelivery; ignored elsewhere).
 * - `override`: a named+reasoned override that passes the gate despite missing evidence (REQ-049).
 * - `dimsRequired`: whether the pickup gate must also see a dims.captured. OPTIONAL by design —
 *   omitting it means "this lane is not dims-fitted", a low-blast-radius default (a missing dims
 *   requirement cannot let freight leave un-counted/-photographed/-in-custody). Contrast the
 *   interline determination, which is a REQUIRED positional on assertInterline (fail-loud, not
 *   fail-open) because forgetting it would skip the seal + receiver-ack gate entirely.
 */
export interface GateCtx {
  fence?: Fence;
  override?: Override;
  dimsRequired?: boolean;
}

// Mirrors the contracts Hash64 (a 64-char lowercase hex content hash) without importing the Zod
// schema into this pure evaluator — the exception gate defensively hash-checks a loose payload.
const HASH64 = /^[0-9a-f]{64}$/;

/**
 * Override gate (REQ-049), applied uniformly by every transition gate BEFORE its evidence check:
 * - no override present            → returns false (fall through to the evidence check);
 * - a valid (named + reasoned) one → returns true  (the gate passes, evidence notwithstanding);
 * - a malformed one (blank by/reason) → THROWS GateValidationError. An override that is present but
 *   not accountable is never silently ignored and never silently accepted — an anonymous or
 *   unreasoned override would defeat the whole point of a named, logged override.
 */
function overrideSatisfies(override: Override | undefined): boolean {
  if (override === undefined) return false;
  const named = override.by.trim().length > 0;
  const reasoned = override.reason.trim().length > 0;
  if (!named || !reasoned) {
    throw new GateValidationError("a REQ-049 gate override requires a named `by` and a non-empty `reason`");
  }
  return true;
}

/** Read a key off a payload of unknown shape without assuming an object (defensive parse). */
function readField(payload: unknown, key: string): unknown {
  if (payload !== null && typeof payload === "object") {
    return (payload as Record<string, unknown>)[key];
  }
  return undefined;
}

/**
 * REQ-044 — a PICKUP departure (`incoming` = the pickup `stop.departed`) is blocked until the stream
 * has captured the loaded freight: a `freight.counted`, a `freight.photographed` of the freight
 * itself (`photo_kind === "freight"`, not a placed-delivery photo), a `custody.transferred` (the
 * shipper→driver handoff), and — only when the lane/tenant requires it (`ctx.dimsRequired`) — a
 * `dims.captured`. ALL missing kinds are collected into required_evidence (the driver sees the full
 * checklist, not one item at a time).
 *
 * `incoming` (the departure being attempted) carries none of the evidence — it is the transition
 * being gated — so it is a reserved parameter here, kept for a uniform gate signature.
 */
export function assertPickupDepart(
  prior: readonly LedgerEvent[],
  _incoming: LedgerEvent,
  ctx?: GateCtx,
): void {
  if (overrideSatisfies(ctx?.override)) return;

  const missing: RequiredEvidence[] = [];
  if (!prior.some((e) => e.kind === "freight.counted")) missing.push(REQUIRED_EVIDENCE.freight_counted);
  if (!prior.some((e) => e.kind === "freight.photographed" && e.payload.photo_kind === "freight")) {
    missing.push(REQUIRED_EVIDENCE.freight_photo);
  }
  if (!prior.some((e) => e.kind === "custody.transferred")) missing.push(REQUIRED_EVIDENCE.custody_transferred);
  if (ctx?.dimsRequired === true && !prior.some((e) => e.kind === "dims.captured")) {
    missing.push(REQUIRED_EVIDENCE.dims_captured);
  }
  if (missing.length > 0) throw new GateError(missing);
}

/**
 * REQ-046 — a DELIVERY (`incoming` = `delivery.evidenced`) is blocked until three things hold:
 *   (a) GEOFENCE: some prior `stop.arrived` sits cleanly inside the delivery fence —
 *       `insideFence(geo, fence).inside && !ambiguous`. A reading outside the fence, one whose own
 *       GPS accuracy overlaps the boundary (ambiguous, REQ-065), or one whose geo is so poisoned that
 *       `insideFence` THROWS (an out-of-range coord that still parsed as a SafeInt) does NOT clear the
 *       gate → `geofence`. The throw is caught here so a bad stored geo is a clean block, not an
 *       opaque crash of the whole append.
 *   (b) SIGNATURE: a prior `pod.signed` exists → else `pod.signed`.
 *   (c) PLACED PHOTO: the forced placed-freight photo (REQ-063) exists — either the incoming
 *       `delivery.evidenced.payload.placed_photo_hash`, OR a prior `freight.photographed{placed}` →
 *       else `placed_freight_photo`. (The incoming placed_photo_hash is read DEFENSIVELY: absent =
 *       "no incoming photo", so the prior-photo path can still satisfy (c).)
 *
 * `ctx.fence` is REQUIRED. Without an override it is a hard caller error (GateValidationError → 400,
 * never a silent pass) — the gate cannot judge a geofence with no fence.
 */
export function assertDelivery(
  prior: readonly LedgerEvent[],
  incoming: LedgerEvent,
  ctx: GateCtx,
): void {
  if (overrideSatisfies(ctx.override)) return;

  const fence = ctx.fence;
  if (fence === undefined) {
    throw new GateValidationError("assertDelivery requires ctx.fence to evaluate the geofence (REQ-046)");
  }

  const missing: RequiredEvidence[] = [];

  const geofenceCleared = prior.some((e) => {
    if (e.kind !== "stop.arrived") return false;
    try {
      const r = insideFence(e.payload.geo, fence);
      return r.inside && !r.ambiguous;
    } catch {
      // A stop.arrived whose geo makes insideFence throw (out-of-range coord, etc.) does NOT cleanly
      // clear the fence — fail-safe to a ["geofence"] block, never an opaque crash of the append.
      return false;
    }
  });
  if (!geofenceCleared) missing.push(REQUIRED_EVIDENCE.geofence);

  if (!prior.some((e) => e.kind === "pod.signed")) missing.push(REQUIRED_EVIDENCE.pod_signed);

  const incomingPlaced = incoming.kind === "delivery.evidenced"
    ? readField(incoming.payload, "placed_photo_hash")
    : undefined;
  const hasIncomingPlaced = typeof incomingPlaced === "string" && HASH64.test(incomingPlaced);
  const hasPriorPlaced = prior.some(
    (e) => e.kind === "freight.photographed" && e.payload.photo_kind === "placed",
  );
  if (!hasIncomingPlaced && !hasPriorPlaced) missing.push(REQUIRED_EVIDENCE.placed_freight_photo);

  if (missing.length > 0) throw new GateError(missing);
}

/**
 * REQ-045 — an INTERLINE custody handoff is blocked until:
 *   - a prior `seal.applied` exists (the trailer was sealed before the handoff) → else `seal.applied`;
 *   - the handoff is CO-SIGNED — the receiver acknowledged with a real device signature, i.e.
 *     `incoming.actor.device !== undefined`. An `unwitnessed` transfer (no device) is NOT an ack →
 *     else `receiver_ack`.
 *
 * `isInterline` is a REQUIRED positional, decided by the Task-5 caller from the shipment legs (a
 * transfer to the consignee is not interline). It is deliberately NOT an optional ctx flag: a
 * fail-open default would let a caller omission silently skip the entire seal + receiver-ack gate with
 * no signal. Making it required means a caller that forgets it is a COMPILE error — the same fail-loud
 * discipline as assertDelivery's required fence. `isInterline === false` is a legitimate no-op pass.
 */
export function assertInterline(
  prior: readonly LedgerEvent[],
  incoming: LedgerEvent,
  isInterline: boolean,
  ctx?: GateCtx,
): void {
  if (overrideSatisfies(ctx?.override)) return;
  if (!isInterline) return; // consignee handoff — not interline → the gate does not apply.

  const missing: RequiredEvidence[] = [];
  if (!prior.some((e) => e.kind === "seal.applied")) missing.push(REQUIRED_EVIDENCE.seal_applied);
  if (incoming.actor.device === undefined) missing.push(REQUIRED_EVIDENCE.receiver_ack);
  if (missing.length > 0) throw new GateError(missing);
}

/**
 * REQ-050 — an EXCEPTION (`incoming` = `exception.raised` or `osd.captured`) is blocked until its
 * payload carries a photo (`photo_hash`, a 64-hex content hash) AND a `reason_code` (non-empty).
 *
 * ASYMMETRY (doc 10): `osd.captured` is a strictly-typed payload, but `exception.raised` deliberately
 * stays a loose JsonObject. So the fields are read DEFENSIVELY off an unknown payload — the gate must
 * NOT assume the typed shape. Missing → ["exception_photo","reason_code"] (both when both absent).
 */
export function assertException(incoming: LedgerEvent, ctx?: GateCtx): void {
  if (overrideSatisfies(ctx?.override)) return;

  const photoHash = readField(incoming.payload, "photo_hash");
  const reasonCode = readField(incoming.payload, "reason_code");

  const missing: RequiredEvidence[] = [];
  if (!(typeof photoHash === "string" && HASH64.test(photoHash))) missing.push(REQUIRED_EVIDENCE.exception_photo);
  if (!(typeof reasonCode === "string" && reasonCode.trim().length > 0)) missing.push(REQUIRED_EVIDENCE.reason_code);
  if (missing.length > 0) throw new GateError(missing);
}

/**
 * REQ-166 — consent-before-first-GPS. This is the consent MECHANISM only: it enforces that SOME valid
 * consent-for-this-operating-state acknowledgment already sits on the stream before the first GPS
 * stamp is recorded. The legal policy TEXT, the per-state consent copy, and counsel sign-off on
 * whether a given acknowledgment is legally sufficient are **[CONFIRM] (owner=counsel)** — a pack-side,
 * counsel-reviewed deliverable (doc 13 §05), NOT code. The gate does not judge legal sufficiency; it
 * judges only that a structurally-valid ConsentAck for `ctx.operating_state` precedes the stamp.
 *
 * SCOPE — the gate applies ONLY when `incoming.kind` is a GPS/geo stamp: `position.updated` or
 * `stop.arrived` (the geofence auto-arrive is itself a GPS stamp). Every other kind is a no-op pass:
 * consent gates the LOCATION TRACKING, not the whole event stream.
 *
 * GEO-BEARING SET (documented choice): `stop.departed` and `delivery.evidenced` also carry a `geo`,
 * but this gate is "consent before the FIRST stamp" — once the first `position.updated`/`stop.arrived`
 * has passed, a consent-for-this-state is provably already on the stream, so gating the later geo-
 * bearing kinds would be redundant. Guarding the two arrival/position stamps is sufficient and minimal.
 *
 * CONSENT is PER operating state (REQ-166): a `document.attached` whose payload parses via
 * `ConsentAck.safeParse` AND whose `operating_state === ctx.operating_state`. A consent acknowledged
 * for "CA" does NOT cover a stamp taken while operating in "TX". `document.attached` is a loose
 * JsonObject kind, so the payload is safeParse'd DEFENSIVELY (like the exception gate) — an
 * unacknowledged doc, a non-consent doc, or a wrong-state consent never satisfies the gate.
 * Missing/mismatched → `GateError(["consent"])`.
 *
 * EXACT-MATCH WARNING (the emitter's contract): `ConsentAck` is `.strict()`, so a consent doc whose
 * payload carries ANY extra key beyond the four fields (a natural `doc_id`, content hash, or
 * `captured_ts` on the SAME object) FAILS safeParse and does NOT satisfy the gate — which would
 * silently block that driver from ALL GPS in that state, forever, with nothing pointing at the extra
 * key. The Task-5 DO writer and Task-8 PWA emitter MUST put ONLY {doc_kind, policy_version,
 * operating_state, acknowledged} in the consent payload; any id/hash/timestamp rides the envelope
 * (`evidence[]` / `captured_ts`), never inside this object. (See the ConsentAck schema in contracts.)
 *
 * `ctx.operating_state` PROVENANCE + FORM: it is the jurisdiction of the INCOMING stamp — Task 5
 * reverse-geocodes `incoming.payload.geo` → jurisdiction (correctly impure, so it lives in the caller,
 * NOT in this pure gate) — NOT the driver's home state and NOT the shipment origin; a plausible-but-
 * wrong state yields a silent mis-decision. The compare is EXACT, case-sensitive equality, so the
 * value must be the canonical form the ConsentAck contract pins (uppercase 2-letter USPS code, "TX"):
 * capture, derivation, and this gate must all agree — "TX" ≠ "tx" ≠ "Texas".
 *
 * `ctx.operating_state` must be a non-empty string; a blank one is a caller error (the gate cannot
 * decide per-state consent without knowing the state) → `GateValidationError` (VALIDATION_FAILED, a
 * 400), NOT a GateError. This gate takes no override — consent is a legal precondition, not an
 * operational evidence requirement a dispatcher may waive.
 */
// The context is a bespoke `{ operating_state }` rather than the shared `GateCtx` BY DESIGN: it
// structurally forbids handing this non-overridable gate an `override` (a caller physically cannot
// pass one — it is a compile error, not a runtime ignore). Task 5: this divergence is deliberate.
export function assertConsentBeforeGps(
  prior: readonly LedgerEvent[],
  incoming: LedgerEvent,
  ctx: { operating_state: string },
): void {
  // The gate guards location tracking only — a non-GPS incoming event is outside its scope (no-op).
  if (incoming.kind !== "position.updated" && incoming.kind !== "stop.arrived") return;

  if (ctx.operating_state.trim().length === 0) {
    throw new GateValidationError("assertConsentBeforeGps requires a non-empty ctx.operating_state (REQ-166)");
  }

  const consented = prior.some((e) => {
    if (e.kind !== "document.attached") return false;
    const parsed = ConsentAck.safeParse(e.payload);
    return parsed.success && parsed.data.operating_state === ctx.operating_state;
  });
  if (!consented) throw new GateError([REQUIRED_EVIDENCE.consent]);
}
