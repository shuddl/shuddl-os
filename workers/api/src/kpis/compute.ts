// WP-10 Task 5 (REQ-083) — THE 6 KPI COMPUTES, WITH AN ABSOLUTE HONESTY GUARDRAIL.
//
// THE LAW: each tile is a REAL number computed from real ledger rows and DRILLABLE to its backing events, OR
// the literal "UNKNOWN" — NEVER a fabricated/placeholder number. Missing data → UNKNOWN. This is the L3 / "no
// price on air" ethos applied to KPIs: we never invent an on-time %, a due date, a lane, or an operating cost.
//
// INTEGER-ONLY: money stays integer cents; percentages are integer BASIS POINTS (0..10000); DSO is integer days
// (a documented rounding of the dollar-weighted mean, accumulated in BigInt so a large AR never overflows or
// forces a float); dwell is integer minutes (documented rounding of the mean pair duration).
//
// TESTABILITY: every fn takes an optional `scope` (an id PREFIX). The route runs whole-tenant (scope undefined);
// the tests pass a `kpi-…` prefix so the aggregate is deterministic on the isolatedStorage-off shared test D1.
// `scope` is applied ONLY as a BOUND `LIKE ?` param — never interpolated — and only over server-derived id
// columns (never client input on this read).

import { scopeLike, nativeVisibleSourceSql } from "@shuddl/ledger/queries/unbilled";
// WP-11 Task 10 (REQ-160) — computeUnbilled / computeDsoDays / computeCostRatioBps were MOVED to the shared
// @shuddl/ledger/queries/metrics module so the KPI route (this file's importer) and the weekly Watchtower
// snapshot import the ONE source and can never drift (a parity test locks it). Re-exported here UNCHANGED, so
// this module's public surface — and every importer — is unaffected. The other three tiles (OTD/dwell/lane)
// stay local; they are command-only and back no snapshot.
export { computeUnbilled, computeDsoDays, computeCostRatioBps } from "@shuddl/ledger/queries/metrics";

export interface KpiOpts {
  scope?: string;
}

export type KpiValue = number | "UNKNOWN";

export interface LaneEntry {
  lane: string; // "originFacility->destFacility", or the literal "UNKNOWN" for money we can't attribute to a lane
  ar_cents: number;
  ap_cents: number;
  pnl_cents: number;
}
export interface LanePnl {
  value: KpiValue; // total AR−AP (cents) across all money in scope; UNKNOWN when there is NO money to attribute
  lanes: LaneEntry[];
}

// A bound `LIKE ?` fragment for the optional test scope. col is a hardcoded literal at every call site (never
// user input); scope is bound as a param so it can never be an injection or widen the read. Delegates to the
// SHARED scopeLike (@shuddl/ledger/queries/unbilled) so the KPI computes and the Watchtower sweep apply the
// identical scoping rule (one source of truth — skill share-lint-matchers-with-parity-tests).
function likeClause(col: string, scope: string | undefined, params: (string | number)[]): string {
  return scopeLike(col, scope, params);
}

// ─── 2. OTD — on-time delivery %, appt-window gated ───────────────────────────────────────────────────
// Of delivered shipments (delivery-leg `pod.signed`), the fraction where pod.signed.ts ≤ the delivery leg's
// appt_window_end_ts (the WP-08 appointment window). A delivered shipment with NO window is EXCLUDED from the
// denominator (we can't judge on-time without a promised window — counting it either way would fabricate).
// If zero delivered-with-window → UNKNOWN (never 100%). Returned as integer BASIS POINTS.
export async function computeOtdBps(db: D1Database, opts: KpiOpts = {}): Promise<KpiValue> {
  const params: (string | number)[] = [];
  const podScope = likeClause("shipment_id", opts.scope, params);
  const legScope = likeClause("shipment_id", opts.scope, params);
  const res = await db
    .prepare(
      `SELECT p.pod_ts AS pod_ts, dl.appt_end AS appt_end FROM
         (SELECT shipment_id, MIN(ts) AS pod_ts FROM events
            WHERE kind='pod.signed' AND shipment_id IS NOT NULL${nativeVisibleSourceSql("source")}${podScope} GROUP BY shipment_id) p
       JOIN
         (SELECT shipment_id, MAX(appt_window_end_ts) AS appt_end FROM legs
            WHERE kind='delivery' AND appt_window_end_ts IS NOT NULL${legScope} GROUP BY shipment_id) dl
       ON dl.shipment_id = p.shipment_id`,
    )
    .bind(...params)
    .all<{ pod_ts: number; appt_end: number }>();
  const denom = res.results.length;
  if (denom === 0) return "UNKNOWN"; // no delivered-with-window — honest UNKNOWN, never a fabricated 100%
  const onTime = res.results.filter((r) => r.pod_ts <= r.appt_end).length;
  return Math.round((onTime * 10_000) / denom);
}

