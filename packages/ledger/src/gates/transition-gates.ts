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
import {
  ConsentAck,
  type LedgerEvent,
  type AppointmentSetPayload,
  type BookingCreatedPayload,
  type FacilityHours,
  type FacilityCapacitySlots,
  type FacilityAppointmentRules,
} from "@shuddl/contracts";
import { GateError } from "./invoice-gate.js";
import { insideFence, type Fence } from "../geo/fence.js";
import { UNKNOWN_JURISDICTION } from "../geo/jurisdiction.js";
import { hasDeliverableContact } from "../contacts.js";

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
  credit_clear: "credit_clear", // REQ-042 — the bill_to party's credit hold must be cleared (or overridden)
  evidence_recipient: "evidence_recipient", // REQ-182 — the evidence recipient (bill_to) needs a deliverable contact (or an opt-out)
  appointment: "appointment", // REQ-043 — dispatch is blocked until the shipment has a claimed dock appointment
  docs: "docs", // REQ-043 — dispatch is blocked until the required carrier paperwork (a rate-con-class doc) exists
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
 *   (c) PLACED PHOTO — BOUND TO A REAL CAPTURE (WP-05 exit audit, REQ-046/063): the POD's
 *       `delivery.evidenced.payload.placed_photo_hash` must EQUAL the `photo_hash` of a PRIOR
 *       `freight.photographed{photo_kind:"placed"}` event on the stream. A 64-hex string alone does
 *       NOT clear this pillar — a fabricated hash bound to no captured photo is exactly the bypass this
 *       closes (mirroring the pickup gate, which requires the real freight.photographed EVENT). The
 *       driver flow threads the captured placed-photo hash into the POD, so the honest path passes;
 *       an incoming hash with no matching prior placed photo → `placed_freight_photo`.
 *
 *       BYTE AUTHORITY (REQ-168, closed in WP-06): this gate binds the POD to a placed-photo EVENT+HASH —
 *       unchanged, and all a pure gate CAN do (it cannot see R2). The BYTES are verified at upload:
 *       `POST /v1/evidence` (workers/api/src/routes/evidence.ts) recomputes SHA-256 over the received
 *       bytes and rejects with 422 `hash_mismatch` — NOTHING written to R2, NO documents row — any
 *       upload whose bytes do not hash to the event-recorded photo_hash, and rejects with 422
 *       `hash_not_recorded` any declared hash that no event on the stream ever recorded (no orphan
 *       uploads). Device-signing the capture makes a forged event attributable; the upload byte-verify
 *       makes its fabricated hash FAIL to ever become stored evidence. Gate (event+hash) + upload
 *       (bytes) together close the fabricated-photo bypass. RESIDUAL (REQ-170, WP-06 follow-up): a
 *       caller able to EMIT events can still gate a POD through with a fabricated hash BEFORE/without any
 *       upload — the delivery completes with zero stored bytes — so the Biller path must surface a POD
 *       whose recorded hash has no documents row / R2 object as MISSING evidence, never silently pass it.
 *       This mitigation is UNIMPLEMENTED (it pairs with the deferred photo-URL resolver that would fetch
 *       those bytes for the email); until it lands, the Biller sends the evidence email without checking
 *       that any bytes were stored (see workers/agents/src/biller.ts sendEvidence). Tracked as REQ-170.
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

  // (c) The POD's placed_photo_hash must be BOUND to a real prior placed photo — a 64-hex string alone
  // (no matching captured photo) never clears the pillar. Read the incoming hash defensively (absent =
  // nothing to bind → blocked), then require a prior freight.photographed{placed} carrying that hash.
  const incomingPlaced = incoming.kind === "delivery.evidenced"
    ? readField(incoming.payload, "placed_photo_hash")
    : undefined;
  const boundToPriorPlaced =
    typeof incomingPlaced === "string" &&
    HASH64.test(incomingPlaced) &&
    prior.some(
      (e) => e.kind === "freight.photographed" && e.payload.photo_kind === "placed" && e.payload.photo_hash === incomingPlaced,
    );
  if (!boundToPriorPlaced) missing.push(REQUIRED_EVIDENCE.placed_freight_photo);

  if (missing.length > 0) throw new GateError(missing);
}

