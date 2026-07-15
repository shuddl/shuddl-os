// REQ-100 (WP-07 Concierge) / I1 — "no communication exists outside the ledger". Every message is a
// message.* EVENT; the `messages` table is a read-model PROJECTED from those events, exactly like
// money_lines is a projection of invoice.* events. `projectMessages` is a PURE function:
// event -> the messages row(s) that event implies. It never touches the DB (the caller executes).
// `applyMessageProjection` turns those rows into PREPARED statements so the sequencer can put them in
// the SAME db.batch() as the event INSERT — the event and its projected row commit together (I1).
//
// TWO-PHASE ROW MODEL (why the resolution columns are NULL here):
//   • This projection writes ONLY the immutable message CONTENT the event already carries:
//     `id`, `channel`, `direction`, `body_ref`, `thread` — plus `shipment_id`, which is the event
//     envelope's own authoritative stream binding (present on a shipment stream, absent otherwise), not
//     a guess.
//   • The RESOLUTION columns — `party_id`, `resolved_conf`, `sla_due_ts` — are left NULL. They do NOT
//     exist yet at receipt: `resolved_conf` means "confident this message is RESOLVED to a Party +
//     Shipment," which is a DIFFERENT quantity from the payload's `parse_confidence` ("confident the
//     INTENT is quote/status/claim"); and `party_id` is a resolved counterparty, NOT `party_refs[0]`
//     (party_refs is an UNORDERED membership set with no ordering contract and no FK — `[0]` is not
//     guaranteed to be the counterparty; contrast money.ts, which reads an explicit `p.party_id` and
//     never guesses). The Concierge resolution (WP-07 Task 4/6) fills these later via a mutable UPDATE
//     to this `messages` row.
//
// MUTABLE READ-MODEL, NOT APPEND-ONLY: `messages` has NO append-only guard (unlike events/money_lines);
// it is a mutable projection like `status_cache`/`invoices`, so the Task-4/6 resolution UPDATE is legal.
// This INSERT path itself issues NO UPDATE/DELETE — the row id is DETERMINISTIC (`msg:<event.id>`) and
// the INSERT is `OR IGNORE`, so re-projecting the same event (redelivery / crash-heal replay) is an
// exact no-op. Critically, `OR IGNORE` (NOT `OR REPLACE`) means a re-projection NEVER clobbers a
// resolution the Concierge already wrote — the existing row, with its filled-in party/conf, survives.
//
// `direction` ('in'|'out') is unconstrained at the DB (the STRICT `messages` table has no CHECK on it,
// and SQLite cannot ALTER-ADD a CHECK without a full table recreate — not worth it here). The guard is
// instead the TypeScript `MessageDirection` union below PLUS this projection being the SOLE writer of
// the column, so only 'in'/'out' can ever be inserted.
import type { LedgerEvent, MessageChannel } from "@shuddl/contracts";

export type MessageDirection = "in" | "out";

// A projected `messages` row (db/tenant/migrations/0002_domain.sql). NOT NULL at the DB: id, channel,
// direction. `body_ref` is nullable in the table but is ALWAYS written here — the payload requires it
// (MessageReceivedPayload/MessageSentPayload both have `body_ref: z.string().min(1)`), so it is content,
// never null. The RESOLUTION columns (`party_id`, `resolved_conf`, `sla_due_ts`) are ALWAYS null at
// projection — see the header.
export interface MessageRow {
  id: string;
  channel: MessageChannel;
  direction: MessageDirection;
  party_id: string | null;
  shipment_id: string | null;
  resolved_conf: number | null;
  thread: string | null;
  body_ref: string;
  drafted_by_agent: string | null;
  sla_due_ts: number | null;
}

// Deterministic PK so re-projection is idempotent (one row per event). `messages.id` is the PK, so the
// event id — already globally unique — makes exactly one row per comms event.
const messageId = (eventId: string): string => `msg:${eventId}`;

/**
 * The messages row(s) an event implies. Exhaustive over all 35 event kinds: message.received projects
 * one inbound row, message.sent one outbound row, and every other kind projects nothing. The `never`
 * guard on the default makes a future 36th kind a COMPILE error (it can never silently project no row).
 */
