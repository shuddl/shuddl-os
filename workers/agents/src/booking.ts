// WP-08 T8 — THE BOOKING AGENT (REQ-028 / REQ-042 / REQ-182 / REQ-030). The Biller/Concierge sibling: a
// committed `quote.accepted` (naming the accepted quote.priced via `quote_event_id`) triggers this
// consumer, which appends `booking.created` THROUGH the sequencer DO — where (T4) it materializes the
// shipment row + skeleton legs and (T6) runs the credit + evidence-recipient gates, atomically in one
// db.batch. The manual/ops accept path (WP-10 command bar) and the future inbound-reply path funnel through
// the SAME gated `booking.created` append; this builds the AGENT path.
//
// LAWS THIS MODULE ENFORCES (carried from the Biller/Concierge, make-agent-idempotent skill):
//   · IDEMPOTENT under at-least-once redelivery: the booking.created event id is DETERMINISTICALLY derived
//     from the quote.accepted event id (no Date, no random); the sequencer dedupes by event id; a redelivery
//     whose booking.created already committed returns `already_booked` (fast path). Twice in = once out.
//   · GATE-BLOCK HOLDS, NEVER DLQ-LOOPS (the REQ-173/Concierge lesson): the gated append can throw
//     GATE_BLOCKED (bill_to on a credit hold, or bill_to with no deliverable contact + no opt-out). That is
//     terminal-for-now — a human/ops must clear it — so it is CAUGHT here and returned as a `held` outcome.
//     Letting it escape into the queue's blanket retry would redeliver forever → DLQ. A genuine transient /
//     unexpected fault still THROWS (like the Biller) so the queue redelivers (the append is idempotent).
//   · SERVER-SIDE GATES UNBYPASSABLE (REQ-030): the agent has NO gate logic of its own — it appends THROUGH
//     the DO, so the SAME #enforceBooking gate every API path hits runs here too.
//   · POISON is skipped, never retried: a trigger whose quote.accepted id isn't on the stream cannot be
//     conjured by redelivery.
//   · TENANT-ISOLATED (REQ-025): bound to ONE tenant's D1 (the caller resolves it via the allowlist).
//
// The booking parties come from the ACCEPTED SHIPMENT'S existing rows (shipper/consignee/bill_to + division).
// A quote-accept carries NO new consignee/bill_to — the party-CORRECTION with real different parties is the
// ops/API booking path (T4-tested); the agent books the QUOTED shipment with its existing parties. For a
// Concierge shipment those FKs all equal the requester (who has an email contact), so the T6 evidence-
// recipient gate passes. LLM-free (REQ-024): this consumer only loads records, derives an id, and appends.

import { z, GATE_BLOCKED_PREFIX } from "@shuddl/contracts";
import type { BookingCreatedPayload, LedgerEvent } from "@shuddl/contracts";
import { rowToEvent } from "@shuddl/ledger/lens";
import type { SeqStubLike } from "./biller.js";

// ---- the queue trigger (Zod at the boundary; the producer is the sequencer DO) ----------------------
// `shipment_id` is REQUIRED (unlike the Concierge's optional one): a quote.accepted presupposes an accepted
// quote, which presupposes a shipment, so the accept always sits on a shipment stream. Mirrors the Biller's
// PodSignedMessage shape.
export const QuoteAcceptedTrigger = z
  .object({
    kind: z.literal("quote.accepted"),
    tenant: z.string().min(1),
    shipment_id: z.string().min(1),
    event_id: z.string().min(1),
  })
  .strict();
export type QuoteAcceptedTrigger = z.infer<typeof QuoteAcceptedTrigger>;

// ---- deps ------------------------------------------------------------------------------------------
export interface BookingDeps {
  /** The trigger tenant's OWN D1 (the caller resolves it via the tenant allowlist — REQ-025). */
  db: D1Database;
  /** The sequencer DO append surface (the ONLY write path — the gates + projections run there). */
  seq: SeqStubLike;
}

// ---- outcome ---------------------------------------------------------------------------------------
export type BookingOutcome =
  | { status: "booked"; booking_event_id: string; shipment_id: string; quote_event_id: string }
  | { status: "already_booked"; booking_event_id: string; shipment_id: string }
  | { status: "held"; reason: "credit_clear" | "evidence_recipient" | "unknown"; required_evidence: string[]; detail: string }
  | { status: "skipped"; reason: "quote_accept_not_found" | "shipment_not_found" | "accepted_quote_not_found"; detail: string };

