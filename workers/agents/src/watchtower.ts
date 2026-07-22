// WP-11 Task 8 — THE WATCHTOWER (REQ-036). A per-tenant cron that raises DURABLE alarms into the EXISTING
// `anomalies` table (0002_domain.sql:99-102) — NO new table, NO new event kind (alarms are `anomalies` rows,
// NOT ledger events). Three rules, each an UPSERTed `anomalies` row keyed deterministically per (tenant, rule,
// object):
//   1. unbilled       — shipments with a committed `pod.signed` but NO `invoice.issued` (the anti-join the KPI
//                       compute uses; the SHARED predicate @shuddl/ledger/queries/unbilled, no drift). count>0 →
//                       RAISE (severity by count/age); count==0 → CLEAR (status→resolved). The REQ-036 DoD:
//                       "unbilled alarm fires on a seeded $0-revenue bill" = a POD-signed shipment with no invoice.
//   2. pricing_anomaly — committed `quote.priced` whose payload.basis.anomaly != null (the $222,084/35-lb net,
//                       detectAnomaly stamped at rate.ts, EXPLICITLY deferred to the Watchtower). Each anomalous
//                       quote → one CRITICAL alarm keyed by the quote EVENT id (the anomaly is permanent, REQ-040).
//   3. floor_breach    — OPEN below-floor approvals (the WP-10 `approvals` read-model status='open'). count>0 →
//                       RAISE a WARN alarm with the open count; count==0 → CLEAR.
//   4. agent_drift     — per-agent cost/latency BUDGET (REQ-113, WP-11 T9). Aggregates a rolling window of
//                       `agent_runs` (the metering projection) per agent; RAISES when the window's avg latency
//                       or avg cost/run exceeds DEFAULT_AGENT_BUDGET; CLEARS when back in budget. One alarm per
//                       agent, keyed by the agent (object), self-clearing. Honest: averages only REPORTED metrics.
//
// SELF-CLEARING + IDEMPOTENT (mirrors the anchor TSA alarm, anchor.ts:274-301): the alarm is written by the
// ON-CONFLICT UPSERT — one row per deterministic id, open→re-raise on conflict, resolved when the condition
// clears. A re-sweep of the SAME state upserts the SAME row (no duplicate); when the condition clears the row
// flips to 'resolved' (NOT deleted — the alarm history persists). The `anomalies` table is a MUTABLE ops table
// (no append-only guard), so an UPSERT/UPDATE is legal — and NOT `INSERT OR REPLACE` (lint-banned; ON CONFLICT
// DO UPDATE is not).
//
// TENANT ISOLATION (REQ-025): the caller binds `db` to ONE tenant's D1 and names that `tenant`; the sweep reads
// + writes ONLY that D1, so it can never touch another tenant. PURITY OF INPUTS: `now` is supplied by the caller
// (the cron reads wall-clock); it feeds ONLY the unbilled age→severity decision, never a fresh clock read here.
//
// TEST SCOPE (`opts.scope`): the shared api harness runs on ONE D1 (isolatedStorage off). A scope prefix scopes
// every rule's SQL to the caller's own ids (the SAME bound-LIKE hook the KPI computes use) AND suffixes the
// aggregate alarm ids, so a test case's rows never disturb a sibling's. Production passes no scope: one
// tenant-wide alarm per (tenant, rule).

import { scopeLike, unbilledShipmentsSql, nativeVisibleSourceSql } from "@shuddl/ledger/queries/unbilled";

// ── severity thresholds (documented, deterministic) ─────────────────────────────────────────────────
const DAY_MS = 86_400_000;
// unbilled escalates to CRITICAL at a material backlog OR a stale POD — real delivered freight not invoiced.
const UNBILLED_CRITICAL_COUNT = 10;
const UNBILLED_CRITICAL_AGE_MS = 7 * DAY_MS;
// Cap the shipment list carried in a detail so a large backlog never bloats the row (the count is authoritative).
const DETAIL_SHIPMENT_CAP = 50;

