// REQ-015 / audit#11 — status_cache is a PROJECTION the sequencer maintains on shipments
// (state, assigned_driver, out_for_delivery). The driver lens and the map's city-granularity /
// out-for-delivery reveal read it; without it the driver lens stays empty. Mutable projection, not
// truth. These statements ride in the event's db.batch().
import type { LedgerEvent } from "@shuddl/contracts";

const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const asInt = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) ? v : undefined;

// booking.created must CREATE the shipments row (it is the first event on the stream) so later
// json_set projections have a row to update. Idempotent via ON CONFLICT.
const BOOKING_SQL =
  "INSERT INTO shipments (id, division, shipper_party_id, consignee_party_id, bill_to_party_id, status_cache, created_ts) " +
  "VALUES (?, ?, ?, ?, ?, json_object('state','booked'), ?) " +
  "ON CONFLICT(id) DO UPDATE SET status_cache = json_set(shipments.status_cache, '$.state', 'booked')";

/**
 * The status_cache mutation an event implies. booking.created upserts the shipment row (state
 * booked); dispatch.assigned -> dispatched + assigned_driver; custody.transferred -> in_transit;
 * stop.departed(out_for_delivery=true) -> OFD; pod.signed -> delivered; exception.raised ->
 * exception. Every other kind touches nothing. Events with no shipment stream project nothing.
 */
export function projectStatusCache(db: D1Database, e: LedgerEvent): D1PreparedStatement[] {
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
      const createdTs = asInt(p["created_ts"]) ?? e.ts;
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
