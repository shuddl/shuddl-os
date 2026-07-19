import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { eventFixture, type EventKind, type JsonObject, type LedgerEvent } from "@shuddl/contracts";
import { eventToRow } from "@shuddl/ledger/lens";
import { projectAgentRuns } from "@shuddl/ledger/projection/agent-runs";
import {
  computePodToInvoiceLatencyMs,
  computeRatingLatencyMs,
  computeDisputesOpen,
  computeCloseDurationMs,
  computeUnbilled as sharedUnbilled,
  computeDsoDays as sharedDso,
  computeCostRatioBps as sharedOr,
  WEEK_MS,
} from "@shuddl/ledger/queries/metrics";
import { computeUnbilled, computeDsoDays, computeCostRatioBps } from "../src/kpis/compute.js";
import { ensureSchema } from "./helpers.js";

// WP-11 Task 10 (REQ-160) — the 4 NET-NEW health metrics + the SHARED-COMPUTE PARITY, driven in the api harness
// (migrated tenant D1 + the KPI route's own compute module for the parity check). These tests import ONLY modules
// already in the api worker's source graph (@shuddl/ledger/queries/metrics is pulled in by kpis/compute.ts) — the
// snapshot MANIFEST/persist/gate tests live in the agents harness (workers/agents/test/watchtower-snapshot.test.ts),
// where that module is native, to keep this api harness's module graph stable.
//
// THE HONESTY LAW (WP-10/11): every metric is a REAL number from real ledger rows OR the literal UNKNOWN — never
// fabricated. isolatedStorage is OFF (shared D1), so each case uses a DISTINCT `snap-*` scope prefix.

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const NOW = Date.parse("2026-07-20T00:00:00Z");

const hex64 = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

