import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureSchema, seedFacility, token, TENANT_SLUG } from "./helpers.js";
import { eventFixture, type EventKind } from "@shuddl/contracts";
import { eventToRow } from "@shuddl/ledger/lens";
import {
  computeUnbilled,
  computeOtdBps,
  computeDwellMinutes,
  computeLanePnl,
  computeDsoDays,
  computeCostRatioBps,
} from "../src/kpis/compute.js";

// WP-10 Task 5 (REQ-083) — THE KPI STRIP, WITH AN ABSOLUTE HONESTY GUARDRAIL. Each of the 6 tiles is a REAL
// number computed from real ledger rows and DRILLABLE to its backing events, OR the literal "UNKNOWN" — NEVER
// a fabricated/placeholder number. These tests seed a CONTROLLED dataset (unique `kpi-…` id prefixes) and call
// the pure compute fns with a matching `scope` so the aggregate is deterministic on the shared test D1 (the
// isolatedStorage-off harness accumulates other files' rows). The route smoke/roles/deep-link tests run
// whole-tenant. The honesty guard: a scope with NO data → UNKNOWN (never 0-as-a-lie, never a 100% placeholder).

const DAY_MS = 86_400_000;

// ---- seeders (direct D1 inserts; bypass the sequencer — we prove the READ/COMPUTE path) --------------
let hashN = 0xc0000;
const nextHash = (): string => (hashN++).toString(16).padStart(64, "0");

