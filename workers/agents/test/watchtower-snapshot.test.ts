import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { EventKind, JsonObject, LedgerEvent } from "@shuddl/contracts";
import { projectAgentRuns } from "@shuddl/ledger/projection/agent-runs";
import { computeUnbilled, computeDsoDays, computeCostRatioBps } from "@shuddl/ledger/queries/metrics";
import {
  computeWatchtowerSnapshot,
  persistWatchtowerSnapshot,
  snapshotKey,
  isoWeek,
  isSnapshotDay,
  SNAPSHOT_DOW,
  WATCHTOWER_SNAPSHOT_VERSION,
  type WatchtowerSnapshot,
} from "../src/watchtower-snapshot.js";
import { applyAll, resetCounter, seedEvent } from "./helpers.js";

// WP-11 Task 10 (REQ-160) — the Watchtower snapshot MODULE (pure compute + manifest + R2 persist + ISO-week +
// day-of-week gate), driven in the AGENTS harness where the module is native (imported by index.ts → no worker
// reload). isolatedStorage is ON here (per-test rollback), so each test starts with an EMPTY, migrated tenant D1
// and the snapshot reads WHOLE-TENANT (the production path, no scope). The tenant fan-out + scheduled() wiring is
// pinned in watchtower-snapshot-cron.test.ts; this file pins the compute/manifest/key/gate + shared-compute parity.
//
// HONESTY (WP-10/11): every metric is a REAL number or the literal UNKNOWN — never fabricated.

const DAY_MS = 86_400_000;
const A = env.TENANT_A_DB;
// A Monday (UTC) = SNAPSHOT_DOW; used as the snapshot instant so the ISO week + gate are deterministic.
const NOW = Date.parse("2026-07-20T00:00:00Z");

// Direct-insert an event via the harness seeder (the 0001–0004 column subset — this agents tenant D1 has no
// 0005 override column). Returns the event so a projection can consume it.
async function seedEvt(
  kind: EventKind,
  shipmentId: string,
  seq: number,
  o: { ts?: number; payload?: JsonObject } = {},
): Promise<LedgerEvent> {
  const over: Partial<LedgerEvent> = {
    stream_id: `s:${shipmentId}`,
    shipment_id: shipmentId,
    seq,
    ts: o.ts ?? NOW,
    visibility: "internal",
    party_refs: [],
    ...(o.payload !== undefined ? { payload: o.payload } : {}),
  };
  return seedEvent(A, kind, over);
}

async function seedRaterRun(shipmentId: string, seq: number, latencyMs: number, ts = NOW): Promise<void> {
  const payload: JsonObject = {
    agent: "rater",
    action: "priced",
    basis: [{ kind: "config", id: "rc-x" }],
    confidence_bps: 10_000,
    cost_cents: 0,
    latency_ms: latencyMs,
  };
  const e = await seedEvt("agent.acted", shipmentId, seq, { ts, payload });
  await A.batch(projectAgentRuns(A, e));
}

async function seedInvoice(id: string, issuedEventId: string, total: number, status: string): Promise<void> {
  await A.prepare(
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
  resetCounter();
  await applyAll(A);
});

// ─── ISO-week + key + gate (pure) ──────────────────────────────────────────────────────────────────────
describe("REQ-160 — ISO-week / tenant-scoped key / weekly gate (pure)", () => {
  it("derives the ISO-8601 week-of-year (YYYY-Www)", () => {
    expect(isoWeek(Date.parse("2026-07-20T00:00:00Z"))).toBe("2026-W30"); // Mon of W30
    expect(isoWeek(Date.parse("2026-07-19T23:59:59Z"))).toBe("2026-W29"); // Sun of W29
    expect(isoWeek(Date.parse("2026-01-01T00:00:00Z"))).toBe("2026-W01"); // Thu — ISO week 1
  });

  it("snapshotKey is tenant-scoped and never crosses tenants (REQ-025)", () => {
    const wk = isoWeek(NOW);
    expect(snapshotKey("tenant-a", wk)).toBe(`watchtower/tenant-a/${wk}.json`);
    expect(snapshotKey("tenant-b", wk)).not.toBe(snapshotKey("tenant-a", wk));
    expect(snapshotKey("tenant-a", wk).startsWith("watchtower/tenant-a/")).toBe(true);
  });

  it("isSnapshotDay is true ONLY on SNAPSHOT_DOW (Monday), false on the other six days", () => {
    const monday = Date.parse("2026-07-20T09:00:00Z");
    expect(new Date(monday).getUTCDay()).toBe(SNAPSHOT_DOW);
    expect(isSnapshotDay(monday)).toBe(true);
    for (let d = 1; d <= 6; d++) expect(isSnapshotDay(monday + d * DAY_MS)).toBe(false);
  });
});

