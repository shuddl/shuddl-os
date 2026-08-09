import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { EventInput, eventFixture, type EventKind, type JsonObject, type LedgerEvent } from "@shuddl/contracts";
import { eventToRow } from "@shuddl/ledger/lens";
import { projectAgentRuns } from "@shuddl/ledger/projection/agent-runs";
import { projectAuthority } from "@shuddl/ledger/projection/authority";
import { computeModuleParity, type AuthorityModule } from "@shuddl/ledger/parity";
import { resolveAuthority } from "@shuddl/ledger/authority";
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

  // REQ-113 §770 — A RUN THAT REPORTS NO COST IS EXCLUDED, NOT COUNTED AS ZERO.
  //
  // The alarm averages "only REPORTED metrics" (its own header): `costSum / costN`, where costN counts the runs
  // that carried a cost. Dividing by the RUN count instead silently halves the average of a window where half
  // the runs are unmetered — an agent $2/run over a $0.50 budget reads $1, and with two more unmetered runs
  // drops under budget entirely.
  //
  // MUTATION-MEASURED as undefended: replacing `acc.costN` with `acc.runs` left workers/api at 17/17 GREEN,
  // because EVERY fixture supplied a costCents — costN === runs, so the mutation was a no-op. The property was
  // correct and never exercised (§688's "passing corpus", not a redundant guard).
  //
  // DISTINCT from "NEVER fabricates a metric" below, which seeds a window where NOTHING reports — that
  // exercises the `null` average and asserts no alarm. This is the MIXED window: some runs report, some do not,
  // and only there does the choice of divisor change the answer.
  //
  // It becomes load-bearing exactly when §135's dormant gap wakes: the LLM-calling agents report no cost today,
  // so the first mixed window arrives the day one of them starts. That is precisely when a diluted average
  // would hide the drift this alarm exists to catch.
  it("EXCLUDES unmetered runs from the cost average — one reporting run at $2 still breaches a $0.50 budget", async () => {
    const scope = "wt-drift-mixed-";
    const agent = "concierge";
    // One metered run well over budget, three unmetered. Dividing by 4 would read 50¢ — exactly at budget.
    await seedAgentRun(scope, `${scope}s1`, 0, { agent, latencyMs: 100, costCents: 200 });
    await seedAgentRun(scope, `${scope}s2`, 0, { agent, latencyMs: 100 });
    await seedAgentRun(scope, `${scope}s3`, 0, { agent, latencyMs: 100 });
    await seedAgentRun(scope, `${scope}s4`, 0, { agent, latencyMs: 100 });

    const r = await runWatchtowerSweep(env.TENANT_A_DB, TENANT, NOW, { scope });
    expect(r.agent_drift.alarmed, "the unmetered runs diluted the average and hid a real breach").toBe(1);
    const a = await alarm(watchtowerAlarmId(TENANT, "agent_drift", { scope, object: agent }));
    expect(a).not.toBeNull();
    // The average is over the ONE reporting run — never a fabricated zero for the other three.
    expect(JSON.parse(a!.detail)).toMatchObject({ agent, avg_cost_cents: 200, over: ["cost"] });
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

// ─── WP-15 Task 8 — THE parity_drift RULE + AUTO-FALLBACK-TO-LEGACY (REQ-008, the forced-drift DoD) ────
//
// The overlay's safety net: a module PROMOTED to native that then DRIFTS out of parity with the legacy mirror is
// AUTOMATICALLY flipped back to legacy — so a native regression can never silently diverge from the freight the
// incumbent is still running. The 5th Watchtower rule computes the SHARED computeModuleParity per module and:
//   · DRIFT  → RAISE a CRITICAL `parity_drift` anomaly keyed (tenant, module); and if authority is 'native',
//              APPEND authority.flipped{from:'native',to:'legacy',reason:'drift',drift_ref} on t:root via the
//              SeqStub (the Task-1 projection reverts authority_map).
//   · MATCH / UNKNOWN → CLEAR the anomaly (UNKNOWN = can't assess ⇒ never auto-fallback).
//
// THE ASYMMETRY (hard invariant): fallback DOWN (native→legacy) is AUTOMATIC on a single drift breach; promotion
// UP is NEVER automatic — this rule ONLY EVER appends to:'legacy'. Re-promotion requires the gated flip route.
//
// VENUE: the migrated tenant D1 lives in this api harness; the sweep FUNCTION is imported from the agents worker
// and driven with an INJECTED clock + a recording SeqStub. The stub FAITHFULLY reproduces the DO's authority.flipped
// effect on env.TENANT_A_DB — it VALIDATES the fallback as an EventInput (exactly the DO's boundary check), dedupes
// by event id (the DO's replay-by-id), and runs the Task-1 projectAuthority in a batch (what the DO's batch runs) —
// WITHOUT invoking the real cross-worker t:root DO (whose pool-workers reload is a harness flake that leaks a 500
// into sibling SELF.fetch suites). It is a RECORDING SeqStub in the task's sense: it records every authority.flipped
// AND lands the SAME authority_map revert. Isolated + deterministic. The shared D1 (isolatedStorage off) is written
// by other suites, so drift is forced with an ADAPTIVE, BOUNDED seed and MATCH/DRIFT is asserted from LIVE parity.

interface FlipPayload {
  module: string;
  from: string;
  to: string;
  reason: string;
  drift_ref?: string;
}
interface FlipInput {
  kind: string;
  id: string;
  source: string;
  payload: FlipPayload;
}
interface RecordedFlip {
  streamId: string;
  input: FlipInput;
}
interface Recorder {
  seq: { append(req: { tenant: string; streamId: string; input: unknown }): Promise<{ id: string }> };
  flips: RecordedFlip[];
}
// The stub's own "ledger": event ids that ACTUALLY committed (were projected). Simulates the DO's replay-by-id
// dedupe — a re-driven identical id is a no-op (never a second projection), so a re-run cannot double-flip.
const committedFlipIds = new Map<string, number>();

// A recording SeqStub. On append it: (1) records the authority.flipped for assertion; (2) VALIDATES it as an
// EventInput (the DO's boundary — a malformed payload throws, so the test proves the fallback is a valid event);
// (3) dedupes by id (the DO's replay-by-id — a repeat returns the original, NO re-projection); (4) runs the Task-1
// projectAuthority in a batch (the DO's batch), reverting authority_map + recording the id in flipped_events.
// `throwForModule` (optional) INJECTS a persistent append fault for one module — the per-module fault-containment test.
function recordingSeq(throwForModule?: string): Recorder {
  const flips: RecordedFlip[] = [];
  const seq = {
    append: async (req: { tenant: string; streamId: string; input: unknown }): Promise<{ id: string }> => {
      const parsed = EventInput.parse(req.input); // the DO's boundary check — a bad fallback payload throws here
      if (parsed.kind === "authority.flipped") flips.push({ streamId: req.streamId, input: req.input as FlipInput });
      if (parsed.kind === "authority.flipped" && (req.input as FlipInput).payload.module === throwForModule) {
        throw new Error(`injected append fault for module ${throwForModule}`); // simulate a persistent DO/append fault
      }
      const prior = committedFlipIds.get(parsed.id);
      if (prior !== undefined) return { id: parsed.id }; // replay-by-id: the DO returns the original, no re-project
      committedFlipIds.set(parsed.id, 1);
      // projectAuthority reads only kind/id/payload (module,to,gate_snapshot) — the EventInput carries all of them.
      await env.TENANT_A_DB.batch(projectAuthority(env.TENANT_A_DB, parsed as unknown as LedgerEvent));
      return { id: parsed.id };
    },
  };
  return { seq, flips };
}

// A valid QuotePricedPayload whose sell (single line, Σ === sell) is `v` — the rating metric aggregates the sell.
function ratingPayload(v: number): JsonObject {
  return {
    sell: v,
    lines: [{ kind: "freight", code: "LINEHAUL", amount_cents: v }],
    floors: { contribution: 1, full: 1, target: 1 },
    versions: { rate_config_ids: ["zt-drift"] },
    basis: {},
  };
}

let driftSeed = 0;
async function seedRating(source: LedgerEvent["source"], sell: number): Promise<void> {
  await seedEvent("quote.priced", `pd-rating-${source}-${driftSeed++}`, 0, { source, payload: ratingPayload(sell) });
}
async function seedSettlement(source: LedgerEvent["source"], fee: number): Promise<void> {
  await seedEvent("settlement.executed", `pd-settle-${source}-${driftSeed++}`, 0, { source, payload: { fee_cents: fee } });
}

// Force `module` into DRIFT with a BOUNDED shared aggregate. A tiny legacy seed guarantees BOTH sides present (⇒
// DRIFT not UNKNOWN); the native seed is ADAPTIVE — 2× the larger current side (+ a floor) — so native clears both
// current sums by ≥100% (drift ≫ the module tolerance) REGARDLESS of the shared-D1 pollution the sweep reads,
// WITHOUT exploding the aggregate. Bounding it matters: authority-flip.test.ts converges then breaks rating parity
// with a fixed 999e6 delta, which must stay a >10% swing — a huge native seed here would silently defeat that.
async function forceDrift(
  seedFn: (source: LedgerEvent["source"], v: number) => Promise<void>,
  module: AuthorityModule,
): Promise<Awaited<ReturnType<typeof computeModuleParity>>> {
  await seedFn("legacy", 1_000);
  const p0 = await computeModuleParity(env.TENANT_A_DB, module);
  const nat = p0.native_value === "UNKNOWN" ? 0 : p0.native_value;
  const leg = p0.legacy_value === "UNKNOWN" ? 0 : p0.legacy_value;
  await seedFn("native", Math.max(nat, leg, 1_000_000) * 2 + 1_000_000);
  return computeModuleParity(env.TENANT_A_DB, module);
}

// Seed authority_map to the PROMOTED (native) state with a specific native-promotion event id as the ONLY entry in
// flipped_events — i.e. the episode marker. Resetting flipped_events to [marker] lets a test control the episode
// deterministically (a torn/concurrent re-run vs a genuinely NEW promotion episode).
async function seedPromoted(module: string, promoId: string): Promise<void> {
  await env.TENANT_A_DB.prepare(
    "INSERT INTO authority_map (module, authority, gates_status, flipped_events) VALUES (?, 'native', '{}', json_array(?)) " +
      "ON CONFLICT(module) DO UPDATE SET authority = 'native', flipped_events = json_array(?)",
  )
    .bind(module, promoId, promoId)
    .run();
}
async function flippedEvents(module: string): Promise<string[]> {
  const row = await env.TENANT_A_DB.prepare("SELECT flipped_events FROM authority_map WHERE module = ?").bind(module).first<{ flipped_events: string }>();
  return JSON.parse(row?.flipped_events ?? "[]") as string[];
}
// The recorded fallbacks for a SPECIFIC module — a sweep processes all 5, so a coincidental fallback on ANOTHER
// module (from shared-D1 pollution) must not perturb the count for the module under test.
const flipsFor = (rec: Recorder, mod: string): RecordedFlip[] => rec.flips.filter((f) => f.input.payload.module === mod);

describe("Watchtower — parity_drift auto-fallback-to-legacy (REQ-008, the forced-drift DoD)", () => {
  it("forced drift on a NATIVE module → CRITICAL alarm + auto-fallback to legacy on t:root; idempotent (deterministic id dedupes); a NEW episode → a NEW fallback; NEVER auto-re-promotes (a–f)", async () => {
    const module = "rating";
    const allFlips: RecordedFlip[] = []; // every recorded fallback across the test — for the no-to:'native' asymmetry assertion

    // ── seed the PROMOTED state: authority_map{rating:'native'} + a native-promotion event id in flipped_events
    //    (the episode marker the deterministic fallback id folds in) ──────────────────────────────────────────
    const promoId = crypto.randomUUID();
    await seedPromoted(module, promoId);
    expect(await resolveAuthority(env.TENANT_A_DB, module)).toBe("native");

    // ── force DRIFT: diverging native + legacy quote.priced beyond the ±10% rating tolerance ──
    const p = await forceDrift(seedRating, module);
    expect(p.status).toBe("DRIFT"); // precondition (read from LIVE parity, never assumed)

    // ── drive the SAME exported sweep the cron calls, with a recording/real SeqStub ──
    const s1 = recordingSeq();
    await runWatchtowerSweep(env.TENANT_A_DB, TENANT, NOW, {}, s1.seq);
    allFlips.push(...s1.flips);

    // (a) a CRITICAL parity_drift anomaly keyed (tenant, rating) exists
    const alarmId = watchtowerAlarmId(TENANT, "parity_drift", { object: module });
    const a = await alarm(alarmId);
    expect(a).not.toBeNull();
    expect(a!.rule).toBe("parity_drift");
    expect(a!.severity).toBe("critical");
    expect(a!.status).toBe("open");
    expect(a!.object_kind).toBe("module");
    expect(a!.object_id).toBe(module);
    expect(JSON.parse(a!.detail)).toMatchObject({ module, drift_bps: p.drift_bps });

    // 2026-08-02 §33 — the alarm must report the fallback OUTCOME truthfully, and this is the case where the
    // first cut of that field lied. `attempted` was re-derived by calling resolveAuthority AGAIN after the
    // attempt — but a SUCCESSFUL fallback appends authority.flipped→legacy, so the second call returns
    // "legacy" and `attempted` read FALSE precisely when the fallback had worked. It was correct only by
    // accident in the failure path (authority still native), which is the path the existing test covered.
    const d1 = JSON.parse(a!.detail) as { fell_back?: boolean; attempted?: boolean; still_on_native?: boolean };
    expect(d1.fell_back, "the fallback SUCCEEDED — the alarm must say so").toBe(true);
    expect(d1.attempted, "…and must record that it was attempted, even though authority is now legacy").toBe(true);
    expect(d1.still_on_native, "a successful fallback is not still on native").toBeUndefined();

    // (c) an authority.flipped{ reason:'drift', to:'legacy' } appended on t:root (source:'native' control event)
    const s1flips = flipsFor(s1, module);
    expect(s1flips.length).toBe(1);
    const flip = s1flips[0]!;
    expect(flip.streamId).toBe("t:root");
    expect(flip.input.source).toBe("native");
    expect(flip.input.payload.to).toBe("legacy");
    expect(flip.input.payload.from).toBe("native");
    expect(flip.input.payload.reason).toBe("drift");
    expect(flip.input.payload.module).toBe(module);
    expect(flip.input.payload.drift_ref).toBe(alarmId); // the audit link = the parity_drift anomaly id
    const fallbackId = flip.input.id;

    // (b) authority_map.rating reverted to legacy (via the Task-1 projection running in the DO batch)
    expect(await resolveAuthority(env.TENANT_A_DB, module)).toBe("legacy");

    // (d) the fallback id is recorded in authority_map.flipped_events (alongside the promotion)
    const fe1 = await flippedEvents(module);
    expect(fe1).toContain(fallbackId);
    expect(fe1).toContain(promoId);

    // (e) IDEMPOTENT: authority is now legacy → a re-sweep does NOT re-fire (no second fallback, no double-flip)
    const s2 = recordingSeq();
    await runWatchtowerSweep(env.TENANT_A_DB, TENANT, NOW, {}, s2.seq);
    allFlips.push(...s2.flips);
    expect(flipsFor(s2, module).length).toBe(0);
    expect(await resolveAuthority(env.TENANT_A_DB, module)).toBe("legacy");
    expect((await alarm(alarmId))!.status).toBe("open"); // still drifting → alarm stays raised, but NO fallback

    // ── IDEMPOTENCY BELT (deterministic-id dedupe): simulate a torn/concurrent re-run WITHIN the SAME native
    //    episode — restore authority=native with the SAME episode marker (promoId), as if the fallback's projection
    //    had not yet committed. The fallback id is DERIVED from the episode marker, so it reproduces `fallbackId`;
    //    the sequencer's replay-by-id returns the original → NO second fallback event row is ever inserted. ──
    await seedPromoted(module, promoId); // authority native again, marker = the SAME promoId
    const s3 = recordingSeq();
    await runWatchtowerSweep(env.TENANT_A_DB, TENANT, NOW, {}, s3.seq);
    allFlips.push(...s3.flips);
    const s3flips = flipsFor(s3, module);
    expect(s3flips.length).toBe(1);
    expect(s3flips[0]!.input.id).toBe(fallbackId); // SAME episode marker ⇒ SAME deterministic id
    expect(committedFlipIds.get(fallbackId)).toBe(1); // deduped by id: committed exactly ONCE (no double-flip)

    // ── NEW EPISODE ⇒ NEW fallback id: a LATER re-promotion (a new gated flip to native, a distinct marker) that
    //    drifts again is a NEW episode → a NEW fallback id, NOT deduped to the old episode's fallback. ──
    const promoId2 = crypto.randomUUID();
    await seedPromoted(module, promoId2);
    const s4 = recordingSeq();
    await runWatchtowerSweep(env.TENANT_A_DB, TENANT, NOW, {}, s4.seq);
    allFlips.push(...s4.flips);
    const s4flips = flipsFor(s4, module);
    expect(s4flips.length).toBe(1);
    const fallbackId2 = s4flips[0]!.input.id;
    expect(fallbackId2).not.toBe(fallbackId); // NEW episode ⇒ NEW id (not deduped to the prior episode)
    expect(await resolveAuthority(env.TENANT_A_DB, module)).toBe("legacy"); // the NEW fallback committed + reverted

    // (f) NO auto-re-promotion: converge rating (native ≈ legacy) and re-sweep — the parity_drift anomaly CLEARS
    //     (resolves) BUT authority_map.rating STAYS 'legacy' (this rule NEVER promotes; up is the gated route only).
    const pc = await computeModuleParity(env.TENANT_A_DB, module);
    const deficit = (pc.native_value as number) - (pc.legacy_value as number);
    if (deficit > 0) await seedRating("legacy", deficit); // match the sums ⇒ drift 0 ⇒ MATCH
    expect((await computeModuleParity(env.TENANT_A_DB, module)).status).toBe("MATCH"); // converged
    const s5 = recordingSeq();
    await runWatchtowerSweep(env.TENANT_A_DB, TENANT, NOW, {}, s5.seq);
    allFlips.push(...s5.flips);
    expect((await alarm(alarmId))!.status).toBe("resolved"); // alarm cleared on MATCH
    expect(flipsFor(s5, module).length).toBe(0); // nothing appended on a MATCH
    expect(await resolveAuthority(env.TENANT_A_DB, module)).toBe("legacy"); // STAYS legacy — never auto-re-promoted

    // ── THE ASYMMETRY (hard invariant): across EVERY fallback this rule appended, `to` is ALWAYS 'legacy'. It is
    //    structurally impossible for the drift rule to promote a module to native (that stays on the gated route). ──
    expect(allFlips.length).toBeGreaterThan(0);
    for (const f of allFlips) expect(f.input.payload.to).toBe("legacy");
  });

  it("a module already at authority='legacy' that drifts → the alarm is RAISED but NO fallback event (nothing to fall back — it is already legacy)", async () => {
    const module = "settlement";
    // settlement is a money module — never promoted in-repo; pin it legacy to be explicit against shared-D1 drift.
    await env.TENANT_A_DB.prepare(
      "INSERT INTO authority_map (module, authority) VALUES (?, 'legacy') ON CONFLICT(module) DO UPDATE SET authority = 'legacy'",
    )
      .bind(module)
      .run();
    expect(await resolveAuthority(env.TENANT_A_DB, module)).toBe("legacy");

    expect((await forceDrift(seedSettlement, module)).status).toBe("DRIFT");

    const s = recordingSeq();
    await runWatchtowerSweep(env.TENANT_A_DB, TENANT, NOW, {}, s.seq);
    // the alarm RAISES (a divergence must be VISIBLE even when authority is already legacy)...
    const a = await alarm(watchtowerAlarmId(TENANT, "parity_drift", { object: module }));
    expect(a!.rule).toBe("parity_drift");
    expect(a!.severity).toBe("critical");
    expect(a!.status).toBe("open");
    // ...but NOTHING is appended for it — there is nothing to fall back to (already legacy).
    expect(flipsFor(s, module).length).toBe(0);
    expect(await resolveAuthority(env.TENANT_A_DB, module)).toBe("legacy");
  });

  it("UNKNOWN parity (only one side present) → NO alarm and NO fallback (a side missing is unassessable, never a drift)", async () => {
    const module = "comms";
    await env.TENANT_A_DB.prepare(
      "INSERT INTO authority_map (module, authority) VALUES (?, 'native') ON CONFLICT(module) DO UPDATE SET authority = 'native'",
    )
      .bind(module)
      .run();
    // comms is a COUNT metric; seed ONLY native message.sent (no legacy side) ⇒ legacy UNKNOWN ⇒ status UNKNOWN.
    await seedEvent("message.sent", `pd-comms-native-${driftSeed++}`, 0, { source: "native" });
    const parity = await computeModuleParity(env.TENANT_A_DB, module);
    expect(parity.status).toBe("UNKNOWN"); // one side missing

    const s = recordingSeq();
    await runWatchtowerSweep(env.TENANT_A_DB, TENANT, NOW, {}, s.seq);
    // UNKNOWN → the alarm is CLEARED/absent (never raised on an unassessable side) and NO fallback fires...
    const a = await alarm(watchtowerAlarmId(TENANT, "parity_drift", { object: module }));
    expect(a === null || a.status === "resolved").toBe(true);
    expect(flipsFor(s, module).length).toBe(0);
    // ...and a native module whose mirror is UNKNOWN is NOT auto-fallen-back (the documented "unmonitored" gap).
    expect(await resolveAuthority(env.TENANT_A_DB, module)).toBe("native");
  });

  it("PER-MODULE FAULT CONTAINMENT: a fallback append fault on one module does NOT stall the others (alarm still raised; later modules still evaluated; sweep does not throw) (REQ-008)", async () => {
    // rating (FIRST in PARITY_MODULES): native + DRIFT ⇒ the fallback append is ATTEMPTED — and injected to throw.
    await seedPromoted("rating", crypto.randomUUID());
    expect((await forceDrift(seedRating, "rating")).status).toBe("DRIFT");
    // settlement (a LATER module in PARITY_MODULES): legacy + DRIFT ⇒ it must STILL be RAISED this same sweep.
    await env.TENANT_A_DB.prepare(
      "INSERT INTO authority_map (module, authority) VALUES ('settlement','legacy') ON CONFLICT(module) DO UPDATE SET authority = 'legacy'",
    ).run();
    expect((await forceDrift(seedSettlement, "settlement")).status).toBe("DRIFT");
    // CLEAR settlement's alarm first so a raise THIS sweep is observable (not a stale open from an earlier test).
    const settleAlarmId = watchtowerAlarmId(TENANT, "parity_drift", { object: "settlement" });
    await env.TENANT_A_DB.prepare("UPDATE anomalies SET status = 'resolved' WHERE id = ?").bind(settleAlarmId).run();

    const s = recordingSeq("rating"); // the seq THROWS on rating's fallback append (a persistent enforcement fault)
    // CONTAINMENT: the sweep RESOLVES (does not throw) despite the rating append fault.
    await expect(runWatchtowerSweep(env.TENANT_A_DB, TENANT, NOW, {}, s.seq)).resolves.toBeDefined();

    // rating's CRITICAL alarm is STILL raised (alarm-before-append ordering held) and it did NOT flip (append threw).
    const ra = await alarm(watchtowerAlarmId(TENANT, "parity_drift", { object: "rating" }));
    expect(ra!.severity).toBe("critical");
    expect(ra!.status).toBe("open");
    expect(await resolveAuthority(env.TENANT_A_DB, "rating")).toBe("native"); // fault ⇒ NO flip; the retry is next tick

    // ...and SETTLEMENT (evaluated AFTER rating in the loop) was STILL raised THIS sweep — the loop did not abort.
    const sa = await alarm(settleAlarmId);
    expect(sa!.status).toBe("open");
    expect(sa!.severity).toBe("critical");

    // cleanup: leave rating legacy for sibling suites (its aggregate stays DRIFT but authority reverts).
    await env.TENANT_A_DB.prepare("UPDATE authority_map SET authority = 'legacy' WHERE module = 'rating'").run();
  });

  it("seq-optional contract: WITHOUT a seq the rule RAISES the alarm but does NOT enforce (fail-safe, no flip); WITH a seq it DOES flip (the cron threads sequencerFor(env))", async () => {
    const module = "rating";
    await seedPromoted(module, crypto.randomUUID());
    expect((await forceDrift(seedRating, module)).status).toBe("DRIFT");
    const alarmId = watchtowerAlarmId(TENANT, "parity_drift", { object: module });

    // WITHOUT a seq (the other 4 rules' calling convention): alarm RAISED, NO enforcement — authority stays native.
    await runWatchtowerSweep(env.TENANT_A_DB, TENANT, NOW, {}); // no 5th arg
    const noSeq = await alarm(alarmId);
    expect(noSeq!.status).toBe("open");
    expect(noSeq!.severity).toBe("critical");
    expect(await resolveAuthority(env.TENANT_A_DB, module)).toBe("native"); // seq-absent ⇒ NO flip (fail-safe)

    // WITH a seq (what the cron's runWatchtower threads via sequencerFor(env)): the SAME drift now DOES flip to legacy.
    const s = recordingSeq();
    await runWatchtowerSweep(env.TENANT_A_DB, TENANT, NOW, {}, s.seq);
    expect(flipsFor(s, module).length).toBe(1);
    expect(await resolveAuthority(env.TENANT_A_DB, module)).toBe("legacy");
  });
});
