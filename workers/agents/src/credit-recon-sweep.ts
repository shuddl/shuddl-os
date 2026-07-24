// Task 6 (REQ-042/183) — THE CREDIT PROJECTION-GAP RECONCILIATION SWEEP. The scheduled, proactive backstop to
// the DO booking gate's inline reconcile: a historical/imported credit.checked whose bill_to party had not yet
// materialized leaves an OPEN `credit_projection_gap` anomaly and an unprojected parties.credit_status. If no
// booking ever re-reads that party, the DO's inline reconcile never runs — so this per-tenant cron scans the
// open gaps and drives the SAME shared @shuddl/ledger reconciler, applying the latest valid decision once the
// party exists and marking the gap resolved. Both paths go through ONE implementation (no drift).
//
// FAIL CLOSED + BOUNDED + IDEMPOTENT: reconcileCreditForParty does nothing while the party is absent or no
// decision is on the ledger (the gap stays open, booking stays blocked), and re-applies the same state on a
// re-run — so re-running every cron tick is safe and self-clearing (a resolved gap drops out of the scan).
//
// TENANT ISOLATION (REQ-025): the caller binds `db` to ONE tenant's D1; the scan and every reconcile read/write
// are on that handle only, so a cross-tenant gap can never be touched.
import { reconcileCreditForParty } from "@shuddl/ledger/reconcile/credit";
import { CREDIT_PROJECTION_GAP_RULE } from "@shuddl/ledger/projection/status-cache";

export interface CreditReconSweepResult {
  /** DISTINCT parties with an open credit_projection_gap this pass. */
  scanned: number;
  /** Parties whose gap was reconciled (a decision applied) this pass. */
  resolved: number;
}

/**
 * Sweep ONE tenant's OPEN credit_projection_gap anomalies and reconcile each distinct party through the shared
 * ledger reconciler. The caller binds `db` to that one tenant (REQ-025). Idempotent + self-clearing.
 */
export async function sweepTenantCreditGaps(db: D1Database): Promise<CreditReconSweepResult> {
  const rows = (
    await db
      .prepare("SELECT DISTINCT object_id FROM anomalies WHERE rule = ? AND status = 'open' AND object_id IS NOT NULL")
      .bind(CREDIT_PROJECTION_GAP_RULE)
      .all<{ object_id: string }>()
  ).results;

  let resolved = 0;
  for (const r of rows) {
    try {
      const res = await reconcileCreditForParty(db, r.object_id);
      if (res.resolved) resolved += 1;
    } catch (err) {
      // A per-party fault is contained + logged, never fatal to the rest — the sweep is idempotent, so the next
      // tick re-drives this party (nothing was applied, the gap is still open).
      console.error(`credit-recon-sweep: reconcile failed for party ${r.object_id} (idempotent — next tick retries):`, err);
    }
  }
  return { scanned: rows.length, resolved };
}