// ── agent-drift budget (REQ-113, documented + deterministic) ─────────────────────────────────────────
export interface AgentBudget {
  /** Max acceptable AVERAGE run latency (ms) over the window before an agent is "drifting". */
  maxAvgLatencyMs: number;
  /** Max acceptable AVERAGE cost per run (integer cents) over the window. */
  maxAvgCostCents: number;
}
// The DEFAULT per-agent budget (a tenant may override via opts.budget — the config seam). A window whose
// average run wall-clock exceeds 5s OR whose average cost exceeds 50¢ ($0.50) is DRIFTING — worth an ops
// alarm. Integer cents (REQ-167 synthetic).
export const DEFAULT_AGENT_BUDGET: AgentBudget = { maxAvgLatencyMs: 5_000, maxAvgCostCents: 50 };
// The rolling window over which per-agent averages are computed (24h). agent_runs carries no ts column, so the
// window bound reads each metered run's `agent.acted` event ts via a JOIN.
const AGENT_DRIFT_WINDOW_MS = DAY_MS;
// A window average at/above this multiple of budget is a runaway → CRITICAL; merely over-budget → WARN.
const AGENT_DRIFT_CRITICAL_RATIO = 2;

export type AlarmSeverity = "info" | "warn" | "critical";

export interface WatchtowerOpts {
  /** Test-only id-prefix scope (the shared-D1 hook). Undefined in production ⇒ tenant-wide alarms. */
  scope?: string;
  /** Per-agent budget override (tenant config seam); merged over DEFAULT_AGENT_BUDGET for the drift rule. */
  budget?: Partial<AgentBudget>;
}

export interface WatchtowerResult {
  /** Distinct unbilled shipments (POD-signed, no invoice) — the count carried in the alarm. */
  unbilled: { count: number; status: "open" | "resolved"; severity: AlarmSeverity | null };
  /** Anomalous quote.priced events alarmed this pass (one critical alarm each). */
  pricing_anomaly: { count: number };
  /** Open below-floor approvals — the count carried in the alarm. */
  floor_breach: { count: number; status: "open" | "resolved"; severity: AlarmSeverity | null };
  /** Per-agent cost/latency budget check (REQ-113): every known agent gets a raise-OR-clear this sweep. */
  agent_drift: {
    /** How many agents were over budget this pass (one open alarm each). */
    alarmed: number;
    agents: Array<{
      agent: string;
      /** Runs counted IN the window (out-of-window runs are excluded from the averages). */
      runs: number;
      /** Window average latency (ms), over runs that REPORTED a latency; null if none did. */
      avgLatencyMs: number | null;
      /** Window average cost (cents), over runs that REPORTED a cost; null if none did. */
      avgCostCents: number | null;
      severity: AlarmSeverity | null;
      status: "open" | "resolved";
    }>;
  };
}

/**
 * The DETERMINISTIC alarm id for a (tenant, rule) — optionally per object (a specific quote event) and/or per
 * test scope. Tenant is folded in (belt + suspenders over the per-tenant D1). The aggregate rules (unbilled,
 * floor_breach) key on (tenant[,scope]); pricing_anomaly keys additionally on the quote event `object`.
 */
export function watchtowerAlarmId(tenant: string, rule: string, opts?: { scope?: string | undefined; object?: string | undefined }): string {
  const scopeTag = opts?.scope !== undefined ? `:${opts.scope}` : "";
  const objectTag = opts?.object !== undefined ? `:${opts.object}` : "";
  return `watchtower:${rule}:${tenant}${scopeTag}${objectTag}`;
}

// RAISE (or re-raise) an alarm — the anchor.ts self-clearing UPSERT pattern. ON CONFLICT keeps EXACTLY one row
// per id: a previously-resolved alarm flips back to 'open' and its severity/detail refresh. NOT INSERT OR
// REPLACE (that verb is lint-banned; ON CONFLICT DO UPDATE is not).
async function raiseAlarm(
  db: D1Database,
  id: string,
  rule: string,
  objectKind: string,
  objectId: string,
  severity: AlarmSeverity,
  detail: unknown,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO anomalies (id, rule, object_kind, object_id, severity, detail, status) VALUES (?,?,?,?,?,?,'open') " +
        "ON CONFLICT(id) DO UPDATE SET severity = excluded.severity, detail = excluded.detail, status = 'open'",
    )
    .bind(id, rule, objectKind, objectId, severity, JSON.stringify(detail))
    .run();
}

