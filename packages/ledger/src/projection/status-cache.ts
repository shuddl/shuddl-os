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

// REQ-183 — CREDIT_SQL is a SILENT NO-OP when the party row does not exist yet: the UPDATE matches nothing,
// so a credit.checked{hold} recorded BEFORE its party materializes never lands, a later booking.created reads
// a NULL parties.credit_status, and the REQ-042 credit-hold gate is silently DEFEATED (the hold passes as if
// clear). This makes that miss LOUD instead of silent. It does NOT fabricate a party row — inventing a party
// the ledger never created would violate the append-only / no-invented-data law (and the CREDIT_SQL rationale
// above guards exactly that). The credit.checked event stands on the ledger as truth; the GAP is only that the
// PROJECTION could not APPLY it yet. Surfacing it — a loud structured log the recon/Watchtower catches PLUS a
// durable row on the MUTABLE `anomalies` ops table (no new event kind, no new table, reusing T8) — lets an
// operator create the party and re-project, so a recorded hold is never silently lost.
export const CREDIT_PROJECTION_GAP_RULE = "credit_projection_gap";

/**
 * Surface a LOUD gap when the credit.checked → parties.credit_status projection was a no-op (party absent).
 * Call it AFTER the append batch commits with the CREDIT_SQL statement's rows-affected (available on the D1
 * batch result). A no-op (`creditRowsAffected === 0`) is the gap; a hit (>0) short-circuits. Idempotent per
 * event id so a redelivered credit.checked collapses to one anomalies row. Never fabricates a party row.
 * The `anomalies` table lives in the per-tenant D1, so tenant scoping is implicit (no tenant column).
 */
export async function surfaceCreditProjectionGapIfMissed(
  db: D1Database,
  e: LedgerEvent,
  creditRowsAffected: number,
): Promise<void> {
  if (e.kind !== "credit.checked") return; // defensive: only this projection carries the silent-no-op hazard
  if (creditRowsAffected !== 0) return; // the UPDATE landed on an existing party — nothing to surface
  const partyId = asString(e.payload["party_id"]) ?? "unknown";
  const status = asString(e.payload["status"]) ?? "unknown";
  // LOUD, emitted unconditionally on a miss so the gap is caught even if the durable write below fails.
  console.error(
    `[REQ-183] credit.checked projection GAP: parties.credit_status UPDATE affected 0 rows — party '${partyId}' ` +
      `does not exist yet, so the credit decision '${status}' (event ${e.id}) did NOT land and the REQ-042 ` +
      `credit-hold gate would read NULL and PASS. NOT fabricating a party row (append-only law); create the ` +
      `party then re-project. The credit.checked event stands on the ledger as truth.`,
  );
  // Durable ops signal on the MUTABLE anomalies table (no append-only guard, no new table/kind). ON CONFLICT
  // (deterministic id keyed by event id) keeps a redelivered event to exactly one row — never INSERT OR REPLACE
  // (that verb is lint-banned; ON CONFLICT DO UPDATE is not). Critical: a defeated credit gate is a mis-bill risk.
  await db
    .prepare(
      // `status = 'open'` added 2026-08-15 (audit §1541 — the THIRD instance of §1539/§1540, and the only
      // `critical` one). The id is keyed on the EVENT id, so no re-projection will ever mint a different one:
      // if an operator marked this resolved and the party still did not exist, the next re-projection refreshed
      // `detail` and left the row 'resolved' — a defeated credit gate, which this comment already calls a
      // mis-bill risk, sitting invisible behind every ops read of the table (all of which filter status='open').
      // The upsert FORM was already right here, which is why two conflict-clause sweeps walked past it: what
      // was wrong was the SET list.
      "INSERT INTO anomalies (id, rule, object_kind, object_id, severity, detail, status) VALUES (?,?,?,?,?,?,'open') " +
        "ON CONFLICT(id) DO UPDATE SET severity = excluded.severity, detail = excluded.detail, status = 'open'",
    )
    .bind(
      `credit-projection-gap:${e.id}`,
      CREDIT_PROJECTION_GAP_RULE,
      "party",
      partyId,
      "critical",
      JSON.stringify({ party_id: partyId, status, event_id: e.id, reason: "party_row_absent" }),
    )
    .run();
}

// WP-08 T5 (REQ-028/052) — leg materialization, a T5→T4 COUPLING. appointment.set claims a dock slot by
// UPDATING a leg row (WHERE shipment_id=? AND kind=?), so the leg MUST exist first. booking.created — the
// first event on a shipment stream — INSERTs the two customer-facing skeleton legs (pickup seq 0, delivery
// seq 1) in the SAME batch that creates the shipments row. Deterministic ids `${id}:pickup` / `${id}:delivery`.
// executor_party_id = bill_to_party_id is a PROVISIONAL placeholder (mutable; dispatch/T8 refines the real
// executor). appt_* columns are left NULL, so a skeleton leg is EXCLUDED from ux_legs_slot (the partial index
// is `WHERE appt_slot_key IS NOT NULL`) — two un-appointed legs never collide. INSERT OR IGNORE keeps
// re-projection idempotent AND leaves a Concierge quote-stage leg (if any pre-exists) untouched. PLAIN insert
// — never INSERT OR REPLACE (REPLACE would delete THROUGH ux_legs_slot = silent slot theft on the mutable table).
//
// ONE-LEG-PER-(shipment, kind) INVARIANT (v1): downstream provisioning (dispatch/T8) must UPDATE these
// deterministic `${id}:pickup` / `${id}:delivery` rows in place (real geo, executor, appt claim), NEVER INSERT
// a sibling leg of the same kind. The delivery-geo consumers (#deliveryFence in sequencer.ts, deliveryStopGeo
// in biller.ts) prefer a NON-EMPTY-geo delivery leg as a backstop so a stray sibling cannot shadow the real
// fence — but multi-stop (a second real leg per kind) is out of scope until a register amendment adds a leg
// seq/id to AppointmentSetPayload.
const LEG_SKELETON_SQL =
  "INSERT OR IGNORE INTO legs (id, shipment_id, seq, kind, executor_party_id, geo) VALUES (?,?,?,?,?,'{}')";

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
      // Order is load-bearing: the shipments upsert FIRST (legs.shipment_id -> shipments(id) FK), then the
      // two skeleton legs appointment.set will claim slots against (WP-08 T5). billTo is the provisional executor.
      return [
        db.prepare(BOOKING_SQL).bind(shipmentId, division, shipper, consignee, billTo, createdTs),
        db.prepare(LEG_SKELETON_SQL).bind(`${shipmentId}:pickup`, shipmentId, 0, "pickup", billTo),
        db.prepare(LEG_SKELETON_SQL).bind(`${shipmentId}:delivery`, shipmentId, 1, "delivery", billTo),
      ];
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
