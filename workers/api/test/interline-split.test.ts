import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { AppendedEvent } from "../src/do/sequencer.js";
import type { Leg } from "@shuddl/rater";
import {
  decideSplit,
  handleInterlineSplit,
  splitEventIdFor,
  type InterlineSplitDeps,
} from "../../agents/src/interline-split.js";
import type { PodSignedMessage, SeqStubLike } from "../../agents/src/biller.js";
import { TENANT_SLUG, ensureSchema } from "./helpers.js";

// ─── WP-11 — THE INTERLINE-SPLIT PRODUCER (REQ-019 / REQ-040 / REQ-003) ─────────────────────────────
//
// The interline AP split is COMPUTED FROM THE CUSTODY LEGS (never a client allocation): a committed
// pod.signed → the recorded legs → deriveSplitFromLegs → a `split.computed` appended THROUGH the real
// sequencer DO, which projects the penny-exact interline_split AP money_lines. The tenant's EXECUTING
// SHARE (never the gross) is judged against the recorded floors — the permanent $222,084/35-lb guard.
//
// VENUE (mirrors biller.test.ts): the ShipmentSequencer + migrated D1 live only in this harness, so the
// producer FUNCTION is imported from the agents worker and driven against the real DO + D1. Every case
// scopes to its OWN shipment/stream (isolatedStorage OFF).

const TENANT = TENANT_SLUG;
const HEX64 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const GEO = { lat_e6: 37_421_000, lon_e6: -122_084_000 };

const seqStub: SeqStubLike = {
  append: (req) =>
    (env.SHIPMENT_SEQ.get(env.SHIPMENT_SEQ.idFromName(`${req.tenant}|${req.streamId}`)) as unknown as SeqStubLike).append(req),
};
const deps: InterlineSplitDeps = { db: env.TENANT_A_DB, seq: seqStub };
function msgFor(shipmentId: string, podEventId: string): PodSignedMessage {
  return { kind: "pod.signed", tenant: TENANT, shipment_id: shipmentId, event_id: podEventId };
}

// A valid EventInput appended straight through the DO (no driver-core needed — the producer only reads
// the committed rows). pod.signed rides unwitnessed:true so I4 is satisfied without a device co-sign.
type SeqStub = { append(req: { tenant: string; streamId: string; input: unknown }): Promise<AppendedEvent> };
function stubFor(streamId: string): SeqStub {
  return env.SHIPMENT_SEQ.get(env.SHIPMENT_SEQ.idFromName(`${TENANT}|${streamId}`)) as unknown as SeqStub;
}
async function append(streamId: string, over: Record<string, unknown>): Promise<AppendedEvent> {
  const input = {
    id: crypto.randomUUID(),
    shipment_id: streamId.slice(2),
    ts: 1_720_000_000_000,
    actor: { party: "carrier-a" },
    party_refs: [],
    evidence: [],
    source: "native",
    confidence: 10_000,
    ...over,
  };
  return stubFor(streamId).append({ tenant: TENANT, streamId, input });
}

// Seed the shipment + its interline legs (the SERVER-SOURCED custody record — never a client fact). The
// executing carriers are seeded as parties first: pod.signed accrues a delivery passport counter whose
// FK is passports.party_id → parties(id), so the POD signer's party MUST exist before the append.
async function seedShipmentRow(id: string): Promise<void> {
  for (const carrier of ["carrier-a", "carrier-b", "carrier-c"]) {
    await env.TENANT_A_DB.prepare("INSERT OR IGNORE INTO parties (id, kind, names, contacts) VALUES (?,?,?,?)").bind(carrier, "carrier", "{}", "[]").run();
  }
  await env.TENANT_A_DB.prepare(
    "INSERT OR IGNORE INTO shipments (id, division, shipper_party_id, consignee_party_id, bill_to_party_id, created_ts) VALUES (?,?,?,?,?,0)",
  )
    .bind(id, "north", "party-shipper", "party-consignee", "party-bill-to")
    .run();
}
async function seedLeg(shipmentId: string, seq: number, kind: string, executor: string, splitBps: number | null): Promise<void> {
  await env.TENANT_A_DB.prepare(
    "INSERT OR IGNORE INTO legs (id, shipment_id, seq, kind, executor_party_id, split_bps, geo) VALUES (?,?,?,?,?,?,'{}')",
  )
    .bind(`leg-${shipmentId}-${seq}`, shipmentId, seq, kind, executor, splitBps)
    .run();
}

function quotePayload(sell: number, floors: { contribution: number; full: number; target: number }, basis: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sell,
    lines: [{ kind: "freight", code: "LINE", amount_cents: sell }],
    floors,
    versions: { rate_config_ids: ["rc-1"] },
    basis,
  };
}