// ─── the manifest — all 7 metrics, honest ──────────────────────────────────────────────────────────────
describe("REQ-160 — the weekly snapshot manifest (all 7 metrics, real or UNKNOWN)", () => {
  it("computes all 7 into a manifest (real where data exists, honest UNKNOWN otherwise)", async () => {
    await seedEvt("pod.signed", "mf-u1", 0, { ts: NOW }); // unbilled 1
    await seedRaterRun("mf-rl1", 0, 250); // rating latency 250
    await seedEvt("exception.raised", "mf-d1", 0, { ts: NOW }); // disputes 1

    const snap = await computeWatchtowerSnapshot(A, "tenant-a", { now: NOW });
    expect(snap.version).toBe(WATCHTOWER_SNAPSHOT_VERSION);
    expect(snap.tenant).toBe("tenant-a");
    expect(snap.iso_week).toBe(isoWeek(NOW));
    expect(snap.metrics.unbilled).toBe(1);
    expect(snap.metrics.rating_latency_ms).toBe(250);
    expect(snap.metrics.disputes_open).toBe(1);
    // no open AR / no priced quote / no POD→invoice pair / no close → honest UNKNOWN
    expect(snap.metrics.dso_days).toBe("UNKNOWN");
    expect(snap.metrics.or_bps).toBe("UNKNOWN");
    expect(snap.metrics.pod_to_invoice_latency_ms).toBe("UNKNOWN");
    expect(snap.metrics.close_duration_ms).toBe("UNKNOWN");
    // every metric is a number or the literal UNKNOWN — never null/NaN/undefined (the honesty law)
    for (const v of Object.values(snap.metrics)) {
      expect(v === "UNKNOWN" || (typeof v === "number" && Number.isFinite(v))).toBe(true);
    }
  });
});

// ─── R2 persistence — tenant-scoped, idempotent per week ────────────────────────────────────────────────
describe("REQ-160 — R2 persistence (tenant-scoped key, write-once per ISO week)", () => {
  it("persists a TENANT-SCOPED manifest at watchtower/<tenant>/<iso-week>.json (REQ-025), readable back", async () => {
    const r = await persistWatchtowerSnapshot(env.EVIDENCE, A, "tenant-a", { now: NOW });
    expect(r.outcome).toBe("written");
    expect(r.key).toBe(`watchtower/tenant-a/${isoWeek(NOW)}.json`);
    const obj = await env.EVIDENCE.get(r.key);
    expect(obj).not.toBeNull();
    const manifest = JSON.parse(await obj!.text()) as WatchtowerSnapshot;
    expect(manifest.tenant).toBe("tenant-a");
    expect(Object.keys(manifest.metrics).sort()).toEqual(
      ["close_duration_ms", "disputes_open", "dso_days", "or_bps", "pod_to_invoice_latency_ms", "rating_latency_ms", "unbilled"].sort(),
    );
  });

  it("IDEMPOTENT — a second persist for the SAME ISO week SKIPS (write-once; never re-clobbers)", async () => {
    const first = await persistWatchtowerSnapshot(env.EVIDENCE, A, "tenant-a", { now: NOW });
    expect(first.outcome).toBe("written");
    const body1 = await (await env.EVIDENCE.get(first.key))!.text();
    const second = await persistWatchtowerSnapshot(env.EVIDENCE, A, "tenant-a", { now: NOW + 2 * 3_600_000 });
    expect(second.outcome).toBe("skipped");
    expect(second.key).toBe(first.key);
    const body2 = await (await env.EVIDENCE.get(first.key))!.text();
    expect(body2).toBe(body1); // untouched
  });

  it("TENANT ISOLATION — tenant-a and tenant-b write to DISTINCT keys (never cross)", async () => {
    const a = await persistWatchtowerSnapshot(env.EVIDENCE, A, "tenant-a", { now: NOW });
    const b = await persistWatchtowerSnapshot(env.EVIDENCE, A, "tenant-b", { now: NOW }); // same db, different tenant label
    expect(a.key).not.toBe(b.key);
    expect(a.key.startsWith("watchtower/tenant-a/")).toBe(true);
    expect(b.key.startsWith("watchtower/tenant-b/")).toBe(true);
  });
});

// ─── shared-compute parity — the snapshot's unbilled/DSO/OR agree with the shared computes ─────────────
describe("REQ-160 — shared-compute parity: the snapshot uses the SAME computes the KPI route re-exports", () => {
  it("unbilled / dso_days / or_bps equal the @shuddl/ledger/queries/metrics computes (no drift)", async () => {
    await seedEvt("pod.signed", "par-u1", 0, { ts: NOW });
    await seedEvt("pod.signed", "par-u2", 0, { ts: NOW });
    const eInv = await seedEvt("invoice.issued", "par-dso1", 0, { ts: NOW - 20 * DAY_MS });
    await seedInvoice("par-inv1", eInv.id, 100_000, "issued");
    await seedEvt("quote.priced", "par-or1", 0, { payload: pricedPayload(100_000, 90_000) });

    const snap = await computeWatchtowerSnapshot(A, "tenant-a", { now: NOW });
    expect(snap.metrics.unbilled).toBe(await computeUnbilled(A));
    expect(snap.metrics.dso_days).toBe(await computeDsoDays(A, { now: NOW }));
    expect(snap.metrics.or_bps).toBe(await computeCostRatioBps(A));
    // and the real values
    expect(snap.metrics.unbilled).toBe(2);
    expect(snap.metrics.dso_days).toBe(20);
    expect(snap.metrics.or_bps).toBe(9000);
  });
});
