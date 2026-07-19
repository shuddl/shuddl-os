import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { eventFixture, type EventKind, type JsonObject, type LedgerEvent } from "@shuddl/contracts";
import { eventToRow } from "@shuddl/ledger/lens";
import { projectAgentRuns } from "@shuddl/ledger/projection/agent-runs";
import { runWatchtowerSweep, watchtowerAlarmId } from "../../agents/src/watchtower.js";
import { computeUnbilled } from "../src/kpis/compute.js";
import { ensureSchema } from "./helpers.js";

// ─── WP-11 Task 8 — THE WATCHTOWER: durable alarms into the EXISTING `anomalies` table (REQ-036) ──────
//
// The per-tenant sweep raises three alarm rules as `anomalies` rows (NO new table, NO new event kind):
//   1. unbilled       — shipments with a committed pod.signed but NO invoice.issued (the DoD $0-revenue bill).
//   2. pricing_anomaly — committed quote.priced whose payload.basis.anomaly != null (the $222,084/35-lb net).
//   3. floor_breach    — OPEN below-floor approvals (the `approvals` read-model status='open').
// Each rule UPSERTs ONE deterministic row per (tenant, rule, object): open→escalate, self-clears to 'resolved'
// when the condition clears, and a re-sweep of the same state is idempotent (no duplicate row).
//
// VENUE (like collector-cron.test.ts): the migrated tenant D1 lives in this api harness; the sweep FUNCTION is
// imported from the agents worker and driven directly with an INJECTED clock. isolatedStorage is OFF (shared D1),
// so every case uses a DISTINCT scope prefix and asserts on its OWN deterministic alarm id — the aggregate
// alarms (unbilled/floor_breach) are scoped so a sibling case's rows never disturb a per-scope assertion.

const NOW = Date.parse("2026-07-17T00:00:00Z");
const TENANT = "tenant-a";

let hashN = 0xf0000;
const nextHash = (): string => (hashN++).toString(16).padStart(64, "0");