/**
 * REQ-045 — an INTERLINE custody handoff is blocked until:
 *   - a prior `seal.applied` exists (the trailer was sealed before the handoff) → else `seal.applied`;
 *   - the handoff carries the RECEIVER's CO-SIGN (WP-05 exit audit): a non-empty
 *     `incoming.custody.transferred.payload.cosig`. The `actor` of a `custody.transferred` is the
 *     TRANSFERRING (sending) party, so the sender's own `actor.device` signature is NOT the receiver's
 *     acknowledgment REQ-045 requires — only the receiver's `cosig` on the payload is. Absent/blank →
 *     `receiver_ack`. (Read defensively: `custody.transferred` is a strict payload, but the token is
 *     the same whatever the incoming kind.)
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
  const cosig = readField(incoming.payload, "cosig");
  if (!(typeof cosig === "string" && cosig.trim().length > 0)) missing.push(REQUIRED_EVIDENCE.receiver_ack);
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

  // WP-05 exit audit (REQ-166): an UNKNOWN jurisdiction — the deriveOperatingState fail-closed sentinel
  // "XX", returned for any coordinate outside the known boxes (~45 states) — CANNOT be consented. Block
  // regardless of any consent on the stream (a ConsentAck can no longer even carry "XX" post-fix, but
  // this is the belt: an unknown jurisdiction is never a legally-consentable state).
  if (ctx.operating_state === UNKNOWN_JURISDICTION) throw new GateError([REQUIRED_EVIDENCE.consent]);

  const consented = prior.some((e) => {
    if (e.kind !== "document.attached") return false;
    const parsed = ConsentAck.safeParse(e.payload);
    return parsed.success && parsed.data.operating_state === ctx.operating_state;
  });
  if (!consented) throw new GateError([REQUIRED_EVIDENCE.consent]);
}

// ---- REQ-028/052 — appointment.set (dock-slot) gate (WP-08 T5) ----------------------------------------

const MS_PER_MIN = 60_000;
const MS_PER_DAY = 86_400_000;

/**
 * The facility capacity model the appointment gate reads, in the parsed @shuddl/contracts shapes. Task-5's DO
 * loads this from D1 (loadFacility) and hands the three config blocks here; null = the facility does not exist.
 */
export interface AppointmentFacility {
  capacity_slots: FacilityCapacitySlots;
  hours: FacilityHours;
  appointment_rules: FacilityAppointmentRules;
}

/**
 * The SERVER-SOURCED context for assertAppointment. Everything time/tz-derived is computed by the DO caller
 * (impure) and passed in, so this gate stays PURE (no Date, no D1):
 * - `facility`: the loaded capacity model, or null when the facility_id resolves to nothing.
 * - `serviceDate` / `localMinuteOfDay` / `localDow`: the incoming window_start_ts rendered into the facility's
 *   local wall clock (the occurrence key + slot-template comparands). `nowServiceDate` is the server clock's
 *   local date (same-day detection); `now` is the server clock epoch ms (lead-time / horizon).
 * - `legExists`: a materialized leg matches (shipment_id, payload.leg_kind) — the row the claim UPDATEs.
 * - `occupied`: ANOTHER stream already holds this (facility, slot, service_date) — the sequential double-book.
 * - `override`: a REQ-049 override; waives ONLY soft policy (hours / lead-time / horizon / same-day).
 */
export interface AppointmentCtx {
  facility: AppointmentFacility | null;
  serviceDate: string;
  localMinuteOfDay: number; // window_start_ts rendered to the facility's local minute-of-day
  localWindowEndMinute: number; // window_end_ts rendered to the facility's local minute-of-day
  localDow: number;
  now: number;
  nowServiceDate: string;
  legExists: boolean;
  occupied: boolean;
  override?: Override;
}