// ---- deterministic id (no Date, no random — redelivery must reproduce it exactly) -------------------
async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The booking.created EVENT id: a domain-separated SHA-256 of the quote.accepted event id, shaped into a
// v4-variant UUID so it satisfies EventInput's z.string().uuid() — the same shaping biller.ts / concierge.ts
// use. The sequencer dedupes by this id, so a redelivered message returns the ORIGINAL event, never a second
// booking. Exported so the test can assert the derivation directly.
export async function bookingEventIdFor(quoteAcceptedEventId: string): Promise<string> {
  const h = (await sha256Hex(`booking:booking-created:${quoteAcceptedEventId}`)).slice(0, 32);
  const variant = ((parseInt(h.slice(16, 17) || "0", 16) & 0x3) | 0x8).toString(16); // 8/9/a/b
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// ---- gate-block recognition -------------------------------------------------------------------------
// The DO throws every gate refusal as a PLAIN Error whose message is `GATE_BLOCKED:{json}` — the only shape
// that survives the DO→Workers RPC hop intact (sequencer.ts re-wraps GateError into a plain Error). Recognize
// it by the SHARED GATE_BLOCKED_PREFIX (derived from the ErrorCode enum, the SAME constant the producer
// GateError builds and the events.ts route matches) so this consumer can NEVER drift from its producer — a
// drift would silently return null → every gate-blocked booking DLQ-loops instead of holding. Read
// `required_evidence`; a NON-gate error returns null so the caller re-throws it for redelivery. NEVER regex the
// human message — the machine-readable code+json is the contract. Exported so an IN-ISOLATE test binds the
// producer (GateError) directly to this consumer, without relying on the DO to reproduce RPC serialization.
export function gateBlock(err: unknown): string[] | null {
  if (!(err instanceof Error) || !err.message.startsWith(GATE_BLOCKED_PREFIX)) return null;
  try {
    const parsed = JSON.parse(err.message.slice(GATE_BLOCKED_PREFIX.length)) as { required_evidence?: unknown };
    return Array.isArray(parsed.required_evidence) ? parsed.required_evidence.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// ---- record loading --------------------------------------------------------------------------------
type SqlRow = Record<string, string | number | null>;

async function loadEvent(db: D1Database, streamId: string, eventId: string, kind: string): Promise<LedgerEvent | null> {
  const row = await db
    .prepare("SELECT * FROM events WHERE stream_id = ? AND id = ? AND kind = ?")
    .bind(streamId, eventId, kind)
    .first<SqlRow>();
  return row === null ? null : rowToEvent(row);
}

type ShipmentRow = { shipper_party_id: string; consignee_party_id: string; bill_to_party_id: string; division: string };

// ---- the consumer ------------------------------------------------------------------------------------
export async function handleQuoteAccepted(trigger: QuoteAcceptedTrigger, deps: BookingDeps): Promise<BookingOutcome> {
  const msg = QuoteAcceptedTrigger.parse(trigger); // Zod at the boundary even when the caller pre-parsed
  const { db, seq } = deps;
  const streamId = `s:${msg.shipment_id}`;

  // GUARD 1 — the trigger event must exist ON THIS STREAM as a quote.accepted. A message referencing a
  // nonexistent/foreign accept is POISON: redelivery cannot conjure it → skip (non-retriable), never append.
  const accepted = await loadEvent(db, streamId, msg.event_id, "quote.accepted");
  if (accepted === null || accepted.kind !== "quote.accepted") {
    return { status: "skipped", reason: "quote_accept_not_found", detail: `quote.accepted ${msg.event_id} not on ${streamId} — poison message` };
  }
  const acceptedQuoteId = accepted.payload.quote_event_id; // the accepted quote.priced this booking realizes

  // The ACCEPTED SHIPMENT supplies the booking parties (a quote-accept carries no NEW parties — the party-
  // CORRECTION with real different parties is the ops/API booking path). A shipment with events but no row is
  // a data fault, not retriable.
  const shipment = await db
    .prepare("SELECT shipper_party_id, consignee_party_id, bill_to_party_id, division FROM shipments WHERE id = ?")
    .bind(msg.shipment_id)
    .first<ShipmentRow>();
  if (shipment === null) {
    return { status: "skipped", reason: "shipment_not_found", detail: `shipment ${msg.shipment_id} has a quote.accepted but no shipments row — data fault, not retriable` };
  }

  // REDELIVERY FAST PATH — the booking event id is DETERMINISTIC from the accept id, so if it ALREADY
  // committed every gate ran and PASSED when it did; a redelivery returns already_booked (no re-load of the
  // accepted quote, no re-append). The DO would dedupe a second append anyway — this is the cheap short-circuit.
  const bookingEventId = await bookingEventIdFor(accepted.id);
  const existing = await loadEvent(db, streamId, bookingEventId, "booking.created");
  if (existing !== null) {
    return { status: "already_booked", booking_event_id: existing.id, shipment_id: msg.shipment_id };
  }

  // GUARD 2 — the accepted quote.priced must EXIST on the stream (the booking anchors it; a dangling / wrong-
  // kind quote_event_id is a data fault, not retriable). A bare existence probe — the booking payload's
  // quote_event_id is `acceptedQuoteId` (read from the ACCEPT above), NEVER a field off this row, so there is
  // nothing to load: SELECT 1 is all the guard needs.
  const acceptedQuoteExists = await db
    .prepare("SELECT 1 AS present FROM events WHERE stream_id = ? AND id = ? AND kind = 'quote.priced' LIMIT 1")
    .bind(streamId, acceptedQuoteId)
    .first<{ present: number }>();
  if (acceptedQuoteExists === null) {
    return {
      status: "skipped",
      reason: "accepted_quote_not_found",
      detail: `quote.accepted ${msg.event_id} names quote ${acceptedQuoteId} which is not a quote.priced on ${streamId} — data fault`,
    };
  }

  // GUARD 3 (REQ-191, WP-09 exit audit C-2) — ALREADY-BOOKED SKIP. The deterministic-id fast path above only
  // catches a redelivery of THIS accept; a DIFFERENT accept (a portal party who re-rated + re-accepted an
  // already-booked shipment) has a new id, so without this a second booking.created would be attempted. The
  // DO gate (#enforceBooking) rejects it server-side as VALIDATION_FAILED regardless — but that is NOT a
  // GATE_BLOCKED, so the catch below would RE-THROW it into the retry→DLQ path. Skip cleanly here: any prior
  // booking.created on the stream ⇒ already_booked (idempotent). A concurrent race that slips past this still
  // fails closed at the DO gate and self-heals on redelivery (this guard then sees the committed booking).
  const priorBooking = await db
    .prepare("SELECT id FROM events WHERE stream_id = ? AND kind = 'booking.created' ORDER BY seq LIMIT 1")
    .bind(streamId)
    .first<{ id: string }>();
  if (priorBooking !== null) {
    return { status: "already_booked", booking_event_id: priorBooking.id, shipment_id: msg.shipment_id };
  }

  // The booking payload — parties from the ACCEPTED SHIPMENT'S rows (existing parties, never guessed);
  // quote_event_id = the accepted quote. No mode/service/bill_terms/opt-out: the agent books the quoted
  // shipment as-is. `evidence_contact_opt_out` is deliberately ABSENT — the agent never books over an
  // unreachable recipient (that acknowledgment is a human ops decision on the API/command-bar path).
  const payload: BookingCreatedPayload = {
    quote_event_id: acceptedQuoteId,
    shipper_party_id: shipment.shipper_party_id,
    consignee_party_id: shipment.consignee_party_id,
    bill_to_party_id: shipment.bill_to_party_id,
    division: shipment.division,
  };

  // party_refs = the distinct booked parties, so the counterparty lens surfaces the booking to the parties it
  // names (booking.created defaults to counterparty visibility; mirrors the Concierge stamping the requester).
  const partyRefs = [...new Set([shipment.shipper_party_id, shipment.consignee_party_id, shipment.bill_to_party_id])];

  // Append THROUGH the sequencer DO: the T6 credit + evidence-recipient gates and the T4 shipment/leg
  // materialization run there, atomically. The DO dedupes by the deterministic event id.
  try {
    const appended = await seq.append({
      tenant: msg.tenant,
      streamId,
      input: {
        id: bookingEventId,
        shipment_id: msg.shipment_id,
        ts: accepted.recorded_at, // the accept's commit instant this booking realizes — deterministic, no clock read
        actor: { party: "agent:booking" }, // server-controlled sentinel (mirrors the Biller's "agent:biller")
        party_refs: partyRefs,
        evidence: [],
        source: "native",
        confidence: 10_000,
        kind: "booking.created",
        payload,
      },
    });
    return { status: "booked", booking_event_id: appended.id, shipment_id: msg.shipment_id, quote_event_id: acceptedQuoteId };
  } catch (err) {
    // GATE-BLOCK → HOLD (never DLQ-loop): a credit hold or an unreachable evidence recipient is terminal for
    // now — a human/ops clears it (raises credit, adds a contact, or books over it on the API path with the
    // opt-out). CATCH the GATE_BLOCKED refusal and return `held`; do NOT re-throw (that would redeliver
    // forever → DLQ). ONLY GATE_BLOCKED is terminal-hold: any OTHER DO refusal (VALIDATION_FAILED / FORBIDDEN
    // — an agent bug, e.g. a malformed payload/stream id or an identity mismatch) OR a transient D1/DO fault
    // is NOT a gate block, so gateBlock returns null and it RE-THROWS — the queue redelivers it and, if
    // persistent, it lands in the DLQ for human attention (matches the Biller: a genuine fault is loud, never
    // swallowed as held). Re-throwing is safe because the append is idempotent (deterministic id + DO dedupe).
    // This is the REQ-173 lesson the Concierge learned: a terminal condition must never ride the blanket retry.
    const blocked = gateBlock(err);
    if (blocked === null) throw err;
    // The booking gate emits exactly one token (credit evaluated first). Map it EXPLICITLY — a future third
    // booking-gate token is honestly reported as `unknown` (still held for ops), never silently mislabeled.
    const reason: "credit_clear" | "evidence_recipient" | "unknown" = blocked.includes("credit_clear")
      ? "credit_clear"
      : blocked.includes("evidence_recipient")
        ? "evidence_recipient"
        : "unknown";
    return {
      status: "held",
      reason,
      required_evidence: blocked,
      detail: `booking for shipment ${msg.shipment_id} gate-blocked (${blocked.join(", ") || "no evidence token"}) — HELD for ops, not DLQ'd`,
    };
  }
}