// Direct-insert an event (bypasses the sequencer/route — we drive the READ/sweep path, mirroring
// isolation.test.ts). A unique 64-hex hash keeps the UNIQUE(hash) + append-only insert guard happy.
async function seedEvent(kind: EventKind, shipmentId: string, seq: number, overrides: Partial<LedgerEvent> = {}): Promise<void> {
  const e = eventFixture(kind, {
    id: crypto.randomUUID(),
    stream_id: `s:${shipmentId}`,
    shipment_id: shipmentId,
    seq,
    ts: NOW,
    visibility: "internal",
    party_refs: [],
    ...overrides,
  });
  const row = eventToRow(e);
  row.hash = nextHash();
  const cols = Object.keys(row);
  await env.TENANT_A_DB.prepare(`INSERT INTO events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .bind(...cols.map((c) => row[c]))
    .run();
}

// A valid quote.priced payload (Σlines === sell) carrying basis.anomaly — the exact shape rate.ts stamps.
function anomalyPricedPayload(sell: number): JsonObject {
  return {
    sell,
    lines: [{ kind: "freight", code: "LINEHAUL", amount_cents: sell }],
    floors: { contribution: 1, full: 1, target: 1 },
    versions: { rate_config_ids: ["zt-anom"] },
    basis: { anomaly: { code: "over_per_lb", detail: `sell ${sell}¢ on 35 lb exceeds cap`, per_lb_cents: 634_526, cap_cents_per_lb: 200_000 } },
  };
}
function sanePricedPayload(sell: number): JsonObject {
  return {
    sell,
    lines: [{ kind: "freight", code: "LINEHAUL", amount_cents: sell }],
    floors: { contribution: 1, full: 1, target: 1 },
    versions: { rate_config_ids: ["zt-test"] },
    basis: { anomaly: null }, // sane price — the net did not trip; NEVER a pricing_anomaly alarm
  };
}

interface AlarmRow {
  id: string;
  rule: string;
  object_kind: string | null;
  object_id: string | null;
  severity: string;
  detail: string;
  status: string;
}
async function alarm(id: string): Promise<AlarmRow | null> {
  return env.TENANT_A_DB.prepare("SELECT id, rule, object_kind, object_id, severity, detail, status FROM anomalies WHERE id = ?")
    .bind(id)
    .first<AlarmRow>();
}
async function alarmCount(id: string): Promise<number> {
  const r = await env.TENANT_A_DB.prepare("SELECT COUNT(*) AS n FROM anomalies WHERE id = ?").bind(id).first<{ n: number }>();
  return r?.n ?? 0;
}

// Seed a metered agent.acted event (into `events`) AND project it into `agent_runs` — the exact end-to-end
// path the sequencer runs (REQ-113). Returns the event id. The drift sweep JOINs agent_runs→events for ts.
async function seedAgentRun(
  scope: string,
  shipmentId: string,
  seq: number,
  opts: { agent: string; latencyMs?: number; costCents?: number; ts?: number },
): Promise<string> {
  const payload: JsonObject = {
    agent: opts.agent,
    action: "acted",
    basis: [{ kind: "config", id: "rc-x" }],
    confidence_bps: 10_000,
    ...(opts.costCents !== undefined ? { cost_cents: opts.costCents } : {}),
    ...(opts.latencyMs !== undefined ? { latency_ms: opts.latencyMs } : {}),
  };
  const e = eventFixture("agent.acted", {
    id: crypto.randomUUID(),
    stream_id: `s:${shipmentId}`,
    shipment_id: shipmentId,
    seq,
    ts: opts.ts ?? NOW,
    visibility: "internal",
    party_refs: [],
    payload,
  });
  const row = eventToRow(e);
  row.hash = nextHash();
  const cols = Object.keys(row);
  await env.TENANT_A_DB.prepare(`INSERT INTO events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .bind(...cols.map((c) => row[c]))
    .run();
  await env.TENANT_A_DB.batch(projectAgentRuns(env.TENANT_A_DB, e));
  return e.id;
}

async function seedOpenApproval(scope: string, objectId: string, reqEventId: string): Promise<void> {
  await env.TENANT_A_DB.prepare(
    "INSERT OR IGNORE INTO approvals (id, object_kind, object_id, rule, required_role, requested_event_id, status) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(`appr:${scope}:${objectId}`, "shipment", objectId, "below_target_or", "ops", reqEventId, "open")
    .run();
}

beforeAll(async () => {
  await ensureSchema(env);
});

describe("Watchtower — the unbilled=0 alarm (REQ-036 DoD: fires on a seeded $0-revenue bill)", () => {
  it("RAISES an 'unbilled' alarm for a POD-signed shipment with NO invoice (the DoD), and CLEARS it once invoiced", async () => {
    const scope = "wt-unb-dod-";
    const shp = `${scope}shp1`;
    await seedEvent("pod.signed", shp, 0); // committed POD, no invoice.issued → unbilled

    // SWEEP → the alarm RAISES (the DoD $0-revenue-bill proof).
    const r1 = await runWatchtowerSweep(env.TENANT_A_DB, TENANT, NOW, { scope });
    expect(r1.unbilled.count).toBe(1);
    const id = watchtowerAlarmId(TENANT, "unbilled", { scope });
    const a1 = await alarm(id);
    expect(a1).not.toBeNull();
    expect(a1!.rule).toBe("unbilled");
    expect(a1!.status).toBe("open");
    expect(a1!.severity).toBe("warn"); // a single, fresh unbilled → warn (escalates by count/age)
    expect(JSON.parse(a1!.detail)).toMatchObject({ count: 1, shipments: [shp] });

    // INVOICE it → the anti-join is now empty → the alarm SELF-CLEARS to 'resolved'.
    await seedEvent("invoice.issued", shp, 1);
    const r2 = await runWatchtowerSweep(env.TENANT_A_DB, TENANT, NOW, { scope });
    expect(r2.unbilled.count).toBe(0);
    const a2 = await alarm(id);
    expect(a2!.status).toBe("resolved"); // cleared, not deleted — the alarm row persists as resolved
  });

  it("IDEMPOTENT — a re-sweep of the SAME unbilled state upserts the SAME row (never a duplicate)", async () => {
    const scope = "wt-unb-idem-";
    await seedEvent("pod.signed", `${scope}shp1`, 0);
    await runWatchtowerSweep(env.TENANT_A_DB, TENANT, NOW, { scope });
    await runWatchtowerSweep(env.TENANT_A_DB, TENANT, NOW, { scope }); // aggressive re-run
    expect(await alarmCount(watchtowerAlarmId(TENANT, "unbilled", { scope }))).toBe(1); // exactly one row
  });

  it("shared-predicate parity — computeUnbilled (KPI) and the Watchtower agree on the SAME data (no drift)", async () => {
    const scope = "wt-unb-parity-";
    await seedEvent("pod.signed", `${scope}shp1`, 0);
    await seedEvent("pod.signed", `${scope}shp2`, 0);
    const kpi = await computeUnbilled(env.TENANT_A_DB, { scope });
    const wt = await runWatchtowerSweep(env.TENANT_A_DB, TENANT, NOW, { scope });
    expect(kpi).toBe(2);
    expect(wt.unbilled.count).toBe(kpi); // ONE source of truth (skill share-lint-matchers-with-parity-tests)
  });
});

describe("Watchtower — the pricing-anomaly alarm (REQ-040 net → REQ-036 alarm)", () => {
  it("RAISES a critical 'pricing_anomaly' alarm for a quote.priced whose basis.anomaly != null", async () => {
    const scope = "wt-anom-";
    const shp = `${scope}shp1`;
    await seedEvent("quote.priced", shp, 0, { payload: anomalyPricedPayload(22_208_400) });
    // A SANE quote on another shipment must NEVER alarm.
    await seedEvent("quote.priced", `${scope}sane`, 0, { payload: sanePricedPayload(148_000) });

    const r = await runWatchtowerSweep(env.TENANT_A_DB, TENANT, NOW, { scope });
    expect(r.pricing_anomaly.count).toBe(1); // only the anomalous quote alarmed, not the sane one

    // The alarm is keyed per anomalous quote EVENT (the object), critical, carrying the anomaly detail.
    const anomEvent = await env.TENANT_A_DB.prepare("SELECT id FROM events WHERE shipment_id = ? AND kind='quote.priced'").bind(shp).first<{ id: string }>();
    const id = watchtowerAlarmId(TENANT, "pricing_anomaly", { object: anomEvent!.id });
    const a = await alarm(id);
    expect(a).not.toBeNull();
    expect(a!.rule).toBe("pricing_anomaly");
    expect(a!.severity).toBe("critical");
    expect(a!.status).toBe("open");
    expect(a!.object_id).toBe(shp);
    expect(JSON.parse(a!.detail)).toMatchObject({ code: "over_per_lb" });
  });

  it("IDEMPOTENT — a re-sweep upserts the SAME pricing_anomaly row (never a duplicate)", async () => {
    const scope = "wt-anom-idem-";
    const shp = `${scope}shp1`;
    await seedEvent("quote.priced", shp, 0, { payload: anomalyPricedPayload(9_999_900) });
    await runWatchtowerSweep(env.TENANT_A_DB, TENANT, NOW, { scope });
    await runWatchtowerSweep(env.TENANT_A_DB, TENANT, NOW, { scope });
    const anomEvent = await env.TENANT_A_DB.prepare("SELECT id FROM events WHERE shipment_id = ? AND kind='quote.priced'").bind(shp).first<{ id: string }>();
    expect(await alarmCount(watchtowerAlarmId(TENANT, "pricing_anomaly", { object: anomEvent!.id }))).toBe(1);
  });
});

describe("Watchtower — the floor-breach alarm (open below-floor approvals → REQ-036 alarm)", () => {
  it("RAISES a 'floor_breach' warn alarm for OPEN below-floor approvals, CLEARS when none remain", async () => {
    const scope = "wt-floor-";
    await seedOpenApproval(scope, `${scope}shp1`, `${scope}req1`);
    await seedOpenApproval(scope, `${scope}shp2`, `${scope}req2`);

    const r1 = await runWatchtowerSweep(env.TENANT_A_DB, TENANT, NOW, { scope });
    expect(r1.floor_breach.count).toBe(2);
    const id = watchtowerAlarmId(TENANT, "floor_breach", { scope });
    const a1 = await alarm(id);
    expect(a1).not.toBeNull();
    expect(a1!.rule).toBe("floor_breach");
    expect(a1!.severity).toBe("warn");
    expect(a1!.status).toBe("open");
    expect(JSON.parse(a1!.detail)).toMatchObject({ open_count: 2 });

    // Decide both approvals (flip to 'decided') → no open below-floor → the alarm self-clears.
    await env.TENANT_A_DB.prepare("UPDATE approvals SET status='decided' WHERE object_id LIKE ?").bind(`${scope}%`).run();
    const r2 = await runWatchtowerSweep(env.TENANT_A_DB, TENANT, NOW, { scope });
    expect(r2.floor_breach.count).toBe(0);
    expect((await alarm(id))!.status).toBe("resolved");
  });
});

describe("Watchtower — the agent-drift alarm (REQ-113 per-agent cost/latency budget)", () => {
  it("RAISES a critical 'agent_drift' alarm when an agent's avg LATENCY exceeds budget", async () => {
    const scope = "wt-drift-lat-";
    const agent = "rater";
    // Two runs BOTH far over the 5s default latency budget (avg 12s) → CRITICAL (>= 2× budget).
    await seedAgentRun(scope, `${scope}s1`, 0, { agent, latencyMs: 12_000, costCents: 0 });
    await seedAgentRun(scope, `${scope}s2`, 0, { agent, latencyMs: 12_000, costCents: 0 });

    const r = await runWatchtowerSweep(env.TENANT_A_DB, TENANT, NOW, { scope });
    expect(r.agent_drift.alarmed).toBe(1);
    const id = watchtowerAlarmId(TENANT, "agent_drift", { scope, object: agent });
    const a = await alarm(id);
    expect(a).not.toBeNull();
    expect(a!.rule).toBe("agent_drift");
    expect(a!.object_kind).toBe("agent");
    expect(a!.object_id).toBe(agent);
    expect(a!.status).toBe("open");
    expect(a!.severity).toBe("critical");
    // The alarm carries the REAL computed averages, never a fabricated number.
    expect(JSON.parse(a!.detail)).toMatchObject({ agent, avg_latency_ms: 12_000, avg_cost_cents: 0, over: ["latency"] });
  });

  it("RAISES on COST drift alone (avg cost per run over budget) with latency well inside budget", async () => {
    const scope = "wt-drift-cost-";
    const agent = "concierge";
    await seedAgentRun(scope, `${scope}s1`, 0, { agent, latencyMs: 100, costCents: 200 }); // $2 avg vs $0.50 budget
    const r = await runWatchtowerSweep(env.TENANT_A_DB, TENANT, NOW, { scope });
    expect(r.agent_drift.alarmed).toBe(1);
    const a = await alarm(watchtowerAlarmId(TENANT, "agent_drift", { scope, object: agent }));
    expect(a!.status).toBe("open");
    expect(JSON.parse(a!.detail)).toMatchObject({ agent, avg_cost_cents: 200, over: ["cost"] });
  });

  it("does NOT alarm an agent within budget (a real 0-cost deterministic run, fast latency)", async () => {
    const scope = "wt-drift-ok-";
    const agent = "rater";
    await seedAgentRun(scope, `${scope}s1`, 0, { agent, latencyMs: 40, costCents: 0 });
    const r = await runWatchtowerSweep(env.TENANT_A_DB, TENANT, NOW, { scope });
    expect(r.agent_drift.alarmed).toBe(0);
    // Never raised → no row (clearAlarm on a non-existent id is a safe no-op).
    expect(await alarm(watchtowerAlarmId(TENANT, "agent_drift", { scope, object: agent }))).toBeNull();
  });

  it("NEVER fabricates a metric — an agent reporting NO cost/latency cannot trip a drift alarm", async () => {
    const scope = "wt-drift-nofab-";
    const agent = "booking";
    await seedAgentRun(scope, `${scope}s1`, 0, { agent }); // no cost_cents, no latency_ms → '{}' / NULL
    const r = await runWatchtowerSweep(env.TENANT_A_DB, TENANT, NOW, { scope });
    expect(r.agent_drift.alarmed).toBe(0);
    expect(await alarm(watchtowerAlarmId(TENANT, "agent_drift", { scope, object: agent }))).toBeNull();
  });

  it("SELF-CLEARS when the over-budget runs age out of the 24h window (avg back in budget)", async () => {
    const scope = "wt-drift-clear-";
    const agent = "biller";
    await seedAgentRun(scope, `${scope}s1`, 0, { agent, latencyMs: 20_000, costCents: 0, ts: NOW });
    await runWatchtowerSweep(env.TENANT_A_DB, TENANT, NOW, { scope });
    const id = watchtowerAlarmId(TENANT, "agent_drift", { scope, object: agent });
    expect((await alarm(id))!.status).toBe("open");

    // Advance the sweep clock 3 days: the only metered run now falls OUTSIDE the 24h window → no in-window
    // runs → the agent is back in budget → the alarm self-clears (resolved, not deleted).
    const later = NOW + 3 * 86_400_000;
    const r2 = await runWatchtowerSweep(env.TENANT_A_DB, TENANT, later, { scope });
    expect(r2.agent_drift.alarmed).toBe(0);
    expect((await alarm(id))!.status).toBe("resolved");
  });

  it("IDEMPOTENT — a re-sweep of the SAME drift state upserts the SAME row (never a duplicate)", async () => {
    const scope = "wt-drift-idem-";
    const agent = "rater";
    await seedAgentRun(scope, `${scope}s1`, 0, { agent, latencyMs: 30_000, costCents: 0 });
    await runWatchtowerSweep(env.TENANT_A_DB, TENANT, NOW, { scope });
    await runWatchtowerSweep(env.TENANT_A_DB, TENANT, NOW, { scope }); // aggressive re-run
    expect(await alarmCount(watchtowerAlarmId(TENANT, "agent_drift", { scope, object: agent }))).toBe(1);
  });
});