// CLEAR an alarm — flip to 'resolved' (NOT delete: the alarm history persists; a re-raise flips it back). A
// no-op when the row never existed (nothing to clear), so calling it on a healthy tenant every tick is safe.
async function clearAlarm(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE anomalies SET status = 'resolved' WHERE id = ?").bind(id).run();
}

// ── rule 1 — UNBILLED (the DoD) ───────────────────────────────────────────────────────────────────────
async function sweepUnbilled(db: D1Database, tenant: string, now: number, opts: WatchtowerOpts): Promise<WatchtowerResult["unbilled"]> {
  const params: (string | number)[] = [];
  const scoped = scopeLike("p.shipment_id", opts.scope, params);
  // The SHARED anti-join (same predicate as computeUnbilled). Read the driving pod rows + their ts so severity
  // can factor the OLDEST unbilled POD's age; dedup to DISTINCT shipments in JS (the parity contract with the KPI).
  const rows = (
    await db.prepare(unbilledShipmentsSql("p.shipment_id AS shipment_id, p.ts AS pod_ts", scoped)).bind(...params).all<{ shipment_id: string; pod_ts: number }>()
  ).results;

  const oldestByShipment = new Map<string, number>();
  for (const r of rows) {
    const prev = oldestByShipment.get(r.shipment_id);
    if (prev === undefined || r.pod_ts < prev) oldestByShipment.set(r.shipment_id, r.pod_ts);
  }
  const shipments = [...oldestByShipment.keys()].sort();
  const count = shipments.length;
  const id = watchtowerAlarmId(tenant, "unbilled", { scope: opts.scope });

  if (count === 0) {
    await clearAlarm(db, id);
    return { count: 0, status: "resolved", severity: null };
  }

  const oldestPodTs = Math.min(...oldestByShipment.values());
  const staleEnough = now - oldestPodTs >= UNBILLED_CRITICAL_AGE_MS;
  const severity: AlarmSeverity = count >= UNBILLED_CRITICAL_COUNT || staleEnough ? "critical" : "warn";
  await raiseAlarm(db, id, "unbilled", "tenant", opts.scope ?? tenant, severity, {
    count,
    oldest_pod_ts: oldestPodTs,
    shipments: shipments.slice(0, DETAIL_SHIPMENT_CAP),
  });
  return { count, status: "open", severity };
}

// ── rule 2 — PRICING ANOMALY ($222,084/35-lb net) ──────────────────────────────────────────────────────
async function sweepPricingAnomaly(db: D1Database, tenant: string, opts: WatchtowerOpts): Promise<WatchtowerResult["pricing_anomaly"]> {
  const params: (string | number)[] = [];
  const scoped = scopeLike("shipment_id", opts.scope, params);
  // Committed quote.priced whose recorded basis carries a non-null anomaly flag (rate.ts stamps basis.anomaly =
  // detectAnomaly(...) at pricing; a sane price is basis.anomaly === null → SQL NULL → excluded here).
  const rows = (
    await db
      .prepare(`SELECT id, shipment_id, payload FROM events WHERE kind = 'quote.priced'${nativeVisibleSourceSql("source")} AND json_extract(payload, '$.basis.anomaly') IS NOT NULL${scoped}`)
      .bind(...params)
      .all<{ id: string; shipment_id: string | null; payload: string }>()
  ).results;

  let alarmed = 0;
  for (const r of rows) {
    let anomaly: unknown = null;
    try {
      anomaly = (JSON.parse(r.payload) as { basis?: { anomaly?: unknown } }).basis?.anomaly ?? null;
    } catch {
      continue; // unparseable payload — never fabricate an alarm detail
    }
    if (anomaly === null) continue; // json_extract said present; a defensive re-check keeps the detail honest
    const id = watchtowerAlarmId(tenant, "pricing_anomaly", { object: r.id });
    // The anomaly is a permanent record of a price that shouldn't exist (REQ-040), always critical. Keyed by the
    // quote EVENT id so multiple anomalous quotes on one shipment never collide, and a re-sweep upserts the same row.
    await raiseAlarm(db, id, "pricing_anomaly", "shipment", r.shipment_id ?? r.id, "critical", {
      quote_event_id: r.id,
      shipment_id: r.shipment_id,
      ...(typeof anomaly === "object" && anomaly !== null ? (anomaly as Record<string, unknown>) : { anomaly }),
    });
    alarmed += 1;
  }
  return { count: alarmed };
}

