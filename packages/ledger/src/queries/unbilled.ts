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

// ── WP-15 Task 4b (REQ-021/022/030) — the NATIVE-VISIBLE SOURCE predicate ──────────────────────────────────
// A `source:'legacy'` event is a SHADOW mirror record of the incumbent's history: it lives in `events` for the
// native-vs-legacy PARITY compute ONLY (computeModuleParity reads `source IN ('native','legacy')`) and must
// drive NO native read-model / KPI / AR / alarm. The projection layer is the FIRST lock (the sequencer skips
// every projection spread for a legacy event, so money_lines/invoices/status/legs/… carry no legacy row); this
// predicate is the SECOND lock, for the native reads that aggregate the `events` table DIRECTLY. Native
// read-models include SHUDDL's own facts PLUS the inbound EDI/email seams — everything EXCEPT the legacy shadow.
// Defined ONCE and shared by every native aggregate read (the KPI computes, the metrics module, the Watchtower
// sweeps) so "what counts as native" can never drift (skill share-lint-matchers-with-parity-tests) — the exact
// complement of parity.ts's TRACKED_SOURCES (native+legacy). The source literals are a FROZEN, code-owned enum
// (the events.source CHECK), never client input, so they are interpolated literally exactly like UNBILLED_POD_KIND
// above — no bound param needed. INERT on all pre-legacy data (every native/edi/email row already matches).
export const NATIVE_VISIBLE_SOURCES = ["native", "edi", "email"] as const;

/** A native-visible SQL predicate ` AND <col> IN ('native','edi','email')` — restricts a native aggregate read
 *  over `events` to the native-visible sources (EXCLUDES the `legacy` shadow). `col` is a HARDCODED literal at
 *  every call site (e.g. "p.source", "source", "ev.source"), never user input. */
export function nativeVisibleSourceSql(col: string): string {
  return ` AND ${col} IN (${NATIVE_VISIBLE_SOURCES.map((s) => `'${s}'`).join(",")})`;
}

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
    // WP-15 Task 4b — the DRIVING pod.signed aggregate is native-visible ONLY: a `source:'legacy'` pod (a mirror
    // shadow) must never count toward the unbilled alarm OR the recon RE-DRIVE (a legacy stream even carries a
    // synthetic shipments row, so the recon's EXISTS(shipments) would otherwise re-bill it). The `i` anti-join
    // needs no filter — a legacy invoice lands on a legacy shipment_id namespace (shp_lg_…), never a native one.
    `SELECT ${select} FROM events p ` +
    `WHERE p.kind = '${UNBILLED_POD_KIND}' AND p.shipment_id IS NOT NULL${nativeVisibleSourceSql("p.source")}${scopeClause} ` +
    `AND NOT EXISTS (SELECT 1 FROM events i WHERE i.kind = '${UNBILLED_INVOICE_KIND}' AND i.shipment_id = p.shipment_id)`
  );
}

// ── WP-11 Task 13 (REQ-169) — the Biller reconciliation RE-DRIVE predicate + the terminal-hold marker ──────
//
// The reconciliation sweep (workers/agents/src/recon-sweep.ts) re-enqueues the Biller for any stream that was
// DELIVERED (a committed pod.signed) but never billed AND never permanently held — the exact commit→enqueue
// lost-trigger window. It reuses the SAME anti-join core above (pod.signed AND NOT invoice.issued — no drift)
// and ADDS two exclusions so the re-enqueue is BOUNDED:
//   · a TERMINAL HOLD MARKER exclusion — once the Biller permanently holds a POD (below_floor / no_quote /
//     interline_unresolved / anomaly) it appends a durable internal note (message.received{channel:note,
//     visibility:internal}) whose body_ref carries the `TERMINAL_HOLD_BODY_REF_PREFIX`. A shipment with such a
//     marker is EXCLUDED, so a permanently-held POD is re-enqueued at most until the marker is written (once),
//     then never again — otherwise the anti-join would re-drive a permanent hold every cron tick, forever.
//   · an AGE filter (caller-built bound fragment on p.recorded_at) — a just-committed POD's trigger may still be
//     in flight, so only PODs older than the window are re-driven (the age is measured from COMMIT time).
//
// The Biller EMITS the marker with `terminalHoldBodyRef` and the recon query EXCLUDES on
// `TERMINAL_HOLD_BODY_REF_PREFIX` — ONE definition, shared by both, so the emit and the exclusion can never
// drift (skill share-lint-matchers-with-parity-tests). The reason rides IN the body_ref (message.received's
// payload is .strict(), so no extra field) — and is the human-readable surfacing of the hold (REQ-036).

/** The body_ref prefix that marks a Biller terminal-hold note. The recon anti-join EXCLUDES any shipment
 *  carrying a note with this prefix; the Biller writes it via `terminalHoldBodyRef`. Single source of truth. */
export const TERMINAL_HOLD_BODY_REF_PREFIX = "biller-terminal-hold/";

/** The DETERMINISTIC body_ref for a Biller terminal-hold marker on (shipment, reason). `reason` is one of the
 *  terminal BillerOutcome held reasons (below_floor / no_quote / interline_unresolved / anomaly) — a clean slug,
 *  safe in the ref and in the exclusion LIKE. */
export function terminalHoldBodyRef(shipmentId: string, reason: string): string {
  return `${TERMINAL_HOLD_BODY_REF_PREFIX}${shipmentId}/${reason}`;
}

/** The event kind the terminal-hold marker rides on — an internal note reuses the existing message.received kind
 *  (NO new kind; the 35-catalog is frozen). */
export const UNBILLED_HOLD_MARKER_KIND = "message.received";

/**
 * Build the reconciliation RE-DRIVE anti-join: the shared unbilled predicate (pod.signed, no invoice.issued),
 * EXTENDED with the terminal-hold-marker exclusion and an optional caller-built, BOUND `ageClause` on
 * `p.recorded_at` (e.g. ` AND p.recorded_at < ?`, its param pushed by the caller). Reuses `unbilledShipmentsSql`
 * verbatim for the core so the "unbilled" definition stays a single source of truth. `select`/`scopeClause`
 * follow the same rules as `unbilledShipmentsSql` (hardcoded literal / bound `LIKE ?`, never user input). The
 * hold-marker prefix is a hardcoded constant interpolated literally (mirrors the UNBILLED_*_KIND interpolation).
 */
export function unbilledRedriveSql(select: string, scopeClause = "", ageClause = ""): string {
  return (
    unbilledShipmentsSql(select, scopeClause) +
    ` AND NOT EXISTS (SELECT 1 FROM events h WHERE h.kind = '${UNBILLED_HOLD_MARKER_KIND}' AND h.shipment_id = p.shipment_id` +
    ` AND json_extract(h.payload, '$.body_ref') LIKE '${TERMINAL_HOLD_BODY_REF_PREFIX}%')` +
    // REQ-199 (WP-11 exit audit) — only re-enqueue a BILLABLE stream: one with a shipments row. An orphan
    // pod.signed on an un-booked / legacy-replayed stream (no shipments row → the Biller returns
    // shipment_not_found and writes no marker) is NOT re-drivable (the Biller can never bill it), so re-driving
    // it every cron tick is futile + unbounded. Excluding it here bounds the re-drive. The SHARED
    // unbilledShipmentsSql is left UNCHANGED, so the Watchtower "unbilled" alarm still surfaces the data fault.
    ` AND EXISTS (SELECT 1 FROM shipments s WHERE s.id = p.shipment_id)` +
    ageClause
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
