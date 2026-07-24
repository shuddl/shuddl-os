// Task 6 (REQ-042/183) — THE CREDIT PROJECTION-GAP RECONCILER.
//
// A historical/imported credit.checked whose bill_to party had not yet materialized leaves an OPEN
// `credit_projection_gap` anomaly (surfaceCreditProjectionGapIfMissed) and an UNPROJECTED
// parties.credit_status. That is a silent-defeat risk: the REQ-042 booking credit-hold gate reads a NULL
// credit_status and passes as if the party were clear. This shared, pure-of-side-effects-beyond-D1 function
// closes the gap fail-closed once the party exists — it is invoked BY the DO booking gate (before it re-reads
// credit) AND proactively BY the agents cron (workers/agents/src/credit-recon-sweep.ts), so both paths reconcile
// through ONE implementation (no drift).
//
// FAIL CLOSED: while the party is still absent OR no credit.checked decision is on the ledger, this does
// NOTHING — the gap stays open, so the booking gate keeps blocking (assertBookingCredit's creditGapUnresolved).
// It NEVER fabricates a party row (append-only / no-invented-data law — the same guard status-cache's CREDIT_SQL
// rationale protects). REQ-024: no LLM, no external — pure D1 read-model reconciliation, legal in @shuddl/ledger.
//
// TENANT ISOLATION (REQ-025): the caller binds `db` to ONE tenant's D1; every read and write here is on that
// handle only, so a cross-tenant credit.checked / gap can never leak into or out of the reconciled tenant.
import { CREDIT_PROJECTION_GAP_RULE } from "../projection/status-cache.js";

export interface CreditReconResult {
  /** The party this reconcile targeted. */
  party_id: string;
  /** TRUE iff a decision was applied AND the gap(s) were marked resolved this call. */
  resolved: boolean;
  /** The credit decision applied to parties.credit_status, or null when none was applied (fail-closed no-op). */
  applied_status: string | null;
}

/**
 * Reconcile ONE party's credit projection gap. If the party now EXISTS and a credit.checked decision is on the
 * ledger, apply the LATEST valid decision to parties.credit_status AND mark every OPEN credit_projection_gap
 * anomaly for that party 'resolved' — in ONE idempotent D1 batch. Otherwise do nothing (fail closed). Re-running
 * is a no-op (re-applying the same decision + re-resolving an already-resolved anomaly both land the same state).
 */
export async function reconcileCreditForParty(db: D1Database, partyId: string): Promise<CreditReconResult> {
  // GAP-GATED: reconcile ACTS only when an OPEN credit_projection_gap for this party actually exists. With no gap
  // there is nothing to reconcile, so this is a strict no-op — it NEVER re-writes parties.credit_status on a
  // normal booking (which would side-effect the mutable read-model on every gate evaluation). The gap presence is
  // the trigger; the reconcile is the effect.
  const gap = await db
    .prepare("SELECT 1 AS present FROM anomalies WHERE rule = ? AND object_id = ? AND status = 'open' LIMIT 1")
    .bind(CREDIT_PROJECTION_GAP_RULE, partyId)
    .first();
  if (gap === null) return { party_id: partyId, resolved: false, applied_status: null };

  // The party MUST exist — never fabricate one (append-only law). Absent → fail-closed no-op (gap stays open).
  const party = await db.prepare("SELECT id FROM parties WHERE id = ?").bind(partyId).first();
  if (party === null) return { party_id: partyId, resolved: false, applied_status: null };

  // The LATEST valid credit.checked decision for this party on THIS tenant's ledger. Ordering: recorded_at
  // (server-append time) then seq — a later clear supersedes an earlier hold. json_extract reads the party_id /
  // status off the stored payload (the same shape status-cache's projection writes).
  const row = await db
    .prepare(
      "SELECT json_extract(payload, '$.status') AS status FROM events " +
        "WHERE kind = 'credit.checked' AND json_extract(payload, '$.party_id') = ? " +
        "ORDER BY recorded_at DESC, seq DESC LIMIT 1",
    )
    .bind(partyId)
    .first<{ status: string | null }>();
  const status = row?.status ?? null;
  // No decision on the ledger → fail-closed no-op (the gap stays open; the booking gate keeps blocking).
  if (status === null) return { party_id: partyId, resolved: false, applied_status: null };

  // ONE batch (atomic): apply the decision to the mutable parties read-model + resolve every OPEN gap for this
  // party. Idempotent — a re-run re-applies the same value and re-resolves an already-resolved anomaly.
  await db.batch([
    db.prepare("UPDATE parties SET credit_status = ? WHERE id = ?").bind(status, partyId),
    db
      .prepare("UPDATE anomalies SET status = 'resolved' WHERE rule = ? AND object_id = ? AND status = 'open'")
      .bind(CREDIT_PROJECTION_GAP_RULE, partyId),
  ]);
  return { party_id: partyId, resolved: true, applied_status: status };
}