// ── rule 3 — FLOOR BREACH (open below-floor approvals) ─────────────────────────────────────────────────
async function sweepFloorBreach(db: D1Database, tenant: string, opts: WatchtowerOpts): Promise<WatchtowerResult["floor_breach"]> {
  const params: (string | number)[] = [];
  const scoped = scopeLike("object_id", opts.scope, params);
  // The WP-10 approvals read-model: an OPEN row is a below-floor approval the Rater raised (approval.requested)
  // with no answering approval.decided yet (projection/approvals.ts flips it to 'decided').
  const rows = (
    await db.prepare(`SELECT object_id FROM approvals WHERE status = 'open'${scoped}`).bind(...params).all<{ object_id: string }>()
  ).results;
  const count = rows.length;
  const id = watchtowerAlarmId(tenant, "floor_breach", { scope: opts.scope });

  if (count === 0) {
    await clearAlarm(db, id);
    return { count: 0, status: "resolved", severity: null };
  }
  const shipments = [...new Set(rows.map((r) => r.object_id))].sort();
  await raiseAlarm(db, id, "floor_breach", "tenant", opts.scope ?? tenant, "warn", {
    open_count: count,
    shipments: shipments.slice(0, DETAIL_SHIPMENT_CAP),
  });
  return { count, status: "open", severity: "warn" };
}