// ─── 3. DWELL — mean (departed − arrived) over matched pairs, minutes ─────────────────────────────────
// Load stop.arrived/stop.departed in stream+seq order and pair them per stream FIFO (first arrival ↔ first
// departure): sequential dock stops pair cleanly. Only a non-negative duration counts (a clock-skewed
// departure-before-arrival is dropped, never a fabricated negative dwell). No pairs → UNKNOWN. Integer minutes.
export async function computeDwellMinutes(db: D1Database, opts: KpiOpts = {}): Promise<KpiValue> {
  const params: (string | number)[] = [];
  const scoped = likeClause("shipment_id", opts.scope, params);
  const res = await db
    .prepare(
      `SELECT stream_id, seq, kind, ts FROM events
       WHERE kind IN ('stop.arrived','stop.departed') AND shipment_id IS NOT NULL${nativeVisibleSourceSql("source")}${scoped}
       ORDER BY stream_id, seq`,
    )
    .bind(...params)
    .all<{ stream_id: string; seq: number; kind: string; ts: number }>();

  const pendingArrivals = new Map<string, number[]>(); // stream_id → FIFO queue of arrival ts
  let sumMs = 0;
  let pairs = 0;
  for (const e of res.results) {
    if (e.kind === "stop.arrived") {
      const q = pendingArrivals.get(e.stream_id) ?? [];
      q.push(e.ts);
      pendingArrivals.set(e.stream_id, q);
    } else {
      const q = pendingArrivals.get(e.stream_id);
      const arrived = q?.shift();
      if (arrived === undefined) continue; // a departure with no open arrival — unmatched, dropped honestly
      const dur = e.ts - arrived;
      if (dur < 0) continue; // clock skew — never a fabricated negative dwell
      sumMs += dur;
      pairs += 1;
    }
  }
  if (pairs === 0) return "UNKNOWN";
  return Math.round(sumMs / pairs / 60_000);
}

// ─── 4. LANE P&L — AR−AP grouped by derived lane ──────────────────────────────────────────────────────
// There is no lane column; derive the lane key by joining money_lines.shipment_id → legs → facilities: the
// origin (pickup leg) and dest (delivery leg) facility ids, each of which must resolve to a facility row WITH
// coordinates (facilities.lat_e6/lon_e6). When both resolve, lane = "origin->dest"; otherwise the shipment's
// money is honestly bucketed under the literal "UNKNOWN" lane — NEVER a fabricated lane. `value` is the total
// AR−AP (cents) across all money in scope; UNKNOWN only when there is NO money to attribute at all.
export async function computeLanePnl(db: D1Database, opts: KpiOpts = {}): Promise<LanePnl> {
  const moneyParams: (string | number)[] = [];
  const moneyScope = likeClause("shipment_id", opts.scope, moneyParams);
  const money = await db
    .prepare(
      `SELECT shipment_id AS sid,
         SUM(CASE WHEN direction='ar' THEN amount_cents ELSE 0 END) AS ar,
         SUM(CASE WHEN direction='ap' THEN amount_cents ELSE 0 END) AS ap
       FROM money_lines WHERE shipment_id IS NOT NULL${moneyScope} GROUP BY shipment_id`,
    )
    .bind(...moneyParams)
    .all<{ sid: string; ar: number; ap: number }>();

  if (money.results.length === 0) return { value: "UNKNOWN", lanes: [] };

  const legParams: (string | number)[] = [];
  const legScope = likeClause("shipment_id", opts.scope, legParams);
  const legs = await db
    .prepare(
      `SELECT shipment_id AS sid,
         MAX(CASE WHEN kind='pickup' THEN facility_id END) AS origin,
         MAX(CASE WHEN kind='delivery' THEN facility_id END) AS dest
       FROM legs WHERE shipment_id IS NOT NULL${legScope} GROUP BY shipment_id`,
    )
    .bind(...legParams)
    .all<{ sid: string; origin: string | null; dest: string | null }>();
  const endpoints = new Map<string, { origin: string | null; dest: string | null }>();
  for (const r of legs.results) endpoints.set(r.sid, { origin: r.origin, dest: r.dest });

  // Only facilities with real coordinates make a geographically meaningful lane endpoint.
  const geoFac = await db.prepare("SELECT id FROM facilities WHERE lat_e6 IS NOT NULL AND lon_e6 IS NOT NULL").all<{ id: string }>();
  const resolvable = new Set(geoFac.results.map((r) => r.id));

  const buckets = new Map<string, { ar: number; ap: number }>(); // lane key ("UNKNOWN" for un-attributable) → sums
  let total = 0;
  for (const m of money.results) {
    const ar = m.ar ?? 0;
    const ap = m.ap ?? 0;
    total += ar - ap;
    const ep = endpoints.get(m.sid);
    const derivable =
      ep?.origin != null && ep.dest != null && resolvable.has(ep.origin) && resolvable.has(ep.dest);
    const key = derivable ? `${ep!.origin}->${ep!.dest}` : "UNKNOWN";
    const b = buckets.get(key) ?? { ar: 0, ap: 0 };
    b.ar += ar;
    b.ap += ap;
    buckets.set(key, b);
  }

  const lanes: LaneEntry[] = [...buckets.entries()]
    .map(([lane, b]) => ({ lane, ar_cents: b.ar, ap_cents: b.ap, pnl_cents: b.ar - b.ap }))
    // real lanes first by |P&L| desc; the UNKNOWN bucket sinks last (its money is real but un-attributed).
    .sort((a, b) => {
      if (a.lane === "UNKNOWN") return 1;
      if (b.lane === "UNKNOWN") return -1;
      return Math.abs(b.pnl_cents) - Math.abs(a.pnl_cents);
    });

  return { value: total, lanes };
}
