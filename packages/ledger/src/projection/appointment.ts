// WP-08 T5 (REQ-028/052) — the appointment.set read-model projection: a dock-slot CLAIM on the shipment's
// leg row. The ledger event is truth; `legs` is the mutable projection that carries the claim so the atomic
// ux_legs_slot UNIQUE INDEX can arbitrate double-books. This statement rides in the event's db.batch() (I1),
// so the claim and its event commit together or not at all.
//
// TARGET BY (shipment_id, kind) — NOT a synthesized leg id: booking.created materializes `${id}:pickup` while
// the test harness's seedLeg uses `leg-${id}-${seq}`, so only (shipment_id, kind) matches both. ONE PLAIN
// UPDATE serves BOTH a fresh set AND a reschedule (it overwrites the occurrence columns atomically). A
// reschedule to a new slot frees the old one in the SAME write (the row no longer references it), so the
// vacated (facility, slot, service_date) is immediately claimable by another stream.
//
// PLAIN UPDATE ONLY — NEVER INSERT OR REPLACE / REPLACE INTO / ON CONFLICT…DO UPDATE on `legs`: legs is an
// UNGUARDED (mutable) table, so a REPLACE would DELETE the pre-existing row THROUGH ux_legs_slot before
// re-inserting = silent slot theft with no guard to catch it. The tools/checks legs-REPLACE lint enforces this.
//
// `service_date` (canonical YYYY-MM-DD in the facility tz = the occurrence key) is computed ONCE in the DO
// caller (impure tz math) and passed in, so this projection stays a PURE function of its inputs — no Date here.
import type { LedgerEvent, AppointmentSetPayload } from "@shuddl/contracts";

const APPT_CLAIM_SQL =
  "UPDATE legs SET facility_id=?, appt_slot_key=?, appt_service_date=?, appt_window_start_ts=?, appt_window_end_ts=? " +
  "WHERE shipment_id=? AND kind=?";

/**
 * The leg-claim UPDATE an appointment.set implies. Returns [] for every other kind, for an appointment.set on
 * a non-shipment stream, or when the caller has no computed service_date (both mean nothing to claim). The
 * kind = payload.leg_kind targets the matching (pickup|delivery) skeleton leg materialized by booking.created.
 */
export function projectAppointment(
  db: D1Database,
  e: LedgerEvent,
  serviceDate: string | undefined,
): D1PreparedStatement[] {
  if (e.kind !== "appointment.set" || serviceDate === undefined || e.shipment_id === undefined) return [];
  const p: AppointmentSetPayload = e.payload;
  return [
    db
      .prepare(APPT_CLAIM_SQL)
      .bind(p.facility_id, p.slot_key, serviceDate, p.window_start_ts, p.window_end_ts, e.shipment_id, p.leg_kind),
  ];
}