/**
 * REQ-028/052 — the appointment.set (dock-slot claim) gate. Throws GateValidationError (VALIDATION_FAILED:
 * {reason}) — a booking conflict is a config/conflict, NOT a missing physical-evidence GATE_BLOCK — so the
 * reasons are the friendly diagnosis; the DB's ux_legs_slot UNIQUE INDEX is the atomic arbiter that makes a
 * simultaneous double-book impossible EVEN IF this gate were deleted (it just loses the clean message).
 *
 * A REQ-049 override runs FIRST but waives ONLY soft policy (outside_hours / rule_violation). It NEVER waives
 * facility/slot existence, window alignment, leg existence, the reschedule ref, or occupancy — and the index
 * is unconditional regardless of override. Reasons are evaluated IN ORDER (the first failure is the reason):
 *   1 unknown_facility · 2 slot_not_in_capacity · 3 window_mismatch · 4 outside_hours* · 5 rule_violation* ·
 *   6 leg_not_materialized · 7 bad_reschedule_ref · 8 slot_taken     (* = waivable by override)
 */
export function assertAppointment(prior: readonly LedgerEvent[], incoming: LedgerEvent, ctx: AppointmentCtx): void {
  const overridden = overrideSatisfies(ctx.override); // throws GateValidationError on a blank/unaccountable override
  // incoming is always an appointment.set here (the DO gates only this kind through this call); narrow the payload.
  const p = incoming.payload as AppointmentSetPayload;

  // 1 — the facility must exist (server-loaded). Not waivable.
  if (ctx.facility === null) throw new GateValidationError("unknown_facility");

  // 2 — the slot_key must be a real capacity-1 slot on this facility. Not waivable.
  const slot = ctx.facility.capacity_slots.find((s) => s.slot_key === p.slot_key);
  if (slot === undefined) throw new GateValidationError("slot_not_in_capacity");

  // 3 — the window's local START and END minute-of-day (+ dow, when the slot pins one) must MATCH the slot
  // template. Not waivable — this is what guarantees service_date is canonical (a caller can't smuggle a 2nd
  // instant for the same slot/day) AND that appt_window_end_ts (stored verbatim by the projection) is not a
  // misleading end on an otherwise-valid claim. absent slot.dow = a daily slot (any weekday matches).
  if (
    ctx.localMinuteOfDay !== slot.window_start_min ||
    ctx.localWindowEndMinute !== slot.window_end_min ||
    (slot.dow !== undefined && slot.dow !== ctx.localDow)
  ) {
    throw new GateValidationError("window_mismatch");
  }

  // 4 & 5 — SOFT POLICY (waivable by a named override): the facility must be OPEN for that dow/window, and the
  // booking must respect lead-time / horizon / same-day rules.
  if (!overridden) {
    // 4 — some open HoursInterval for this dow must fully contain the slot window (absent day = closed).
    const intervals = ctx.facility.hours.weekly[String(ctx.localDow)] ?? [];
    const open = intervals.some((iv) => iv.open_min <= slot.window_start_min && iv.close_min >= slot.window_end_min);
    if (!open) throw new GateValidationError("outside_hours");

    // 5 — appointment rules. lead_time: the window must be >= lead_time_min from now; horizon: <= now +
    // max_horizon_days; same-day: blocked unless allow_same_day === true. Each rule applies only when set.
    const rules = ctx.facility.appointment_rules;
    const startTs = p.window_start_ts;
    const leadShort = rules.lead_time_min !== undefined && startTs - ctx.now < rules.lead_time_min * MS_PER_MIN;
    const overHorizon = rules.max_horizon_days !== undefined && startTs > ctx.now + rules.max_horizon_days * MS_PER_DAY;
    const sameDayBlocked = rules.allow_same_day !== true && ctx.serviceDate === ctx.nowServiceDate;
    if (leadShort || overHorizon || sameDayBlocked) throw new GateValidationError("rule_violation");
  }

  // 6 — the leg the claim UPDATEs must exist (FAIL-CLOSED): without it the UPDATE is a silent 0-row no-op and
  // the appointment would commit while claiming NOTHING — a silent double-book. Turn that into a loud 400.
  if (!ctx.legExists) throw new GateValidationError("leg_not_materialized");

  // 7 — a reschedule must reference a REAL prior appointment.set on THIS stream for the SAME leg_kind. Not
  // waivable (a bad ref would let a reschedule masquerade as a fresh claim / target the wrong leg).
  if (p.reschedule_of !== undefined) {
    const ref = prior.find((e) => e.id === p.reschedule_of && e.kind === "appointment.set");
    if (ref === undefined || (ref.payload as AppointmentSetPayload).leg_kind !== p.leg_kind) {
      throw new GateValidationError("bad_reschedule_ref");
    }
  }

  // 8 — the friendly sequential double-book: ANOTHER stream already holds this (facility, slot, service_date).
  // The DB index is the atomic backstop for the simultaneous case; this is the clean message for the raced-late one.
  if (ctx.occupied) throw new GateValidationError("slot_taken");
}