async function interlineMoneyLines(shipmentId: string): Promise<{ party_id: string; amount_cents: number; kind: string; direction: string; gl_map: string }[]> {
  const res = await env.TENANT_A_DB.prepare(
    "SELECT party_id, amount_cents, kind, direction, gl_map FROM money_lines WHERE shipment_id = ? AND kind = 'interline_split' ORDER BY line_no",
  )
    .bind(shipmentId)
    .all<{ party_id: string; amount_cents: number; kind: string; direction: string; gl_map: string }>();
  return res.results;
}

// Drive a shipment to a committed quote.priced + pod.signed. Returns the pod event id (the trigger).
async function driveToPod(shipmentId: string, sell: number, floors: { contribution: number; full: number; target: number }, basis: Record<string, unknown> = {}): Promise<string> {
  const streamId = `s:${shipmentId}`;
  await append(streamId, { kind: "quote.priced", payload: quotePayload(sell, floors, basis) });
  const pod = await append(streamId, { kind: "pod.signed", actor: { party: "carrier-a" }, payload: { signature_hash: HEX64, geo: GEO, unwitnessed: true } });
  return pod.id;
}

beforeAll(async () => {
  await ensureSchema(env);
});

// ── the PURE decision core (mirrors composeInvoice; no DO needed) ──────────────────────────────────────
describe("decideSplit — the pure decision (REQ-019/040)", () => {
  const podRef = { event_id: "pod-1", shipment_id: "shp-1" };
  const legs: Leg[] = [
    { kind: "interline", executor: "carrier-a", split_bps: 3000 },
    { kind: "linehaul", executor: "carrier-b", split_bps: 7000 },
  ];

  it("APPENDS a split derived from the legs when the executing share clears the floor", () => {
    // Tenant carrier-a executes 3000 bps of a 1,000,000¢ gross = 300,000¢ ≥ target 250,000 → clears.
    const d = decideSplit({ pod: podRef, grossSellCents: 1_000_000, floors: { contribution: 200_000, full: 300_000, target: 250_000 }, anomaly: undefined, legs, tenantParty: "carrier-a" });
    expect(d.status).toBe("append");
    if (d.status !== "append") return;
    expect(d.payload.total_cents).toBe(1_000_000);
    expect(d.payload.allocations).toEqual([
      { party_id: "carrier-a", share_bps: 3000 },
      { party_id: "carrier-b", share_bps: 7000 },
    ]);
    expect(d.payload.allocations.reduce((s, a) => s + a.share_bps, 0)).toBe(10_000);
  });

  it("HOLDS below-floor on the EXECUTING SHARE, never the gross ($222K guard, REQ-040)", () => {
    // Gross 1,000,000¢ is far ABOVE target 250,000 — a GROSS comparison would clear. But carrier-a's
    // executing share is only 30 bps = 3,000¢, BELOW contribution 200,000 → a loss → DUAL hold.
    const thinLegs: Leg[] = [
      { kind: "interline", executor: "carrier-a", split_bps: 30 },
      { kind: "linehaul", executor: "carrier-b", split_bps: 9970 },
    ];
    const d = decideSplit({ pod: podRef, grossSellCents: 1_000_000, floors: { contribution: 200_000, full: 300_000, target: 250_000 }, anomaly: undefined, legs: thinLegs, tenantParty: "carrier-a" });
    expect(d.status).toBe("hold");
    if (d.status !== "hold") return;
    expect(d.reason).toBe("below_floor");
    // Prove the gross would have cleared — so the hold can ONLY come from judging the share, not the gross.
    expect(1_000_000).toBeGreaterThanOrEqual(250_000);
  });

  it("HOLDS on a recorded pricing anomaly (hard, REQ-040 permanent)", () => {
    const d = decideSplit({ pod: podRef, grossSellCents: 1_000_000, floors: { contribution: 200_000, full: 300_000, target: 250_000 }, anomaly: { code: "over_per_lb" }, legs, tenantParty: "carrier-a" });
    expect(d.status).toBe("hold");
    if (d.status !== "hold") return;
    expect(d.reason).toBe("anomaly");
  });

  it("throws on a malformed interline (leg split_bps not totalling 10000 — the anti-$222K guard)", () => {
    const bad: Leg[] = [{ kind: "interline", executor: "carrier-a", split_bps: 3000 }, { kind: "linehaul", executor: "carrier-b", split_bps: 3000 }];
    expect(() => decideSplit({ pod: podRef, grossSellCents: 1_000_000, floors: { contribution: 1, full: 2, target: 3 }, anomaly: undefined, legs: bad, tenantParty: "carrier-a" })).toThrow();
  });
});