async function seedEvent(
  kind: EventKind,
  o: { shipmentId: string; seq: number; ts?: number; payload?: Record<string, unknown> },
): Promise<string> {
  const overrides: Record<string, unknown> = {
    id: crypto.randomUUID(),
    stream_id: `s:${o.shipmentId}`,
    shipment_id: o.shipmentId,
    seq: o.seq,
    visibility: "internal",
    party_refs: [],
  };
  if (o.ts !== undefined) overrides.ts = o.ts;
  if (o.payload !== undefined) overrides.payload = o.payload;
  const e = eventFixture(kind, overrides);
  const row = eventToRow(e);
  row.hash = nextHash();
  const cols = Object.keys(row);
  await env.TENANT_A_DB.prepare(`INSERT INTO events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .bind(...cols.map((c) => row[c]))
    .run();
  return e.id;
}

async function seedLeg(o: {
  id: string;
  shipmentId: string;
  seq: number;
  kind: string;
  facilityId?: string | null;
  apptEnd?: number | null;
}): Promise<void> {
  // legs.shipment_id REFERENCES shipments(id) (FK enforced) — ensure the shipment row exists first.
  await env.TENANT_A_DB.prepare(
    "INSERT OR IGNORE INTO shipments (id, shipper_party_id, consignee_party_id, bill_to_party_id, created_ts) VALUES (?,?,?,?,0)",
  )
    .bind(o.shipmentId, "party-shipper", "party-consignee", "party-bill-to")
    .run();
  await env.TENANT_A_DB.prepare(
    "INSERT OR IGNORE INTO legs (id, shipment_id, seq, kind, executor_party_id, geo, facility_id, appt_window_end_ts) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(o.id, o.shipmentId, o.seq, o.kind, "party-carrier", "{}", o.facilityId ?? null, o.apptEnd ?? null)
    .run();
}

async function seedMoneyLine(o: {
  id: string;
  shipmentId: string;
  eventId: string;
  lineNo: number;
  direction: "ar" | "ap";
  kind: string;
  amount: number;
}): Promise<void> {
  await env.TENANT_A_DB.prepare(
    "INSERT OR IGNORE INTO money_lines (id, shipment_id, event_id, line_no, direction, kind, amount_cents, currency, party_id, division, gl_map, basis, created_ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(o.id, o.shipmentId, o.eventId, o.lineNo, o.direction, o.kind, o.amount, "USD", "party-bill-to", "main", "4000-REV", "{}", 0)
    .run();
}

async function seedInvoice(o: {
  id: string;
  issuedEventId: string;
  total: number;
  status: string;
}): Promise<void> {
  await env.TENANT_A_DB.prepare(
    "INSERT OR IGNORE INTO invoices (id, party_id, division, shipment_ids, total_cents, status, issued_event_id, terms, due_ts) VALUES (?,?,?,?,?,?,?,?,?)",
  )
    .bind(o.id, "party-bill-to", "main", "[]", o.total, o.status, o.issuedEventId, "net30", 0)
    .run();
}

// A valid quote.priced payload (penny-parity: single line == sell) with an explicit cost basis (floors.full).
function pricedPayload(sell: number, full: number): Record<string, unknown> {
  return {
    sell,
    lines: [{ kind: "freight", code: "freight", amount_cents: sell }],
    floors: { contribution: Math.max(1, full - 1000), full, target: full + 1000 },
    versions: { rate_config_ids: ["rc-kpi"] },
    basis: {},
  };
}

beforeAll(async () => {
  await ensureSchema(env);
});

// ─── 1. UNBILLED — the "=0 alarm": pod.signed WITHOUT invoice.issued (anti-join) ─────────────────────
describe("KPI unbilled — POD-without-invoice anti-join (REQ-083)", () => {
  it("counts shipments with a committed pod.signed but NO invoice.issued", async () => {
    // two unbilled (pod, no invoice) + one billed (pod + invoice) → expect 2.
    await seedEvent("pod.signed", { shipmentId: "kpi-unb-1", seq: 0 });
    await seedEvent("pod.signed", { shipmentId: "kpi-unb-2", seq: 0 });
    await seedEvent("pod.signed", { shipmentId: "kpi-unb-3", seq: 0 });
    await seedEvent("invoice.issued", { shipmentId: "kpi-unb-3", seq: 1 });
    expect(await computeUnbilled(env.TENANT_A_DB, { scope: "kpi-unb-" })).toBe(2);
  });

  it("HONESTY: no pod.signed in scope → 0 is the REAL anti-join result (the healthy alarm), not a fabrication", async () => {
    // Unbilled is the one tile whose 0 is a computed truth (0 unbilled shipments), never UNKNOWN.
    expect(await computeUnbilled(env.TENANT_A_DB, { scope: "kpi-nodata-unb-" })).toBe(0);
  });
});

// ─── 2. OTD — on-time delivery %, appt-window gated, exclude no-window (REQ-083) ──────────────────────
describe("KPI OTD — delivered-with-window fraction, bps (REQ-083)", () => {
  it("counts on-time (pod.ts ≤ appt_end) over delivered-with-window; excludes no-window shipments", async () => {
    // on-time: pod 1000 ≤ end 2000
    await seedEvent("pod.signed", { shipmentId: "kpi-otd-a", seq: 0, ts: 1000 });
    await seedLeg({ id: "leg-kpi-otd-a", shipmentId: "kpi-otd-a", seq: 0, kind: "delivery", apptEnd: 2000 });
    // late: pod 3000 > end 2000
    await seedEvent("pod.signed", { shipmentId: "kpi-otd-b", seq: 0, ts: 3000 });
    await seedLeg({ id: "leg-kpi-otd-b", shipmentId: "kpi-otd-b", seq: 0, kind: "delivery", apptEnd: 2000 });
    // delivered but NO window → EXCLUDED from denominator (never fabricated as on-time or late)
    await seedEvent("pod.signed", { shipmentId: "kpi-otd-c", seq: 0, ts: 5000 });
    await seedLeg({ id: "leg-kpi-otd-c", shipmentId: "kpi-otd-c", seq: 0, kind: "delivery", apptEnd: null });
    // 1 on-time of 2 delivered-with-window = 5000 bps (c excluded)
    expect(await computeOtdBps(env.TENANT_A_DB, { scope: "kpi-otd-" })).toBe(5000);
  });

  it("HONESTY: a delivered shipment with NO appointment window → UNKNOWN, never 100%", async () => {
    await seedEvent("pod.signed", { shipmentId: "kpi-otdnw-a", seq: 0, ts: 1000 });
    await seedLeg({ id: "leg-kpi-otdnw-a", shipmentId: "kpi-otdnw-a", seq: 0, kind: "delivery", apptEnd: null });
    expect(await computeOtdBps(env.TENANT_A_DB, { scope: "kpi-otdnw-" })).toBe("UNKNOWN");
  });

  it("HONESTY: no delivered-with-window at all → UNKNOWN", async () => {
    expect(await computeOtdBps(env.TENANT_A_DB, { scope: "kpi-nodata-otd-" })).toBe("UNKNOWN");
  });
});

// ─── 3. DWELL — mean (departed − arrived) over matched pairs, minutes (REQ-083) ───────────────────────
describe("KPI dwell — mean matched arrive/depart, minutes (REQ-083)", () => {
  it("averages matched pairs; a 2h + a 3h pair → 150 minutes", async () => {
    const t = 1_000_000_000_000;
    await seedEvent("stop.arrived", { shipmentId: "kpi-dwell-1", seq: 0, ts: t });
    await seedEvent("stop.departed", { shipmentId: "kpi-dwell-1", seq: 1, ts: t + 2 * 3_600_000 });
    await seedEvent("stop.arrived", { shipmentId: "kpi-dwell-2", seq: 0, ts: t });
    await seedEvent("stop.departed", { shipmentId: "kpi-dwell-2", seq: 1, ts: t + 3 * 3_600_000 });
    expect(await computeDwellMinutes(env.TENANT_A_DB, { scope: "kpi-dwell-" })).toBe(150);
  });

  it("HONESTY: an arrival with no matching departure → no pair → UNKNOWN", async () => {
    await seedEvent("stop.arrived", { shipmentId: "kpi-dwellnp-1", seq: 0, ts: 1000 });
    expect(await computeDwellMinutes(env.TENANT_A_DB, { scope: "kpi-dwellnp-" })).toBe("UNKNOWN");
  });
});

// ─── 4. LANE P&L — AR−AP grouped by lane (origin→dest facility); undrivable = UNKNOWN entry ───────────
describe("KPI lane P&L — AR−AP by derived lane, cents (REQ-083)", () => {
  it("groups a derivable lane by facility key; an un-derivable lane is an UNKNOWN entry, not fabricated", async () => {
    await seedFacility(env.TENANT_A_DB, {
      id: "kpi-lane-fac-o",
      kind: "terminal",
      lat_e6: 45_000_000,
      lon_e6: -122_000_000,
      hours: { tz: "America/Los_Angeles", weekly: {} },
      capacity_slots: [],
    });
    await seedFacility(env.TENANT_A_DB, {
      id: "kpi-lane-fac-d",
      kind: "terminal",
      lat_e6: 40_000_000,
      lon_e6: -105_000_000,
      hours: { tz: "America/Los_Angeles", weekly: {} },
      capacity_slots: [],
    });
    // L1: AR 100000, AP 30000, pickup→delivery facilities present → lane "o->d", pnl 70000
    const e1 = await seedEvent("invoice.issued", { shipmentId: "kpi-lane-1", seq: 0 });
    await seedMoneyLine({ id: "ml-kpi-lane-1a", shipmentId: "kpi-lane-1", eventId: e1, lineNo: 1, direction: "ar", kind: "freight", amount: 100_000 });
    await seedMoneyLine({ id: "ml-kpi-lane-1b", shipmentId: "kpi-lane-1", eventId: e1, lineNo: 2, direction: "ap", kind: "interline_split", amount: 30_000 });
    await seedLeg({ id: "leg-kpi-lane-1p", shipmentId: "kpi-lane-1", seq: 0, kind: "pickup", facilityId: "kpi-lane-fac-o" });
    await seedLeg({ id: "leg-kpi-lane-1d", shipmentId: "kpi-lane-1", seq: 1, kind: "delivery", facilityId: "kpi-lane-fac-d" });
    // L2: AR 50000, no facility on legs → UNKNOWN lane, pnl 50000
    const e2 = await seedEvent("invoice.issued", { shipmentId: "kpi-lane-2", seq: 0 });
    await seedMoneyLine({ id: "ml-kpi-lane-2a", shipmentId: "kpi-lane-2", eventId: e2, lineNo: 1, direction: "ar", kind: "freight", amount: 50_000 });
    await seedLeg({ id: "leg-kpi-lane-2p", shipmentId: "kpi-lane-2", seq: 0, kind: "pickup", facilityId: null });

    const r = await computeLanePnl(env.TENANT_A_DB, { scope: "kpi-lane-" });
    expect(r.value).toBe(120_000); // total AR−AP across all money in scope
    const real = r.lanes.find((l) => l.lane === "kpi-lane-fac-o->kpi-lane-fac-d");
    expect(real).toEqual({ lane: "kpi-lane-fac-o->kpi-lane-fac-d", ar_cents: 100_000, ap_cents: 30_000, pnl_cents: 70_000 });
    const unknown = r.lanes.find((l) => l.lane === "UNKNOWN");
    expect(unknown?.pnl_cents).toBe(50_000); // real money, honestly labeled UNKNOWN (never a fabricated lane)
  });

  it("HONESTY: no money_lines in scope → value UNKNOWN, lanes empty", async () => {
    const r = await computeLanePnl(env.TENANT_A_DB, { scope: "kpi-nodata-lane-" });
    expect(r.value).toBe("UNKNOWN");
    expect(r.lanes).toEqual([]);
  });
});

// ─── 5. DSO — dollar-weighted average age of OPEN AR, days (REQ-083) ──────────────────────────────────
describe("KPI DSO — average age of open AR, days (REQ-083)", () => {
  it("dollar-weights open (issued) invoice ages; paid invoices drop out", async () => {
    const NOW = 1_800_000_000_000;
    const eA = await seedEvent("invoice.issued", { shipmentId: "kpi-dso-a", seq: 0, ts: NOW - 10 * DAY_MS });
    await seedInvoice({ id: "kpi-dso-inv-a", issuedEventId: eA, total: 100_000, status: "issued" });
    const eB = await seedEvent("invoice.issued", { shipmentId: "kpi-dso-b", seq: 0, ts: NOW - 30 * DAY_MS });
    await seedInvoice({ id: "kpi-dso-inv-b", issuedEventId: eB, total: 300_000, status: "issued" });
    // a PAID invoice must be excluded (settled → out of open AR)
    const eP = await seedEvent("invoice.issued", { shipmentId: "kpi-dso-p", seq: 0, ts: NOW - 100 * DAY_MS });
    await seedInvoice({ id: "kpi-dso-inv-p", issuedEventId: eP, total: 999_999, status: "paid" });
    // (100000*10 + 300000*30) / 400000 = 25 days
    expect(await computeDsoDays(env.TENANT_A_DB, { now: NOW, scope: "kpi-dso-inv-" })).toBe(25);
  });

  it("HONESTY: only paid invoices in scope → no open AR → UNKNOWN (never 0)", async () => {
    const eP = await seedEvent("invoice.issued", { shipmentId: "kpi-dsopaid-p", seq: 0, ts: 1000 });
    await seedInvoice({ id: "kpi-dsopaid-inv-p", issuedEventId: eP, total: 100_000, status: "paid" });
    expect(await computeDsoDays(env.TENANT_A_DB, { now: 2_000_000_000_000, scope: "kpi-dsopaid-inv-" })).toBe("UNKNOWN");
  });
});

// ─── 6. OR — HONEST cost/revenue ratio from the quoted cost basis (NOT a true operating ratio) ────────
describe("KPI cost_ratio (OR) — quoted floors.full vs sell, bps (REQ-083)", () => {
  it("aggregates floors.full / sell across priced quotes", async () => {
    await seedEvent("quote.priced", { shipmentId: "kpi-or-1", seq: 0, payload: pricedPayload(100_000, 92_000) });
    await seedEvent("quote.priced", { shipmentId: "kpi-or-2", seq: 0, payload: pricedPayload(200_000, 180_000) });
    // (92000 + 180000) / (100000 + 200000) = 272000/300000 = 0.90666… → 9067 bps
    expect(await computeCostRatioBps(env.TENANT_A_DB, { scope: "kpi-or-" })).toBe(9067);
  });

  it("dedups requotes: only the latest quote.priced per stream counts", async () => {
    await seedEvent("quote.priced", { shipmentId: "kpi-orr-1", seq: 0, payload: pricedPayload(100_000, 90_000) });
    await seedEvent("quote.priced", { shipmentId: "kpi-orr-1", seq: 1, payload: pricedPayload(100_000, 50_000) });
    // only seq 1 (full 50000) counts → 50000/100000 = 5000 bps
    expect(await computeCostRatioBps(env.TENANT_A_DB, { scope: "kpi-orr-" })).toBe(5000);
  });

  it("HONESTY: no quoted cost basis in scope → UNKNOWN", async () => {
    expect(await computeCostRatioBps(env.TENANT_A_DB, { scope: "kpi-nodata-or-" })).toBe("UNKNOWN");
  });
});

// ─── ROUTE — GET /v1/kpis: roles, shape, and the backing deep-link click-through ─────────────────────
type Tile = { key: string; label: string; value: number | "UNKNOWN"; unit: string; backing: { kinds: EventKind[] } };
async function getKpis(tok: string): Promise<{ status: number; kpis: Tile[] }> {
  const res = await SELF.fetch("https://api.local/v1/kpis", { headers: { Authorization: `Bearer ${tok}` } });
  const body = (await res.json().catch(() => ({}))) as { kpis?: Tile[] };
  return { status: res.status, kpis: body.kpis ?? [] };
}

describe("GET /v1/kpis — the 6-tile strip (REQ-083)", () => {
  it("returns 6 honest tiles for a tenant-lens role; each value is a number or the literal UNKNOWN", async () => {
    const ops = await token({ sub: "kpi-ops", tenant: TENANT_SLUG, role: "ops" });
    const r = await getKpis(ops);
    expect(r.status).toBe(200);
    const keys = r.kpis.map((t) => t.key).sort();
    expect(keys).toEqual(["dso", "dwell", "lane_pnl", "or", "otd", "unbilled"]);
    for (const t of r.kpis) {
      expect(t.value === "UNKNOWN" || typeof t.value === "number").toBe(true);
      expect(Array.isArray(t.backing.kinds)).toBe(true);
      expect(t.backing.kinds.length).toBeGreaterThan(0);
      expect(typeof t.label).toBe("string");
      expect(typeof t.unit).toBe("string");
    }
  });

  it("labels the OR tile HONESTLY (a cost/revenue ratio, NOT a bare Operating Ratio)", async () => {
    const ops = await token({ sub: "kpi-ops2", tenant: TENANT_SLUG, role: "ops" });
    const r = await getKpis(ops);
    const or = r.kpis.find((t) => t.key === "or");
    expect(or).toBeDefined();
    expect(or?.label.toLowerCase()).not.toBe("operating ratio");
    expect(or?.label.toLowerCase()).toContain("cost"); // e.g. "Cost/Rev (quoted basis)"
  });

  it("read role sees it (200); driver and portal do not (403)", async () => {
    const read = await token({ sub: "kpi-read", tenant: TENANT_SLUG, role: "read" });
    const driver = await token({ sub: "kpi-driver", tenant: TENANT_SLUG, role: "driver" });
    const portal = await token({ sub: "kpi-portal", tenant: TENANT_SLUG, role: "portal", party_id: "party-bill-to" });
    expect((await getKpis(read)).status).toBe(200);
    expect((await getKpis(driver)).status).toBe(403);
    expect((await getKpis(portal)).status).toBe(403);
  });

  it("BACKING deep-link: the unbilled tile's backing kinds, fed to GET /v1/events?kind=, return the backing events", async () => {
    const ops = await token({ sub: "kpi-link", tenant: TENANT_SLUG, role: "ops" });
    const podId = await seedEvent("pod.signed", { shipmentId: "kpi-link-1", seq: 0 });
    const r = await getKpis(ops);
    const tile = r.kpis.find((t) => t.key === "unbilled");
    expect(tile).toBeDefined();
    const kinds = (tile as Tile).backing.kinds.join(",");
    expect(kinds).toContain("pod.signed");
    // click-through: the SAME Task-1 kind filter behind the UI deep-link surfaces the backing event.
    const res = await SELF.fetch(`https://api.local/v1/events?kind=${kinds}&limit=1000`, {
      headers: { Authorization: `Bearer ${ops}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ id: string; kind: string }> };
    expect(body.events.every((e) => (tile as Tile).backing.kinds.includes(e.kind as EventKind))).toBe(true);
    expect(body.events.some((e) => e.id === podId)).toBe(true); // the drilled-to backing event is really there
  });
});