// ── rule 4 — AGENT DRIFT (per-agent cost/latency budget, REQ-113) ──────────────────────────────────────
// The metering projection (packages/ledger/src/projection/agent-runs.ts) writes one agent_runs row per
// committed agent.acted, carrying that run's cost (`{cents:N}`, or `{}` when unreported) + latency_ms (or
// NULL). This rule aggregates a rolling WINDOW of those runs PER agent, compares the window's AVERAGE latency
// and AVERAGE cost-per-run to a per-agent BUDGET (DEFAULT_AGENT_BUDGET, overridable via opts.budget for tenant
// config), and RAISES an `agent_drift` alarm — keyed per agent, deterministic id, self-clearing — when either
// average is over budget; severity escalates to critical at AGENT_DRIFT_CRITICAL_RATIO× budget.
//
// HONESTY (the WP-10/11 metric law): an average is computed ONLY over runs that actually REPORTED that metric
// (a `{}` cost / NULL latency is SKIPPED, never counted as 0) — the alarm fires on real drift, never on a
// fabricated number, and an agent that reports no metrics can never be alarmed. SELF-CLEARING: EVERY agent
// with any metered run (all-time, scoped) is enumerated and gets a raise-OR-clear each pass, so an agent whose
// over-budget runs age out of the window resolves its alarm. agent_runs has no ts column, so the window bound
// reads e.ts by JOINing each run to its agent.acted event.
async function sweepAgentDrift(db: D1Database, tenant: string, now: number, opts: WatchtowerOpts): Promise<WatchtowerResult["agent_drift"]> {
  const budget: AgentBudget = { ...DEFAULT_AGENT_BUDGET, ...(opts.budget ?? {}) };
  const params: (string | number)[] = [];
  const scoped = scopeLike("e.shipment_id", opts.scope, params);
  // Every metered run (all-time, scoped) joined to its event for the window clock. Fetch-then-aggregate in JS
  // (mirrors sweepUnbilled's JS dedup) so we can (a) enumerate every known agent to raise-OR-clear it, and
  // (b) average ONLY the reported metrics (parse the cost JSON here rather than json_extract in SQL).
  const rows = (
    await db
      .prepare(`SELECT ar.agent AS agent, ar.cost AS cost, ar.latency_ms AS latency_ms, e.ts AS ts FROM agent_runs ar JOIN events e ON e.id = ar.id WHERE 1=1${scoped}`)
      .bind(...params)
      .all<{ agent: string; cost: string; latency_ms: number | null; ts: number }>()
  ).results;

  interface Acc {
    latSum: number;
    latN: number;
    costSum: number;
    costN: number;
    runs: number;
  }
  const byAgent = new Map<string, Acc>();
  for (const r of rows) {
    let acc = byAgent.get(r.agent);
    if (acc === undefined) {
      acc = { latSum: 0, latN: 0, costSum: 0, costN: 0, runs: 0 };
      byAgent.set(r.agent, acc); // create the agent's entry even for an out-of-window row, so it gets a CLEAR
    }
    if (r.ts > now || r.ts < now - AGENT_DRIFT_WINDOW_MS) continue; // outside the rolling window — skip the metric
    acc.runs += 1;
    if (r.latency_ms !== null) {
      acc.latSum += r.latency_ms;
      acc.latN += 1;
    }
    let cents: number | null = null;
    try {
      const c = (JSON.parse(r.cost) as { cents?: unknown }).cents;
      if (typeof c === "number" && Number.isInteger(c)) cents = c;
    } catch {
      /* unparseable cost → unknown, skip (never fabricate a cost) */
    }
    if (cents !== null) {
      acc.costSum += cents;
      acc.costN += 1;
    }
  }

  const agents: WatchtowerResult["agent_drift"]["agents"] = [];
  let alarmed = 0;
  for (const agent of [...byAgent.keys()].sort()) {
    const acc = byAgent.get(agent)!;
    const avgLatencyMs = acc.latN > 0 ? Math.round(acc.latSum / acc.latN) : null;
    const avgCostCents = acc.costN > 0 ? Math.round(acc.costSum / acc.costN) : null;
    const id = watchtowerAlarmId(tenant, "agent_drift", { scope: opts.scope, object: agent });

    const over: string[] = [];
    let ratio = 0;
    if (avgLatencyMs !== null && avgLatencyMs > budget.maxAvgLatencyMs) {
      over.push("latency");
      ratio = Math.max(ratio, avgLatencyMs / budget.maxAvgLatencyMs);
    }
    if (avgCostCents !== null && avgCostCents > budget.maxAvgCostCents) {
      over.push("cost");
      ratio = Math.max(ratio, avgCostCents / budget.maxAvgCostCents);
    }

    if (over.length === 0) {
      await clearAlarm(db, id);
      agents.push({ agent, runs: acc.runs, avgLatencyMs, avgCostCents, severity: null, status: "resolved" });
      continue;
    }
    const severity: AlarmSeverity = ratio >= AGENT_DRIFT_CRITICAL_RATIO ? "critical" : "warn";
    await raiseAlarm(db, id, "agent_drift", "agent", agent, severity, {
      agent,
      runs: acc.runs,
      avg_latency_ms: avgLatencyMs,
      avg_cost_cents: avgCostCents,
      budget: { max_avg_latency_ms: budget.maxAvgLatencyMs, max_avg_cost_cents: budget.maxAvgCostCents },
      over,
    });
    agents.push({ agent, runs: acc.runs, avgLatencyMs, avgCostCents, severity, status: "open" });
    alarmed += 1;
  }
  return { alarmed, agents };
}

/**
 * Sweep ONE tenant's ledger for all three Watchtower alarm conditions and UPSERT/CLEAR the `anomalies` rows.
 * The caller binds `db`/`tenant` to that one tenant (REQ-025). `now` is the sweep clock (injected; the cron
 * reads wall-clock, tests pass a fixed instant). Idempotent + SELF-CLEARING: safe to call every cron tick —
 * a re-sweep of the same state upserts the same rows, and a cleared condition resolves its alarm.
 */
export async function runWatchtowerSweep(db: D1Database, tenant: string, now: number, opts: WatchtowerOpts = {}): Promise<WatchtowerResult> {
  const unbilled = await sweepUnbilled(db, tenant, now, opts);
  const pricing_anomaly = await sweepPricingAnomaly(db, tenant, opts);
  const floor_breach = await sweepFloorBreach(db, tenant, opts);
  const agent_drift = await sweepAgentDrift(db, tenant, now, opts);
  return { unbilled, pricing_anomaly, floor_breach, agent_drift };
}
