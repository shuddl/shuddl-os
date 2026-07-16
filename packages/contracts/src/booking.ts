import { z } from "zod";
import { SafeInt } from "./json.js";
import { Cents } from "./money.js";

// WP-08 Scheduler/Booking (REQ-028/042/043/047/052/057): typed payloads for the booking + scheduler kinds.
// These give the EXISTING kinds credit.checked / booking.created / appointment.set / pickup.scheduled /
// dispatch.assigned a proper Zod shape (they were name-only JsonObject) so the accept → credit → book →
// appoint → dispatch protocol can carry its refs / windows / party-corrections THROUGH the append-only
// ledger. NO kind is added — the 35-catalog is unchanged (events.ts pins .length === 35). Organized as its
// own domain module and imported by events.ts, mirroring comms.ts / money.ts. Integer-only canonical law
// applies (SafeInt): cents and epoch-ms timestamps are integers, never floats. Mirrors WP-07's comms.ts.

// credit.checked — a party's credit decision. `status` gates booking (REQ-042: a hold blocks the booking
// event). `limit_cents` is the approved credit line (integer cents); `decided_by` names the human/agent who
// decided; `ref` links the external credit-bureau/underwriting record. Only `party_id` + `status` are
// required — a "clear" with no limit is legal.
export const CreditCheckedPayload = z
  .object({
    party_id: z.string().min(1),
    status: z.enum(["clear", "hold", "review"]),
    // approved credit line — money discipline: branded Cents (±bound + brand, same as InvoiceLine /
    // SplitComputed) refined non-negative. A negative ceiling is nonsensical and would sit immutably in the
    // append-only ledger AND could mislead the REQ-042 credit gate, so it is rejected HERE at the boundary.
    // Zero is legal (a hold-to-prepaid decision — a real zero ceiling).
    limit_cents: Cents.refine((c) => c >= 0, "credit limit is a non-negative ceiling").optional(),
    decided_by: z.string().min(1).optional(), // present ⇒ non-empty (a named decider, never "")
    ref: z.string().min(1).optional(), // present ⇒ non-empty (an external underwriting ref)
  })
  .strict();
export type CreditCheckedPayload = z.infer<typeof CreditCheckedPayload>;

// booking.created — the accepted quote becomes a booking. This is the PARTY-CORRECTION SOURCE: it names the
// REAL consignee / bill_to (which a quote may have only guessed), and `quote_event_id` anchors the accepted
// quote (mirrors QuoteAcceptedPayload.quote_event_id). All four party FKs + `division` are required (the
// status-cache projection creates the shipments row from them). `mode` / `service` / `bill_terms` are
// optional refinements. `.strict()` — the legacy `created_ts` does NOT belong here (the envelope carries ts).
export const BookingCreatedPayload = z
  .object({
    quote_event_id: z.string().min(1), // the accepted quote.* event this booking realizes
    shipper_party_id: z.string().min(1),
    consignee_party_id: z.string().min(1),
    bill_to_party_id: z.string().min(1),
    division: z.string().min(1),
    mode: z.enum(["LTL", "TL", "brokered", "cartage", "dray", "transload"]).optional(),
    service: z.string().min(1).optional(), // present ⇒ non-empty (a named service level)
    bill_terms: z.enum(["prepaid", "collect", "third_party"]).optional(),
    // REQ-182 (origin REQ-047/GA-6) — the evidence-recipient gate's deliberate escape. booking.created is
    // BLOCKED server-side (T6, sequencer #enforceBooking) when the EVIDENCE RECIPIENT — the bill_to party,
    // the party the Biller's resolveRecipient actually emails the invoice + evidence to — carries no
    // deliverable contact, UNLESS the booker explicitly acknowledges "this recipient has no contact, book
    // anyway" by carrying this flag. It rides the booking PAYLOAD (not shipments.service_flags, whose row
    // does not exist at gate time — the projection creates it AFTER the gate) so the acknowledgment is a
    // permanently-visible, append-only fact. OPTIONAL and absent by default, so it never moves the
    // roundtrip/seed snapshot; the gate reads it only when present-and-true. Distinct from a REQ-049 gate
    // override: the opt-out is the purpose-built recipient escape, not a generic waiver.
    evidence_contact_opt_out: z.boolean().optional(),
  })
  .strict();
export type BookingCreatedPayload = z.infer<typeof BookingCreatedPayload>;

// appointment.set — a booked facility slot for a pickup/delivery leg. `slot_key` is the facility's opaque
// slot identifier; the window is integer epoch-ms. `reschedule_of` names a PRIOR appointment.set event — a
// reschedule is a NEW event, never a mutation of the old one (append-only, I3/I7). Absent on a first booking.
export const AppointmentSetPayload = z
  .object({
    // v1 appointments are the two customer-facing stops only. Deliberately NARROWER than a leg's kind
    // (LTL/dray/interline etc.) — interline/dray handoff appointments come in a later WP.
    leg_kind: z.enum(["pickup", "delivery"]),
    facility_id: z.string().min(1),
    slot_key: z.string().min(1),
    window_start_ts: SafeInt, // epoch ms UTC (integer canonical law)
    window_end_ts: SafeInt, // epoch ms UTC
    reschedule_of: z.string().min(1).optional(), // present ⇒ a real prior appointment.set event id
  })
  .strict()
  // The window must not be inverted — an end before its start is a nonsensical slot that would sit
  // immutably in the append-only ledger. Rejected at the boundary (mirrors SplitComputed's cross-field
  // refine). Zero-length (end === start) is allowed — an instantaneous slot is a legal degenerate case.
  .refine((p) => p.window_end_ts >= p.window_start_ts, "window_end_ts must be >= window_start_ts");
export type AppointmentSetPayload = z.infer<typeof AppointmentSetPayload>;

// pickup.scheduled — the pickup was scheduled at a facility within a window (integer epoch-ms).
export const PickupScheduledPayload = z
  .object({
    facility_id: z.string().min(1),
    window_start_ts: SafeInt, // epoch ms UTC
    window_end_ts: SafeInt, // epoch ms UTC
  })
  .strict()
  // Window-ordering invariant (mirrors AppointmentSetPayload): an inverted window is unrecordable here.
  .refine((p) => p.window_end_ts >= p.window_start_ts, "window_end_ts must be >= window_start_ts");
export type PickupScheduledPayload = z.infer<typeof PickupScheduledPayload>;

// dispatch.assigned — the load was dispatched to a driver. `driver_user_id` is required; `asset_id` (the
// tractor/truck) and `legs` (the ordered leg refs this assignment covers) are optional. The status-cache
// projection reads the driver off the envelope `actor.user`, not this payload — this is the durable record.
export const DispatchAssignedPayload = z
  .object({
    driver_user_id: z.string().min(1),
    asset_id: z.string().min(1).optional(), // present ⇒ non-empty
    legs: z.array(z.string().min(1)).optional(), // each leg is a non-empty ref
  })
  .strict();
export type DispatchAssignedPayload = z.infer<typeof DispatchAssignedPayload>;