async function seedEvent(
  kind: EventKind,
  shipmentId: string,
  seq: number,
  o: { ts?: number; payload?: JsonObject } = {},
): Promise<string> {
  const overrides: Partial<LedgerEvent> = {
    id: crypto.randomUUID(),
    stream_id: `s:${shipmentId}`,
    shipment_id: shipmentId,
    seq,
    ts: o.ts ?? NOW,
    visibility: "internal",
    party_refs: [],
    ...(o.payload !== undefined ? { payload: o.payload } : {}),
  };
  const e = eventFixture(kind, overrides);
  const row = eventToRow(e);
  row.hash = hex64();
  const cols = Object.keys(row);
  await env.TENANT_A_DB.prepare(`INSERT INTO events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .bind(...cols.map((c) => row[c]))
    .run();
  return e.id;
}

async function seedAgentRun(
  shipmentId: string,
  seq: number,
  o: { latencyMs?: number; costCents?: number; agent?: string; ts?: number },
): Promise<void> {
  const payload: JsonObject = {
    agent: o.agent ?? "rater",
    action: "priced",
    basis: [{ kind: "config", id: "rc-x" }],
    confidence_bps: 10_000,
    ...(o.costCents !== undefined ? { cost_cents: o.costCents } : {}),
    ...(o.latencyMs !== undefined ? { latency_ms: o.latencyMs } : {}),
  };
  const e = eventFixture("agent.acted", {
    id: crypto.randomUUID(),
    stream_id: `s:${shipmentId}`,
    shipment_id: shipmentId,
    seq,
    ts: o.ts ?? NOW,
    visibility: "internal",
    party_refs: [],
    payload,
  });
  const row = eventToRow(e);
  row.hash = hex64();
  const cols = Object.keys(row);
  await env.TENANT_A_DB.prepare(`INSERT INTO events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .bind(...cols.map((c) => row[c]))
    .run();
  await env.TENANT_A_DB.batch(projectAgentRuns(env.TENANT_A_DB, e));
}

async function seedShipmentState(id: string, state: string | null): Promise<void> {
  const status = state === null ? "{}" : JSON.stringify({ state });
  await env.TENANT_A_DB.prepare(
    "INSERT OR IGNORE INTO shipments (id, shipper_party_id, consignee_party_id, bill_to_party_id, created_ts, status_cache) VALUES (?,?,?,?,0,?)",
  )
    .bind(id, "party-shipper", "party-consignee", "party-bill-to", status)
    .run();
}

async function seedInvoice(id: string, issuedEventId: string, total: number, status: string): Promise<void> {
  await env.TENANT_A_DB.prepare(
    "INSERT OR IGNORE INTO invoices (id, party_id, division, shipment_ids, total_cents, status, issued_event_id, terms, due_ts) VALUES (?,?,?,?,?,?,?,?,?)",
  )
    .bind(id, "party-bill-to", "main", "[]", total, status, issuedEventId, "net30", 0)
    .run();
}

function pricedPayload(sell: number, full: number): JsonObject {
  return {
    sell,
    lines: [{ kind: "freight", code: "freight", amount_cents: sell }],
    floors: { contribution: Math.max(1, full - 1000), full, target: full + 1000 },
    versions: { rate_config_ids: ["rc-snap"] },
    basis: {},
  };
}

beforeAll(async () => {
  await ensureSchema(env);
});

// ─── METRIC 3 — POD→invoice latency: mean(invoice.issued.ts − pod.signed.ts) per shipment ─────────────
describe("REQ-160 metric — POD→invoice latency (honest ms or UNKNOWN)", () => {
  it("averages invoice.issued.ts − pod.signed.ts over shipments with BOTH (a 2h + a 4h → 3h)", async () => {
    await seedEvent("pod.signed", "snap-pi-1", 0, { ts: NOW });
    await seedEvent("invoice.issued", "snap-pi-1", 1, { ts: NOW + 2 * HOUR_MS });
    await seedEvent("pod.signed", "snap-pi-2", 0, { ts: NOW });
    await seedEvent("invoice.issued", "snap-pi-2", 1, { ts: NOW + 4 * HOUR_MS });
    // a POD with NO invoice → excluded from the mean (never fabricated)
    await seedEvent("pod.signed", "snap-pi-3", 0, { ts: NOW });
    expect(
      await computePodToInvoiceLatencyMs(env.TENANT_A_DB, { now: NOW + 5 * HOUR_MS, scope: "snap-pi-" }),
    ).toBe(3 * HOUR_MS);
  });

  it("HONESTY: no shipment has both a POD and an invoice → UNKNOWN", async () => {
    await seedEvent("pod.signed", "snap-pinone-1", 0, { ts: NOW });
    expect(await computePodToInvoiceLatencyMs(env.TENANT_A_DB, { now: NOW + HOUR_MS, scope: "snap-pinone-" })).toBe("UNKNOWN");
  });
});

// ─── METRIC 4 — rating latency: mean of the rater's agent.acted.latency_ms (agent_runs, T9) ───────────
describe("REQ-160 metric — rating latency (rater agent_runs, honest ms or UNKNOWN)", () => {
  it("averages the rater's reported latency_ms in the window (100 + 300 → 200); excludes non-rater + out-of-window", async () => {
    await seedAgentRun("snap-rl-1", 0, { latencyMs: 100, costCents: 0, ts: NOW });
    await seedAgentRun("snap-rl-2", 0, { latencyMs: 300, costCents: 0, ts: NOW });
    await seedAgentRun("snap-rl-3", 0, { latencyMs: 9_999, costCents: 0, agent: "concierge", ts: NOW }); // non-rater
    await seedAgentRun("snap-rl-4", 0, { latencyMs: 9_999, costCents: 0, ts: NOW - 10 * DAY_MS }); // out of 7d window
    expect(
      await computeRatingLatencyMs(env.TENANT_A_DB, { now: NOW, scope: "snap-rl-", windowMs: WEEK_MS }),
    ).toBe(200);
  });

  it("HONESTY: no rater run reported a latency in scope → UNKNOWN", async () => {
    expect(await computeRatingLatencyMs(env.TENANT_A_DB, { now: NOW, scope: "snap-rlnone-" })).toBe("UNKNOWN");
  });
});

// ─── METRIC 5 — disputes: open exceptions (WP-10 exceptions heuristic), count ─────────────────────────
describe("REQ-160 metric — disputes open (exception.raised/osd.captured on a non-terminal shipment)", () => {
  it("counts distinct shipments with an OPEN exception; a delivered/settled shipment's exception is excluded", async () => {
    await seedEvent("exception.raised", "snap-dsp-open1", 0, { ts: NOW }); // no shipments row → state unknown ⇒ open
    await seedEvent("osd.captured", "snap-dsp-open2", 0, { ts: NOW });
    await seedShipmentState("snap-dsp-open2", "in_transit"); // live ⇒ open
    await seedEvent("exception.raised", "snap-dsp-done", 0, { ts: NOW });
    await seedShipmentState("snap-dsp-done", "delivered"); // terminal ⇒ excluded
    expect(await computeDisputesOpen(env.TENANT_A_DB, { scope: "snap-dsp-" })).toBe(2);
  });

  it("HONESTY: no exceptions in scope → 0 (the healthy count, never fabricated)", async () => {
    expect(await computeDisputesOpen(env.TENANT_A_DB, { scope: "snap-dspnone-" })).toBe(0);
  });
});

// ─── METRIC 6 — close duration: booking.created → terminal (delivered/settled), mean ms ───────────────
describe("REQ-160 metric — close duration (booking.created → first terminal, honest ms or UNKNOWN)", () => {
  it("averages booking→terminal per shipment (a 1-day pod.signed close + a 3-day settlement close → 2 days)", async () => {
    await seedEvent("booking.created", "snap-cd-1", 0, { ts: NOW });
    await seedEvent("pod.signed", "snap-cd-1", 1, { ts: NOW + 1 * DAY_MS }); // delivered = terminal
    await seedEvent("booking.created", "snap-cd-2", 0, { ts: NOW });
    await seedEvent("settlement.executed", "snap-cd-2", 1, { ts: NOW + 3 * DAY_MS }); // settled = terminal
    await seedEvent("booking.created", "snap-cd-3", 0, { ts: NOW }); // no terminal → excluded
    expect(
      await computeCloseDurationMs(env.TENANT_A_DB, { now: NOW + 4 * DAY_MS, scope: "snap-cd-", windowMs: 10 * DAY_MS }),
    ).toBe(2 * DAY_MS);
  });

  it("HONESTY: no shipment has both a booking and a terminal → UNKNOWN", async () => {
    await seedEvent("booking.created", "snap-cdnone-1", 0, { ts: NOW });
    expect(await computeCloseDurationMs(env.TENANT_A_DB, { now: NOW + DAY_MS, scope: "snap-cdnone-" })).toBe("UNKNOWN");
  });
});

// ─── SHARED-COMPUTE PARITY — the KPI route's 3 computes ARE the shared @shuddl/ledger/queries/metrics fns ──
describe("REQ-160 — shared-compute parity: the KPI route re-exports the shared metric computes (no drift)", () => {
  it("computeUnbilled / computeDsoDays / computeCostRatioBps are the SAME function references (re-export, not a copy)", () => {
    // Identity is the strongest no-drift proof: the command KPI route and the weekly snapshot call the SAME fn.
    expect(computeUnbilled).toBe(sharedUnbilled);
    expect(computeDsoDays).toBe(sharedDso);
    expect(computeCostRatioBps).toBe(sharedOr);
  });

  it("and they compute identical values on the same seeded data (unbilled 2, DSO 20d, OR 9000bps)", async () => {
    const scope = "snap-par-";
    await seedEvent("pod.signed", `${scope}u1`, 0, { ts: NOW });
    await seedEvent("pod.signed", `${scope}u2`, 0, { ts: NOW });
    const eInv = await seedEvent("invoice.issued", `${scope}dso1`, 0, { ts: NOW - 20 * DAY_MS });
    await seedInvoice(`${scope}inv1`, eInv, 100_000, "issued");
    await seedEvent("quote.priced", `${scope}or1`, 0, { payload: pricedPayload(100_000, 90_000) });

    expect(await computeUnbilled(env.TENANT_A_DB, { scope })).toBe(await sharedUnbilled(env.TENANT_A_DB, { scope }));
    expect(await computeDsoDays(env.TENANT_A_DB, { now: NOW, scope })).toBe(await sharedDso(env.TENANT_A_DB, { now: NOW, scope }));
    expect(await computeCostRatioBps(env.TENANT_A_DB, { scope })).toBe(await sharedOr(env.TENANT_A_DB, { scope }));
    // and the real values
    expect(await computeUnbilled(env.TENANT_A_DB, { scope })).toBe(2);
    expect(await computeDsoDays(env.TENANT_A_DB, { now: NOW, scope })).toBe(20);
    expect(await computeCostRatioBps(env.TENANT_A_DB, { scope })).toBe(9000);
  });
});
