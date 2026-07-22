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
//   5. parity_drift    — (WP-15 Task 8, REQ-008) the OVERLAY safety net. Per overlay module, computes the SHARED
//                       computeModuleParity; a DRIFT (a promoted-native module that has diverged from the legacy
//                       mirror beyond tolerance) RAISES a CRITICAL alarm keyed (tenant, module) AND — when that
//                       module is CURRENTLY native — AUTO-FALLS-BACK to legacy by appending authority.flipped
//                       {to:'legacy',reason:'drift'} on t:root via the SeqStub (the Task-1 projection reverts
//                       authority_map). MATCH/UNKNOWN → CLEAR. THE ASYMMETRY: fallback DOWN is AUTOMATIC on a
//                       single breach; promotion UP is NEVER automatic — this rule ONLY EVER appends to:'legacy'.
//                       The fallback event id is DETERMINISTIC in the reverting promotion EPISODE (the last flip
//                       recorded on the module), so a concurrent/re-run sweep dedupes at the DO (at most one
//                       fallback per episode) while a later re-promotion that drifts again is a NEW episode ⇒ a
//                       NEW fallback. After a fallback the module is legacy, so the rule never re-fires — re-
//                       promotion is the gated flip route ONLY (never auto-re-promote). LLM-free (REQ-024).
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
import { computeModuleParity, PARITY_MODULES, PARITY_TOLERANCE_BPS, type AuthorityModule, type ParityStatus } from "@shuddl/ledger/parity";
import { resolveAuthority } from "@shuddl/ledger/authority";
import { uuidFromSeed, type SeqStubLike } from "./biller.js";

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