// ---- REQ-042/182 — booking.created gates (WP-08 T6; origin REQ-047) -----------------------------------
//
// booking.created is the FIRST event of a fresh direct-booking stream, so NEITHER gate reads prior events —
// they read the incoming payload + a SERVER-SOURCED context the DO loads from the parties read-model. BOTH
// gates target the BILL_TO party: its credit_status (REQ-042) and its contacts (REQ-182). The bill_to is the
// party the Biller's resolveRecipient actually emails the invoice + evidence to (the paying client), so
// gating on the bill_to's contact is what makes "a booking that passes yields a resolvable evidence
// recipient" true — the party CHECKED equals the party EMAILED. (Origin note: REQ-047 framed this as the
// consignee, under a since-superseded consignee-heartbeat assumption; REQ-182 corrects the target to the
// party the code actually reaches.) Both raise GateError (GATE_BLOCKED, required_evidence) — a credit hold /
// an unreachable recipient is a MISSING-PREREQUISITE gate like the physical ones, NOT the config/conflict
// VALIDATION_FAILED the appointment gate uses (that gate diagnoses a malformed/occupied slot; here the
// booking is well-formed but a prerequisite — credit clearance, a reachable recipient — is absent).

/**
 * REQ-042 — a booking is BLOCKED when the bill_to party is on a credit HOLD. `creditStatus` is the
 * SERVER-SOURCED parties.credit_status of the bill_to party (loaded by the DO from D1, never the client
 * event). Only an explicit `"hold"` blocks → GateError(["credit_clear"]); `"clear"` / `"review"` / null /
 * undefined (no decision on file) all pass. OVERRIDABLE (REQ-049): a named+reasoned override runs FIRST and
 * releases the hold, exactly like the physical gates — a finance principal can book over a hold accountably.
 */
export function assertBookingCredit(creditStatus: string | null | undefined, ctx?: GateCtx): void {
  if (overrideSatisfies(ctx?.override)) return; // REQ-049 — an accountable override releases the hold
  if (creditStatus === "hold") throw new GateError([REQUIRED_EVIDENCE.credit_clear]);
}

/**
 * REQ-182 (origin REQ-047) — a booking is BLOCKED when the EVIDENCE RECIPIENT has no way to receive the
 * invoice + delivery evidence email: no deliverable contact on `recipientContacts` (the SERVER-SOURCED,
 * already-parsed parties.contacts of the BILL_TO party — the party the Biller emails) AND no explicit
 * opt-out on the booking payload. A deliverable contact → pass; the payload `evidence_contact_opt_out ===
 * true` → pass (the deliberate escape). Otherwise GateError(["evidence_recipient"]).
 *
 * `hasDeliverableContact` is the SAME predicate the Biller's resolveRecipient applies to the SAME party
 * (the bill_to), from the shared module ../contacts.js — so a booking that passes this gate is one whose
 * bill_to resolveRecipient can actually reach: the party checked equals the party emailed. NON-OVERRIDABLE
 * by design: a generic REQ-049 override does NOT release it (a booking must never silently ship with no way
 * to reach the recipient). The opt-out is its purpose-built escape, recorded ON the append-only booking
 * payload — a stronger, more specific accountability record than a {by, reason} waiver. The gate therefore
 * takes no GateCtx (an override cannot even be handed to it — a compile-time guarantee, mirroring
 * assertConsentBeforeGps).
 */
