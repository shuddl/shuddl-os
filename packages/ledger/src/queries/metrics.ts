// WP-11 Task 10 (REQ-160 / REQ-083) — the SHARED health-metric computes.
//
// THREE of these seven metrics were the WP-10 KPI computes (workers/api/src/kpis/compute.ts): computeUnbilled,
// computeDsoDays, computeCostRatioBps. They are MOVED here (verbatim) so BOTH consumers import the ONE source:
//   · the command KPI strip (workers/api/src/kpis/compute.ts re-exports them — the route is unchanged), and
//   · the weekly Watchtower telemetry snapshot (workers/agents/src/watchtower-snapshot.ts).
// A behavioural parity test (workers/api/test/watchtower-snapshot.test.ts) locks that the snapshot and the KPI
// route agree on the same data — they are the SAME function, so they cannot drift (skill share-lint-matchers-
// with-parity-tests, the same discipline T8's unbilled predicate uses).
//
// FOUR are NET-NEW for the snapshot (REQ-160): POD→invoice latency, rating latency, disputes, close duration.
//
// THE HONESTY LAW (WP-10/11): every metric is a REAL number computed from real ledger rows, OR the literal
// "UNKNOWN" — NEVER a fabricated/placeholder value. Missing data → UNKNOWN (the L3 / "no price on air" ethos).
// INTEGER-ONLY math (cents / ms / days / bps); a clock-skewed negative duration is DROPPED, never averaged in.
//
// PURE SQL — no LLM, no I/O beyond the injected D1 (REQ-024): this module is a read-query builder, safe to live
// in packages/ledger. `scope` (an id PREFIX) is applied ONLY as a BOUND `LIKE ?` param over server-derived id
// columns (never interpolated, never client input) — the shared test-scope hook the KPI computes already use.

import { scopeLike, unbilledShipmentsSql, nativeVisibleSourceSql } from "./unbilled.js";

const DAY_MS = 86_400_000;
/** The trailing window (7 days) the WEEKLY snapshot passes to the FLOW metrics (latency/duration), so each
 *  weekly snapshot reflects THAT week's operational flow. State metrics (unbilled/DSO/disputes/OR) are as-of now. */
export const WEEK_MS = 7 * DAY_MS;

/** The rater's `agent.acted.agent` literal — the SAME value the rate route stamps (workers/api/src/routes/
 *  rate.ts:243). Kept here as the single source so the rating-latency metric reads exactly the rater's runs. */
export const RATER_AGENT = "rater";

/** Terminal shipment states = the "resolved"/"closed" signal — the SAME set the WP-10 exceptions read uses
 *  (workers/api/src/routes/exceptions.ts): 'delivered' (pod.signed) + 'settled' (a future settlement projection). */
export const TERMINAL_STATES: ReadonlySet<string> = new Set(["delivered", "settled"]);
/** The terminal EVENT kinds a close-duration measures to: a delivered POD or an executed settlement. */
const CLOSE_TERMINAL_KINDS = ["settlement.executed", "pod.signed"] as const;

export type MetricValue = number | "UNKNOWN";

export interface MetricOpts {
  /** Test-only id-prefix scope (the shared-D1 hook). Undefined ⇒ whole-tenant read (production). */
  scope?: string;
}
export interface DsoMetricOpts extends MetricOpts {
  now: number; // injected clock so DSO is deterministic under test; production passes Date.now()
}
export interface FlowMetricOpts extends MetricOpts {
  now: number; // the window's upper bound (injected clock)
  /** Trailing window (ms) on the COMPLETION event's ts. Undefined ⇒ all-time (no window). */
  windowMs?: number;
}

// A bound `LIKE ?` fragment for the optional test scope. `col` is a HARDCODED literal at every call site (never
// user input); `scope` is bound as a param. Delegates to the SHARED scopeLike (./unbilled) so every metric here
// and the Watchtower sweep apply the identical scoping rule (one source of truth).
function likeClause(col: string, scope: string | undefined, params: (string | number)[]): string {
  return scopeLike(col, scope, params);
}