export function projectMessages(e: LedgerEvent): MessageRow[] {
  // shipment_id is the event envelope's own binding (a shipment stream sets it; a quote/other stream
  // leaves it undefined -> NULL). It is NOT a resolution guess — the event already carries it.
  const shipmentId = e.shipment_id ?? null;

  switch (e.kind) {
    case "message.received": {
      const p = e.payload; // MessageReceivedPayload
      return [
        {
          id: messageId(e.id),
          channel: p.channel,
          direction: "in",
          party_id: null, // RESOLUTION: filled by the Concierge (Task 4/6), never guessed from party_refs
          shipment_id: shipmentId,
          resolved_conf: null, // RESOLUTION: not parse_confidence (a different quantity — see header)
          thread: p.thread ?? null,
          body_ref: p.body_ref,
          drafted_by_agent: null, // an inbound message is not agent-drafted
          sla_due_ts: null, // RESOLUTION / SLA: Task 8 owns this
        },
      ];
    }

    case "message.sent": {
      const p = e.payload; // MessageSentPayload
      return [
        {
          id: messageId(e.id),
          channel: p.channel,
          direction: "out",
          party_id: null, // RESOLUTION: filled by the Concierge (Task 4/6), never guessed from party_refs
          shipment_id: shipmentId,
          resolved_conf: null, // an outbound message has no inbound resolution confidence
          thread: p.thread ?? null,
          body_ref: p.body_ref,
          drafted_by_agent: p.drafted_by_agent ?? null, // CONTENT: the agent that composed it (on the event)
          sla_due_ts: null,
        },
      ];
    }

    // quote.sent {quote_event_id, to_ref, message_event_id} carries NO channel (the NOT NULL
    // messages.channel column) and NO body_ref, so it cannot cleanly map to a messages row. Its comms
    // leg IS the outbound message.sent event it references (message_event_id), and THAT event projects
    // the row — so quote.sent projects nothing here. The rest of the catalog carries no message either;
    // every kind is listed so the `never` guard below is real.
    case "quote.requested":
    case "quote.priced":
    case "quote.sent":
    case "quote.accepted":
    case "quote.expired":
    case "booking.created":
    case "credit.checked":
    case "appointment.set":
    case "pickup.scheduled":
    case "dispatch.assigned":
    case "stop.arrived":
    case "freight.counted":
    case "freight.photographed":
    case "dims.captured":
    case "custody.transferred":
    case "seal.applied":
    case "stop.departed":
    case "position.updated":
    case "exception.raised":
    case "osd.captured":
    case "pod.signed":
    case "delivery.evidenced":
    case "invoice.issued":
    case "invoice.corrected":
    case "payment.received":
    case "settlement.executed":
    case "split.computed":
    case "call.transcribed":
    case "document.attached":
    case "approval.requested":
    case "approval.decided":
    case "agent.acted":
    case "authority.flipped":
      return [];

    default: {
      const _never: never = e;
      return _never;
    }
  }
}

// INSERT OR IGNORE on the deterministic PK: a re-projection of the same event is a no-op (never a
// duplicate, never an UPDATE, and — critically — never a clobber of a resolution the Concierge already
// UPDATEd onto this row). `messages` is a mutable read-model with no append-only guard, but this INSERT
// path deliberately issues neither UPDATE nor DELETE — the ledger event is the immutable truth.
const MESSAGE_INSERT_SQL =
  "INSERT OR IGNORE INTO messages (id, channel, direction, party_id, shipment_id, resolved_conf, thread, body_ref, drafted_by_agent, sla_due_ts) " +
  "VALUES (?,?,?,?,?,?,?,?,?,?)";

/**
 * Prepared statements for the messages projection — NOT executed. The sequencer batches these with the
 * event INSERT so they share one transaction (I1: no message row without its event; no committed
 * message.* event without its row).
 */
export function applyMessageProjection(db: D1Database, e: LedgerEvent): D1PreparedStatement[] {
  return projectMessages(e).map((m) =>
    db
      .prepare(MESSAGE_INSERT_SQL)
      .bind(m.id, m.channel, m.direction, m.party_id, m.shipment_id, m.resolved_conf, m.thread, m.body_ref, m.drafted_by_agent, m.sla_due_ts),
  );
}
