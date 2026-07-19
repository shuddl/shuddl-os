// WP-11 Task 8 (REQ-036) — the SHARED "unbilled" anti-join predicate.
//
// A shipment is UNBILLED iff it has a committed `pod.signed` but NO `invoice.issued` (a POD-without-invoice
// anti-join). This ONE definition is consumed by BOTH:
//   · the KPI compute (workers/api/src/kpis/compute.ts `computeUnbilled`) — the command "=0" tile, and
//   · the Watchtower alarm (workers/agents/src/watchtower.ts) — the durable `anomalies` alarm.
// Extracting it here makes the KPI number the command shows and the durable alarm the Watchtower raises
// IMPOSSIBLE to drift apart (skill share-lint-matchers-with-parity-tests): they are the same SQL, and a
// behavioural parity test (test/watchtower.test.ts) locks that they agree on the same data. The `pod.signed`
// existence half mirrors the invoice gate (packages/ledger/src/gates/invoice-gate.ts); here it is inverted
// set-wise and anti-joined against `invoice.issued` on the same shipment.
//
// PURE SQL — no LLM, no I/O (REQ-024): this module is a query builder, safe to live in packages/ledger.

/** The kind whose existence (per shipment) marks a delivered, billable shipment. */
export const UNBILLED_POD_KIND = "pod.signed";
/** The kind whose ABSENCE (per shipment) marks the shipment still unbilled. */
export const UNBILLED_INVOICE_KIND = "invoice.issued";

/**
 * Build the unbilled anti-join query. `select` is the projection over the driving `events p` rows (a HARDCODED
 * literal at every call site — e.g. `COUNT(DISTINCT p.shipment_id) AS n` for the KPI, `p.shipment_id AS
 * shipment_id, p.ts AS pod_ts` for the Watchtower detail — NEVER user input). `scopeClause` is an optional
 * caller-built, BOUND `LIKE ?` fragment on `p.shipment_id` (the shared test-scope hook — see scopeLike) or the
 * empty string for a whole-tenant read; it is bound, never interpolated. The anti-join core (the kinds + the
 * NOT EXISTS) is the single source of truth both consumers share.
 */
export function unbilledShipmentsSql(select: string, scopeClause = ""): string {
  return (
    `SELECT ${select} FROM events p ` +
    `WHERE p.kind = '${UNBILLED_POD_KIND}' AND p.shipment_id IS NOT NULL${scopeClause} ` +
    `AND NOT EXISTS (SELECT 1 FROM events i WHERE i.kind = '${UNBILLED_INVOICE_KIND}' AND i.shipment_id = p.shipment_id)`
  );
}

/**
 * A bound `LIKE ?` scope fragment — the SHARED test-scope hook used across the KPI computes and the Watchtower
 * sweep. `col` is a HARDCODED literal at every call site (never user input); `scope` is pushed as a BOUND param
 * (`${scope}%`) so it can never be an injection or widen the read. Returns "" (no fragment) when scope is
 * undefined — the production whole-tenant read. Extracted here so the KPI compute and the Watchtower apply the
 * identical scoping rule (no drift), and so the parity test can scope both onto the same rows of the shared D1.
 */
export function scopeLike(col: string, scope: string | undefined, params: (string | number)[]): string {
  if (scope === undefined) return "";
  params.push(`${scope}%`);
  return ` AND ${col} LIKE ?`;
}