// The integer mean of a list of non-negative durations (ms), or UNKNOWN when the list is empty. Rounded to an
// integer ms (the canonical-integer law); an empty list is an HONEST UNKNOWN, never a fabricated 0.
function meanOrUnknown(values: number[]): MetricValue {
  if (values.length === 0) return "UNKNOWN";
  const sum = values.reduce((s, v) => s + v, 0);
  return Math.round(sum / values.length);
}

// Whether a completion ts is inside the trailing window (now − windowMs .. now], inclusive both ends (mirrors
// the Watchtower's window bound). undefined windowMs ⇒ always in (all-time).
function inWindow(ts: number, now: number, windowMs: number | undefined): boolean {
  if (windowMs === undefined) return true;
  return ts <= now && ts >= now - windowMs;
}

// ─── 1. UNBILLED — the "=0 alarm" (MOVED from kpis/compute.ts, verbatim) ──────────────────────────────
// Count of shipments with a committed `pod.signed` but NO `invoice.issued` (the anti-join). The SHARED
// unbilledShipmentsSql (./unbilled) — the SAME predicate the Watchtower alarm sweeps (REQ-036). A healthy
// tenant = 0, and that 0 is the REAL anti-join result (the alarm itself), NOT a fabricated placeholder.
export async function computeUnbilled(db: D1Database, opts: MetricOpts = {}): Promise<number> {
  const params: (string | number)[] = [];
  const scoped = likeClause("p.shipment_id", opts.scope, params);
  const row = await db
    .prepare(unbilledShipmentsSql("COUNT(DISTINCT p.shipment_id) AS n", scoped))
    .bind(...params)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ─── 2. DSO — dollar-weighted average age of OPEN AR, days (MOVED, verbatim) ──────────────────────────
// Open = invoices.status='issued'. Age = now − the invoice.issued event ts. DSO = the dollar-weighted mean age
// in days, accumulated in BigInt (no float, no overflow) then rounded. No open invoices → UNKNOWN (never 0 —
// you cannot average the age of nothing).
export async function computeDsoDays(db: D1Database, opts: DsoMetricOpts): Promise<MetricValue> {
  const params: (string | number)[] = [];
  const scoped = likeClause("i.id", opts.scope, params);
  const res = await db
    .prepare(
      `SELECT i.total_cents AS total, e.ts AS issue_ts
       FROM invoices i JOIN events e ON e.id = i.issued_event_id
       WHERE i.status='issued'${nativeVisibleSourceSql("e.source")}${scoped}`,
    )
    .bind(...params)
    .all<{ total: number; issue_ts: number }>();
  if (res.results.length === 0) return "UNKNOWN";

  let weighted = 0n;
  let totalCents = 0n;
  for (const r of res.results) {
    weighted += BigInt(r.total) * BigInt(opts.now - r.issue_ts);
    totalCents += BigInt(r.total);
  }
  if (totalCents === 0n) return "UNKNOWN";
  const dsoMs = weighted / totalCents; // integer ms (BigInt truncated)
  return Math.round(Number(dsoMs) / DAY_MS);
}

// ─── 7. OR — HONEST cost/revenue ratio from the quoted cost basis (MOVED, verbatim) ───────────────────
// NOT a true operating ratio (there is no operating-cost event kind). The rater's floors.full over the AR sell,
// per quote stream (the latest quote.priced). No quoted basis → UNKNOWN (never a placeholder ratio). Integer bps.
export async function computeCostRatioBps(db: D1Database, opts: MetricOpts = {}): Promise<MetricValue> {
  const params: (string | number)[] = [];
  const scoped = likeClause("shipment_id", opts.scope, params);
  const res = await db
    .prepare(
      `SELECT stream_id, seq, payload FROM events
       WHERE kind='quote.priced'${nativeVisibleSourceSql("source")}${scoped} ORDER BY stream_id, seq`,
    )
    .bind(...params)
    .all<{ stream_id: string; seq: number; payload: string }>();

  const latest = new Map<string, { seq: number; payload: string }>(); // stream_id → the max-seq priced payload
  for (const r of res.results) {
    const prev = latest.get(r.stream_id);
    if (prev === undefined || r.seq > prev.seq) latest.set(r.stream_id, { seq: r.seq, payload: r.payload });
  }

  let costTotal = 0;
  let sellTotal = 0;
  for (const { payload } of latest.values()) {
    let sell: unknown;
    let full: unknown;
    try {
      const p = JSON.parse(payload) as { sell?: unknown; floors?: { full?: unknown } };
      sell = p.sell;
      full = p.floors?.full;
    } catch {
      continue; // unparseable payload — skip, never fabricate
    }
    if (typeof sell !== "number" || !Number.isInteger(sell) || sell <= 0) continue;
    if (typeof full !== "number" || !Number.isInteger(full)) continue;
    sellTotal += sell;
    costTotal += full;
  }
  if (sellTotal <= 0) return "UNKNOWN";
  return Math.round((costTotal * 10_000) / sellTotal);
}

// ─── 3. POD→INVOICE LATENCY — mean(invoice.issued.ts − pod.signed.ts) per shipment, ms (NEW) ──────────
// Per shipment, the FIRST pod.signed ts and the FIRST invoice.issued ts; latency = invoice_ts − pod_ts, only
// over shipments with BOTH (a POD without an invoice is EXCLUDED, never fabricated). A negative pair (invoice
// stamped before its POD — clock skew / correction) is DROPPED. Windowed on the COMPLETION (invoice) ts so a
// weekly snapshot reflects THAT week's billing latency. No qualifying pair → UNKNOWN. Integer ms.
export async function computePodToInvoiceLatencyMs(db: D1Database, opts: FlowMetricOpts): Promise<MetricValue> {
  const params: (string | number)[] = [];
  const podScope = likeClause("shipment_id", opts.scope, params);
  const invScope = likeClause("shipment_id", opts.scope, params);
  const res = await db
    .prepare(
      `SELECT p.pod_ts AS pod_ts, i.inv_ts AS inv_ts FROM
         (SELECT shipment_id, MIN(ts) AS pod_ts FROM events
            WHERE kind='pod.signed' AND shipment_id IS NOT NULL${nativeVisibleSourceSql("source")}${podScope} GROUP BY shipment_id) p
       JOIN
         (SELECT shipment_id, MIN(ts) AS inv_ts FROM events
            WHERE kind='invoice.issued' AND shipment_id IS NOT NULL${nativeVisibleSourceSql("source")}${invScope} GROUP BY shipment_id) i
       ON i.shipment_id = p.shipment_id`,
    )
    .bind(...params)
    .all<{ pod_ts: number; inv_ts: number }>();

  const durations: number[] = [];
  for (const r of res.results) {
    if (!inWindow(r.inv_ts, opts.now, opts.windowMs)) continue; // window on the completing (invoice) event
    const dur = r.inv_ts - r.pod_ts;
    if (dur < 0) continue; // clock skew — never a fabricated negative latency
    durations.push(dur);
  }
  return meanOrUnknown(durations);
}

// ─── 4. RATING LATENCY — mean of the rater's agent.acted.latency_ms (agent_runs, T9), ms (NEW) ────────
// The T9 metering projection (agent_runs) carries each rater run's REPORTED latency_ms (or NULL when unreported).
// This averages ONLY the reported latencies of the RATER's runs (RATER_AGENT) inside the window — an unreported
// latency (NULL) is skipped, never counted as 0 (the T9/Watchtower honesty rule). agent_runs has no ts column, so
// the window bound reads each run's agent.acted event ts via a JOIN. No reported rater latency → UNKNOWN. Integer ms.
export async function computeRatingLatencyMs(db: D1Database, opts: FlowMetricOpts): Promise<MetricValue> {
  const params: (string | number)[] = [RATER_AGENT];
  const scoped = likeClause("e.shipment_id", opts.scope, params);
  const res = await db
    .prepare(
      `SELECT ar.latency_ms AS latency_ms, e.ts AS ts
       FROM agent_runs ar JOIN events e ON e.id = ar.id
       WHERE ar.agent = ? AND ar.latency_ms IS NOT NULL${scoped}`,
    )
    .bind(...params)
    .all<{ latency_ms: number; ts: number }>();

  const latencies: number[] = [];
  for (const r of res.results) {
    if (!inWindow(r.ts, opts.now, opts.windowMs)) continue;
    if (r.latency_ms < 0) continue; // never a fabricated negative latency
    latencies.push(r.latency_ms);
  }
  return meanOrUnknown(latencies);
}

// ─── 5. DISPUTES — count of OPEN exceptions (the WP-10 exceptions heuristic), count (NEW) ──────────────
// A "dispute" maps to an OPEN exception: an `exception.raised` or `osd.captured` event whose shipment has NOT
// reached a terminal state (delivered/settled) — the EXACT WP-10 exceptions read logic (workers/api/src/routes/
// exceptions.ts: an exception on a non-terminal shipment is OPEN; a shipment with no state row reads OPEN, fail
// toward surfacing). Counts DISTINCT shipments carrying ≥1 open exception. 0 is the HONEST healthy count (there
// is no exception.resolved kind in the frozen 35 — "resolved" is the terminal-state heuristic, not a fabrication).
export async function computeDisputesOpen(db: D1Database, opts: MetricOpts = {}): Promise<number> {
  const params: (string | number)[] = [];
  const scoped = likeClause("ev.shipment_id", opts.scope, params);
  const res = await db
    .prepare(
      `SELECT ev.shipment_id AS sid, json_extract(s.status_cache,'$.state') AS state
       FROM events ev LEFT JOIN shipments s ON s.id = ev.shipment_id
       WHERE ev.kind IN ('exception.raised','osd.captured') AND ev.shipment_id IS NOT NULL${nativeVisibleSourceSql("ev.source")}${scoped}
       GROUP BY ev.shipment_id`,
    )
    .bind(...params)
    .all<{ sid: string; state: string | null }>();

  let open = 0;
  for (const r of res.results) {
    // no state (null) OR a non-terminal state ⇒ OPEN (mirrors exceptions.ts: fail toward surfacing).
    if (r.state === null || !TERMINAL_STATES.has(r.state)) open += 1;
  }
  return open;
}

// ─── 6. CLOSE DURATION — mean(first terminal.ts − booking.created.ts) per shipment, ms (NEW) ──────────
// Per shipment, the FIRST booking.created ts and the FIRST terminal ts (the earliest of a delivered `pod.signed`
// or an executed `settlement.executed`); duration = terminal_ts − booking_ts, only over shipments with BOTH (a
// booking with no terminal is EXCLUDED, never fabricated). A negative pair is DROPPED. Windowed on the terminal
// (closing) ts so a weekly snapshot reflects THAT week's completed cycles. No qualifying pair → UNKNOWN. Integer ms.
export async function computeCloseDurationMs(db: D1Database, opts: FlowMetricOpts): Promise<MetricValue> {
  const params: (string | number)[] = [];
  const bookScope = likeClause("shipment_id", opts.scope, params);
  const termScope = likeClause("shipment_id", opts.scope, params);
  const termKinds = CLOSE_TERMINAL_KINDS.map((k) => `'${k}'`).join(",");
  const res = await db
    .prepare(
      `SELECT b.booking_ts AS booking_ts, t.term_ts AS term_ts FROM
         (SELECT shipment_id, MIN(ts) AS booking_ts FROM events
            WHERE kind='booking.created' AND shipment_id IS NOT NULL${nativeVisibleSourceSql("source")}${bookScope} GROUP BY shipment_id) b
       JOIN
         (SELECT shipment_id, MIN(ts) AS term_ts FROM events
            WHERE kind IN (${termKinds}) AND shipment_id IS NOT NULL${nativeVisibleSourceSql("source")}${termScope} GROUP BY shipment_id) t
       ON t.shipment_id = b.shipment_id`,
    )
    .bind(...params)
    .all<{ booking_ts: number; term_ts: number }>();

  const durations: number[] = [];
  for (const r of res.results) {
    if (!inWindow(r.term_ts, opts.now, opts.windowMs)) continue; // window on the closing (terminal) event
    const dur = r.term_ts - r.booking_ts;
    if (dur < 0) continue; // clock skew — never a fabricated negative duration
    durations.push(dur);
  }
  return meanOrUnknown(durations);
}