export function assertBookingRecipientContact(incoming: LedgerEvent, recipientContacts: unknown): void {
  const optedOut = (incoming.payload as BookingCreatedPayload).evidence_contact_opt_out === true;
  if (optedOut) return;
  if (hasDeliverableContact(recipientContacts)) return;
  throw new GateError([REQUIRED_EVIDENCE.evidence_recipient]);
}

// ---- REQ-043 — dispatch.assigned gate (WP-08 T7) ------------------------------------------------------
//
// dispatch.assigned (sending a driver to a booked shipment) is BLOCKED until the shipment has BOTH a claimed
// APPOINTMENT and the required DOCS — the freight reality that you do not roll a driver before the stop is
// scheduled and the carrier paperwork exists. dispatch.assigned is NOT the first event on the stream (a booked
// shipment already has booking.created), but the two facts are cleanest from the SERVER-SOURCED read-models
// the DO (Task 7) loads: legs.appt_slot_key (set by T5's appointment.set) for the appointment, and a documents
// row of the dispatch-required kind for the docs — NEVER from the client event (a dispatcher cannot spoof "the
// appointment is set" or "the rate-con exists"). Raises GateError (GATE_BLOCKED, required_evidence) — a missing
// prerequisite like the physical/booking gates, NOT the appointment gate's config/conflict VALIDATION_FAILED.

/**
 * REQ-043 — the ONE canonical dispatch-required document kind, shared by the pure gate's contract and the DO's
 * server-side `documents` read (sequencer.ts #enforceDispatch) so a rename can never leave the two out of sync
 * (a silent, permanent fail-close). It MUST remain a member of the `documents.kind` CHECK in
 * db/tenant/migrations/0002_domain.sql (BOL / POD / photo / WI_cert / invoice / ratecon / COI / W9 / claim /
 * tsa_receipt) — the rate-confirmation-class carrier paperwork a driver needs before rolling. The dispatch-gate
 * tests import this so a rename fails LOUDLY instead of silently blocking every dispatch forever.
 */
export const DISPATCH_REQUIRED_DOC_KIND = "ratecon";

/**
 * The SERVER-SOURCED context for assertDispatch (loaded by the DO from D1, never the client event):
 * - `hasAppointment`: a leg on the shipment has claimed a dock slot (legs.appt_slot_key IS NOT NULL, set by
 *   T5's appointment.set). A booked shipment carries skeleton legs with appt_slot_key NULL until an
 *   appointment claims one, so a non-null slot IS the "an appointment exists" signal.
 * - `hasDocs`: the required carrier paperwork is present — a documents row of the dispatch-required kind.
 * - `override`: a REQ-049 override that releases the gate accountably (like the physical/booking gates).
 */
export interface DispatchCtx {
  hasAppointment: boolean;
  hasDocs: boolean;
  override?: Override;
}

/**
 * REQ-043 — the dispatch.assigned gate. Blocked unless the shipment has BOTH a claimed appointment AND the
 * required docs. The EXACT missing subset is collected in a DETERMINISTIC order (appointment, then docs) so a
 * dispatcher sees the full checklist at once: ["appointment"], ["docs"], or ["appointment","docs"]. Both
 * present → pass. OVERRIDABLE (REQ-049): a named+reasoned override runs FIRST and releases the gate — an
 * accountable dispatch-over — exactly like the physical/booking gates; a blank/unaccountable override is a
 * GateValidationError (VALIDATION_FAILED), never a silent pass.
 */
export function assertDispatch(ctx: DispatchCtx): void {
  if (overrideSatisfies(ctx.override)) return; // REQ-049 — an accountable override releases the gate

  const missing: RequiredEvidence[] = [];
  if (!ctx.hasAppointment) missing.push(REQUIRED_EVIDENCE.appointment);
  if (!ctx.hasDocs) missing.push(REQUIRED_EVIDENCE.docs);
  if (missing.length > 0) throw new GateError(missing);
}