// ── the CONSUMER against the real DO + D1 ──────────────────────────────────────────────────────────────
describe("handleInterlineSplit — derived split appended through the sequencer (REQ-019/003)", () => {
  it("interline pod.signed → split.computed appended; interline_split AP lines reconcile to the gross", async () => {
    const shp = `isplit-clean-${crypto.randomUUID().slice(0, 8)}`;
    await seedShipmentRow(shp);
    await seedLeg(shp, 0, "interline", "carrier-a", 3000);
    await seedLeg(shp, 1, "linehaul", "carrier-b", 7000);
    // Odd gross forces the Hamilton penny; floors low so the share clears.
    const podId = await driveToPod(shp, 999_999, { contribution: 1_000, full: 2_000, target: 1_500 });

    const outcome = await handleInterlineSplit(msgFor(shp, podId), deps);
    expect(outcome.status, JSON.stringify(outcome)).toBe("appended");

    // The split event committed at the DETERMINISTIC id, and its AP lines reconcile to the gross to the penny.
    const splitId = await splitEventIdFor(podId);
    if (outcome.status === "appended") expect(outcome.split_event_id).toBe(splitId);
    const lines = await interlineMoneyLines(shp);
    expect(lines.map((l) => ({ p: l.party_id, a: l.amount_cents }))).toEqual([
      { p: "carrier-a", a: 300_000 }, // 3000 bps of 999,999 → floor 299,999 + the leftover penny (largest remainder 7000)
      { p: "carrier-b", a: 699_999 }, // 7000 bps → floor 699,999 (remainder 3000, loses the tie-break)
    ]);
    expect(lines.every((l) => l.direction === "ap" && l.gl_map === "5000-INTERLINE-AP")).toBe(true);
    expect(lines.reduce((s, l) => s + l.amount_cents, 0)).toBe(999_999);
  });

  it("is idempotent under redelivery — the second run appends no second split, no second money_lines", async () => {
    const shp = `isplit-idem-${crypto.randomUUID().slice(0, 8)}`;
    await seedShipmentRow(shp);
    await seedLeg(shp, 0, "interline", "carrier-a", 4000);
    await seedLeg(shp, 1, "linehaul", "carrier-b", 6000);
    const podId = await driveToPod(shp, 500_000, { contribution: 1_000, full: 2_000, target: 1_500 });

    const first = await handleInterlineSplit(msgFor(shp, podId), deps);
    expect(first.status).toBe("appended");
    const after1 = await interlineMoneyLines(shp);
    const second = await handleInterlineSplit(msgFor(shp, podId), deps);
    expect(second.status).toBe("skipped");
    if (second.status === "skipped") expect(second.reason).toBe("already_split");
    const after2 = await interlineMoneyLines(shp);
    expect(after2).toEqual(after1); // byte-identical — no second projection
  });

  it("a single-carrier DIRECT move produces no split (fail-closed classification)", async () => {
    const shp = `isplit-direct-${crypto.randomUUID().slice(0, 8)}`;
    await seedShipmentRow(shp);
    await seedLeg(shp, 0, "delivery", "carrier-a", null); // one executor, no split anywhere
    const podId = await driveToPod(shp, 500_000, { contribution: 1_000, full: 2_000, target: 1_500 });

    const outcome = await handleInterlineSplit(msgFor(shp, podId), deps);
    expect(outcome.status).toBe("skipped");
    if (outcome.status === "skipped") expect(outcome.reason).toBe("direct");
    expect(await interlineMoneyLines(shp)).toEqual([]);
  });

  it("a below-floor executing share HOLDS — nothing appended, no interline_split lines (REQ-040)", async () => {
    const shp = `isplit-floor-${crypto.randomUUID().slice(0, 8)}`;
    await seedShipmentRow(shp);
    await seedLeg(shp, 0, "interline", "carrier-a", 30);
    await seedLeg(shp, 1, "linehaul", "carrier-b", 9970);
    // Gross 1,000,000 clears target 250,000 as a WHOLE, but carrier-a's 30-bps share = 3,000¢ is a loss.
    const podId = await driveToPod(shp, 1_000_000, { contribution: 200_000, full: 300_000, target: 250_000 });

    const outcome = await handleInterlineSplit(msgFor(shp, podId), deps);
    expect(outcome.status).toBe("held");
    if (outcome.status === "held") expect(outcome.reason).toBe("below_floor");
    expect(await interlineMoneyLines(shp)).toEqual([]); // the below-floor share never posts AP
  });
});
