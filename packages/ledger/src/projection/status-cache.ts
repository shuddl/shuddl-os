// REQ-015 / audit#11 — status_cache is a PROJECTION the sequencer maintains on shipments
// (state, assigned_driver, out_for_delivery). The driver lens and the map's city-granularity /
// out-for-delivery reveal read it; without it the driver lens stays empty. Mutable projection, not
// truth. These statements ride in the event's db.batch().
import type { LedgerEvent } from "@shuddl/contracts";

const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

// booking.created must CREATE the shipments row (it is the first event on the stream) so later
// json_set projections have a row to update. Idempotent via ON CONFLICT.
//
// PARTY-CORRECTION (REQ-181; REQ-057 is the downstream division-codes rationale): booking.created is the
// event that names the shipment's REAL consignee / bill_to, closing the WP-07 quote-stage self-reference. A
// Concierge quote-stage shipment (WP-07 resolve.ts) already exists with all THREE party FKs self-referenced
// to the requester — so on CONFLICT we must ALSO overwrite consignee_party_id and bill_to_party_id from the
// booking payload (via `excluded`, the would-be-inserted VALUES), not just flip status_cache.state. On a
// FRESH INSERT all three FKs still come straight from the VALUES tuple (unchanged). Only booking.created
// carries this SET clause — no later status event (dispatch.assigned, etc.) touches the party FKs, so a
// correction can never be clobbered downstream.
//
// shipper_party_id is INTENTIONALLY kept as-is (deliberately NOT in the SET clause): the quote REQUESTER *is*
// the shipper (resolve.ts), so its FK is already correct and booking never re-parents it. This is an
// ASSUMPTION to revisit if a future flow ever names a shipper ≠ the requester — then this SET clause would
// have to correct shipper_party_id too.
const BOOKING_SQL =
  "INSERT INTO shipments (id, division, shipper_party_id, consignee_party_id, bill_to_party_id, status_cache, created_ts) " +
  "VALUES (?, ?, ?, ?, ?, json_object('state','booked'), ?) " +
  "ON CONFLICT(id) DO UPDATE SET " +
  "consignee_party_id = excluded.consignee_party_id, " +
  "bill_to_party_id = excluded.bill_to_party_id, " +
  "status_cache = json_set(shipments.status_cache, '$.state', 'booked')";

// credit.checked (REQ-042) projects a party's credit decision onto parties.credit_status so the T6
// credit-hold gate has a state to read. parties is a MUTABLE domain read-model (NOT an append-only-guarded
// table — events/positions/money_lines are), so an UPDATE is legal here. The column already exists in
// 0002_domain.sql (`parties.credit_status TEXT`, nullable) — no migration adds it. The UPDATE is idempotent
// (re-projecting the same decision lands the same value) and only affects an EXISTING party row (a credit
// decision presupposes the party), so a stray party_id is a silent no-op rather than a fabricated row.
const CREDIT_SQL = "UPDATE parties SET credit_status = ? WHERE id = ?";

/**
 * The tenant-plane read-model mutation an event implies. booking.created upserts the shipment row (state
 * booked) AND corrects consignee/bill_to on an existing Concierge row (REQ-181); dispatch.assigned ->
 * dispatched + assigned_driver; custody.transferred -> in_transit; stop.departed(out_for_delivery=true) ->
 * OFD; pod.signed -> delivered; exception.raised -> exception; credit.checked -> parties.credit_status
 * (REQ-042). Every other kind touches nothing. Shipment-scoped kinds with no shipment stream project nothing.
 */
export function projectStatusCache(db: D1Database, e: LedgerEvent): D1PreparedStatement[] {
  // credit.checked is PARTY-scoped (keyed by payload.party_id), not shipment-scoped, and may carry no
  // shipment_id — so it must project BEFORE the shipment guard below, or a credit decision without a
  // shipment would be silently dropped. It feeds ONLY the parties read-model (single-table fan-out).
  if (e.kind === "credit.checked") {
    const p = e.payload;
    const partyId = asString(p["party_id"]);
    const status = asString(p["status"]);
    if (partyId === undefined || status === undefined) {
      throw new Error("credit.checked: payload must carry party_id and status");
    }
    return [db.prepare(CREDIT_SQL).bind(status, partyId)];
  }

  const shipmentId = e.shipment_id;
  if (shipmentId === undefined) return [];

  const setState = (state: string): D1PreparedStatement =>
    db.prepare("UPDATE shipments SET status_cache = json_set(status_cache, '$.state', ?) WHERE id = ?").bind(state, shipmentId);

  switch (e.kind) {
    case "booking.created": {
      const p = e.payload;
      const division = asString(p["division"]) ?? "main";
      const shipper = asString(p["shipper_party_id"]);
      const consignee = asString(p["consignee_party_id"]);
      const billTo = asString(p["bill_to_party_id"]);
      // WP-08: booking.created is now strictly typed (BookingCreatedPayload) and no longer carries a
      // created_ts — the envelope's `ts` is the shipment's created_ts (identical to the legacy value the
      // seed used to inline). shipments.created_ts is a projection of the booking event's ts.
      const createdTs = e.ts;
      if (shipper === undefined || consignee === undefined || billTo === undefined) {
        throw new Error("booking.created: payload must carry shipper_party_id / consignee_party_id / bill_to_party_id");
      }
      return [db.prepare(BOOKING_SQL).bind(shipmentId, division, shipper, consignee, billTo, createdTs)];
    }
    case "dispatch.assigned": {
      const driver = e.actor.user;
      if (driver !== undefined) {
        return [
          db
            .prepare("UPDATE shipments SET status_cache = json_set(status_cache, '$.state', 'dispatched', '$.assigned_driver', ?) WHERE id = ?")
            .bind(driver, shipmentId),
        ];
      }
      return [setState("dispatched")];
    }
    case "custody.transferred":
      return [setState("in_transit")];
    case "stop.departed":
      // v1 rule: OFD flips ONLY when the driver PWA sets payload.out_for_delivery (WP-05). A plain
      // stop.departed / position.updated never flips it.
      if ((e.payload as { out_for_delivery?: unknown })["out_for_delivery"] === true) {
        return [
          db
            .prepare("UPDATE shipments SET status_cache = json_set(status_cache, '$.out_for_delivery', json('true')) WHERE id = ?")
            .bind(shipmentId),
        ];
      }
      return [];
    case "pod.signed":
      return [setState("delivered")];
    case "exception.raised":
      return [setState("exception")];
    default:
      return [];
  }
}
