// WP-10 T2 (REQ-082/194) — the approvals-QUEUE read-model projection. The ledger event is truth; `approvals`
// is the mutable projection the command surface (WP-10) lists and the decision route reads. Two events drive it:
//   - approval.requested → INSERT an OPEN row (the below-floor gate the Rater recorded, REQ-030/048): its
//     rule + required_role come straight off the event payload (server-computed in rate.ts / assessApproval),
//     the object is the shipment stream, requested_event_id pins the originating event.
//   - approval.decided   → flip that row to status='decided' and pin decided_event_id to the deciding event.
//     WHO decided + the approve/deny outcome live on the append-only approval.decided EVENT (its payload), not
//     a projection column — the read-model links to that truth via decided_event_id (the schema carries no
//     decider/decision column, and an open-queue read never needs one). REQ-082/194.
//
// `approvals` is an UNGUARDED (mutable) domain read-model — NOT append-only-guarded (only events / positions /
// money_lines are, 0003_insert_guards.sql). So an UPDATE is legal here (mirrors status-cache's parties UPDATE),
// and the INSERT is PLAIN `INSERT OR IGNORE` on the PK — never INSERT OR REPLACE (REPLACE would DELETE the row
// through the PK before re-inserting; there is no reason to, and it would drop a decided row's decided_event_id).
// Both statements are IDEMPOTENT under the sequencer's replay-by-event-id (a redelivered event re-runs the same
// projection): OR IGNORE no-ops on the existing id; the decided UPDATE re-lands identical values. These rows ride
// in the event's db.batch() (I1) — the projection and its event commit together or not at all.
//
// PURE — no Date / LLM / I/O (REQ-024); a pure function of the event, mirroring appointment.ts / status-cache.ts.
import type { LedgerEvent } from "@shuddl/contracts";

const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

// The approvals-table columns used (0002_domain.sql:72-75): id, object_kind, object_id, rule, required_role,
// requested_event_id, status. decided_event_id defaults NULL. The row id IS the requested event id — unique per
// approval.requested and deterministic across a replay, so OR IGNORE dedupes a redelivery cleanly.
const OPEN_SQL =
  "INSERT OR IGNORE INTO approvals (id, object_kind, object_id, rule, required_role, requested_event_id, status) " +
  "VALUES (?, 'shipment', ?, ?, ?, ?, 'open')";

// Flip the OPEN row for the originating approval.requested to decided + pin the deciding event. Keyed on
// requested_event_id (the stable link the decision route stamps into the approval.decided payload).
const DECIDED_SQL = "UPDATE approvals SET status = 'decided', decided_event_id = ? WHERE requested_event_id = ?";

/**
 * The approvals read-model mutation an event implies. approval.requested opens a row (keyed to the shipment
 * stream); approval.decided flips the matching row to decided and pins the deciding event. Every other kind,
 * and an approval.requested on a non-shipment stream (no object to key), projects nothing.
 */
export function projectApprovals(db: D1Database, e: LedgerEvent): D1PreparedStatement[] {
  if (e.kind === "approval.requested") {
    // The approval is ABOUT a shipment's below-floor quote; keyed by the shipment stream. approval.requested's
    // payload is untyped (JsonObject in the contract), so this projects ONLY a well-formed below-floor gate event
    // — one carrying a shipment_id AND rule AND required_role (the exact shape rate.ts / assessApproval emit).
    // A bare/other-shaped approval.requested (e.g. a future non-gate use) simply opens NO queue row rather than
    // aborting the whole append: the ledger event stays truth, the read-model is best-effort. This is the
    // status-cache "return [] for what I don't handle" discipline — NOT a throw (a throw here would couple every
    // approval.requested append to this exact payload shape and break the append for any other shape).
    if (e.shipment_id === undefined) return [];
    const p = e.payload;
    const rule = asString(p["rule"]);
    const requiredRole = asString(p["required_role"]);
    if (rule === undefined || requiredRole === undefined) return [];
    return [db.prepare(OPEN_SQL).bind(e.id, e.shipment_id, rule, requiredRole, e.id)];
  }

  if (e.kind === "approval.decided") {
    // The decision route stamps requested_event_id into the payload (the stable link to the OPEN row). Absent ⇒
    // there is no row this could resolve to — project nothing (tolerant, mirrors the requested branch above).
    const requestedEventId = asString(e.payload["requested_event_id"]);
    if (requestedEventId === undefined) return [];
    return [db.prepare(DECIDED_SQL).bind(e.id, requestedEventId)];
  }

  return [];
}