// ── parity-drift auto-fallback (WP-15 Task 8, REQ-008) ────────────────────────────────────────────────
// The server sentinel that CO-SIGNS the auto-fallback authority.flipped (mirrors mirror-sweep's agent:legacy-
// mirror + the flip route's system:gatekeeper). authority.flipped accrues no parties-FK, so the sentinel party
// is safe; there is no `user` (this is a machine decision, not a human co-sign).
const WATCHTOWER_ACTOR = "agent:watchtower";
// A deterministic server control decision — full confidence (matches the flip route's authority.flipped).
const FLIP_CONFIDENCE = 10_000;

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
  /** WP-15 Task 8 (REQ-008) — the overlay parity-drift check + auto-fallback, per overlay module. */
  parity_drift: {
    /** Modules in DRIFT this pass (one critical alarm each). */
    alarmed: number;
    /** Native modules AUTO-flipped back to legacy this pass (one authority.flipped on t:root each). */
    fell_back: number;
    modules: Array<{
      module: AuthorityModule;
      status: ParityStatus;
      /** A CRITICAL parity_drift alarm was raised (DRIFT); false ⇒ cleared (MATCH/UNKNOWN). */
      raised: boolean;
      /** A native module was auto-flipped back to legacy (DRIFT + authority native + seq wired). */
      fell_back: boolean;
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

// ── rule 5 — PARITY DRIFT + AUTO-FALLBACK-TO-LEGACY (WP-15 Task 8, REQ-008) ─────────────────────────────
// The DETERMINISTIC fallback event id. Folds the reverting promotion EPISODE (the module's last recorded flip)
// into the seed so: within one native episode the id is STABLE (a concurrent/re-run sweep reproduces it ⇒ the DO
// dedupes ⇒ at most one fallback event), while a LATER re-promotion (a new gated flip to native ⇒ a new last
// flip) is a NEW episode ⇒ a NEW id. No Date/random (REQ-024, replay-safe) — reuses the Biller's v4-variant
// uuidFromSeed so it satisfies EventInput's uuid id.
export async function driftFallbackEventId(tenant: string, module: AuthorityModule, episodeMarker: string): Promise<string> {
  return uuidFromSeed(`watchtower:drift-fallback:${tenant}:${module}:${episodeMarker}`);
}

// The reverting promotion EPISODE marker = the module's LAST recorded flip id. Because authority is native ONLY
// when the last-applied flip set it native (the projection applies every flip's `to` in seq order and records its
// id), the tail of flipped_events IS the promotion this fallback reverts.
// L8 INVARIANT: native authority is reachable ONLY through a projected authority.flipped, and projectAuthority
// ALWAYS records that flip's id in flipped_events — so a native module ALWAYS has a NON-empty flipped_events. The
// empty ⇒ "" branch is therefore UNREACHABLE in a well-formed ledger; it is kept only as a deterministic fail-safe
// (never a throw / random) for a hypothetically-corrupt map (a native row with no event = an L8 violation upstream).
async function episodeMarkerFor(db: D1Database, module: AuthorityModule): Promise<string> {
  const row = await db.prepare("SELECT flipped_events FROM authority_map WHERE module = ?").bind(module).first<{ flipped_events: string }>();
  try {
    const arr = JSON.parse(row?.flipped_events ?? "[]") as unknown[];
    const last = arr.length > 0 ? arr[arr.length - 1] : undefined;
    return typeof last === "string" ? last : "";
  } catch {
    return "";
  }
}

// Append the auto-fallback authority.flipped{from:'native',to:'legacy',reason:'drift',drift_ref} on t:root via the
// SeqStub (exactly like the mirror sweep appends). ALWAYS to:'legacy' — the rule is structurally incapable of
// promoting (the asymmetry). A BACKWARD flip needs NO gate (Task 3), so it just appends; the DO validates the
// EventInput + runs the Task-1 projectAuthority (reverting authority_map). Idempotent: the deterministic id makes
// a re-drive dedupe at the DO. `now` stamps ts (injected; no clock read here).
async function appendDriftFallback(
  db: D1Database,
  seq: SeqStubLike,
  tenant: string,
  module: AuthorityModule,
  driftRef: string,
  now: number,
): Promise<void> {
  const episode = await episodeMarkerFor(db, module);
  const id = await driftFallbackEventId(tenant, module, episode);
  const input = {
    id,
    // NO shipment_id — a t:root control event carries none (the events CHECK forbids one off a non-s: stream).
    ts: now,
    actor: { party: WATCHTOWER_ACTOR }, // the CO-SIGN: a machine decision, no human `user`
    party_refs: [] as string[],
    evidence: [] as { doc_id: string; hash: string }[],
    source: "native" as const, // the flip event is a NATIVE control event — authority.flipped is never source:'legacy'
    confidence: FLIP_CONFIDENCE,
    kind: "authority.flipped" as const,
    payload: { module, from: "native" as const, to: "legacy" as const, reason: "drift" as const, drift_ref: driftRef },
  };
  await seq.append({ tenant, streamId: "t:root", input });
}

// For each overlay module: RAISE/CLEAR the parity_drift alarm off the SHARED computeModuleParity, and on a native
// DRIFT auto-fall-back to legacy. UNKNOWN (a side missing) is unassessable ⇒ CLEAR + no fallback (the documented
// "a native module whose mirror went UNKNOWN is unmonitored" gap — deliberately NOT an auto-fallback trigger). The
// alarm is a self-clearing UPSERT keyed (tenant, module) — the SAME idiom as the other rules (NO new table/kind).
async function sweepParityDrift(
  db: D1Database,
  tenant: string,
  now: number,
  opts: WatchtowerOpts,
  seq: SeqStubLike | undefined,
): Promise<WatchtowerResult["parity_drift"]> {
  const modules: WatchtowerResult["parity_drift"]["modules"] = [];
  let alarmed = 0;
  let fell_back = 0;

  for (const module of PARITY_MODULES) {
    // REUSE the SHARED primitive — the SAME parity the flip gate + the dashboard read (no second computation).
    const parity = await computeModuleParity(db, module);
    const id = watchtowerAlarmId(tenant, "parity_drift", { scope: opts.scope, object: module });

    if (parity.status !== "DRIFT") {
      // MATCH (within gate) or UNKNOWN (a side missing) → CLEAR. UNKNOWN NEVER raises and NEVER auto-falls-back.
      await clearAlarm(db, id);
      modules.push({ module, status: parity.status, raised: false, fell_back: false });
      continue;
    }

    // DRIFT → RAISE a CRITICAL alarm keyed (tenant, module); carry the drift + native/legacy values (the audit).
    await raiseAlarm(db, id, "parity_drift", "module", module, "critical", {
      module,
      drift_bps: parity.drift_bps,
      native_value: parity.native_value,
      legacy_value: parity.legacy_value,
      tolerance_bps: PARITY_TOLERANCE_BPS[module],
      backing_kinds: parity.backing_kinds,
    });
    alarmed += 1;

    // THE ENFORCEMENT: a native module that has drifted is AUTO-flipped back to legacy. resolveAuthority is the
    // SAME fail-closed seam the compute paths consult; only 'native' triggers a fallback (a legacy module is
    // already reverted — nothing to fall back to). Guarded on `seq` (production always wires it via sequencerFor;
    // a seq-less call — the other rules' unit tests — raises the alarm but performs no append). drift_ref = the
    // parity_drift anomaly id (the audit link). The Task-1 projection reverts authority_map to legacy.
    let didFallback = false;
    if (seq !== undefined && (await resolveAuthority(db, module)) === "native") {
      // PER-MODULE FAULT CONTAINMENT: the alarm is ALREADY raised above, so a persistent append fault here must NOT
      // abort the sweep and skip every LATER module's raise/clear (a newly-drifting one would go unalarmed, a
      // reconverged one un-cleared). Log + CONTINUE — the deterministic per-episode fallback id makes a next-tick
      // retry safe (the DO dedupes). Mirrors the per-tenant containment the cron wraps each tenant's sweep in.
      try {
        await appendDriftFallback(db, seq, tenant, module, id, now);
        fell_back += 1;
        didFallback = true;
      } catch (err) {
        console.error(`watchtower parity_drift: ${tenant}/${module} fallback append failed (alarm raised; retry next tick):`, err);
      }
    }
    modules.push({ module, status: "DRIFT", raised: true, fell_back: didFallback });
  }

  return { alarmed, fell_back, modules };
}

/**
 * Sweep ONE tenant's ledger for all FIVE Watchtower alarm conditions and UPSERT/CLEAR the `anomalies` rows. The
 * caller binds `db`/`tenant` to that one tenant (REQ-025). `now` is the sweep clock (injected; the cron reads
 * wall-clock, tests pass a fixed instant). `seq` is the api sequencer DO append surface — the fallback path of the
 * parity_drift rule appends authority.flipped on t:root through it (the cron passes sequencerFor(env)); OMITTED, the
 * parity_drift rule still raises/clears its alarm but performs no auto-fallback (the other 4 rules never need seq).
 * Idempotent + SELF-CLEARING: safe to call every cron tick — a re-sweep of the same state upserts the same rows, a
 * cleared condition resolves its alarm, and the deterministic fallback id dedupes a re-driven flip at the DO.
 */
export async function runWatchtowerSweep(
  db: D1Database,
  tenant: string,
  now: number,
  opts: WatchtowerOpts = {},
  seq?: SeqStubLike,
): Promise<WatchtowerResult> {
  const unbilled = await sweepUnbilled(db, tenant, now, opts);
  const pricing_anomaly = await sweepPricingAnomaly(db, tenant, opts);
  const floor_breach = await sweepFloorBreach(db, tenant, opts);
  const agent_drift = await sweepAgentDrift(db, tenant, now, opts);
  const parity_drift = await sweepParityDrift(db, tenant, now, opts, seq);
  return { unbilled, pricing_anomaly, floor_breach, agent_drift, parity_drift };
}
