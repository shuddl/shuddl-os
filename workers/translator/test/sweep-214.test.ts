import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { build214, DEFAULT_004010 } from "@shuddl/edi";
import worker from "../src/index.js";
import { run214Sweep, tenderKey, sent214Key, gsControlFromIsa } from "../src/sweep-214.js";
import { RecordingTransport } from "../src/transport.js";
import { buildStatusView, type StatusEventRow } from "../src/core/build-214.js";
import { applyAll, resetCounter, seedEdiPartner, seedEvent } from "./helpers.js";

// WP-12 Task 7 · REQ-200 / REQ-025 — the OUTBOUND 214 SWEEP. Given an R2 tender marker linking a shipment to
// an EDI partner, the cron sweep projects the shipment's SHUDDL status events into a byte-stable X12 214
// (through the pure Task-6 core + @shuddl/edi build214) and transmits it via the injected transport port,
// exactly once. The "214 already sent" R2 marker (keyed by the newest-status dedupe key) makes it idempotent;
// an UNCERTIFIED partner is never transmitted (Task 9 hardens this); a shipment with no status events is a
// clean skip (never a throw). This suite drives run214Sweep with a RecordingTransport — the SAME code path
// scheduled() runs (transportFor injects the real/NotConfigured transport there).

const PARTNER_ID = "partner-acme";
const PARTNER_SCAC = "ACME";
const ISA = "000000042"; // gsControl derives to "42" (leading zeros stripped) — matches the Task-6 convention
const SHIPMENT_ID = "shp-edi-1";
const T0 = Date.UTC(2026, 6, 17, 9, 0);

function controller(scheduledTime = T0): ScheduledController {
  return { scheduledTime, cron: "*/5 * * * *", noRetry() {} };
}
function ctx(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
}

// Seed a delivered shipment's status arc (arrived → departed → pod.signed) into tenant-A. Returns the rows in
// ledger (seq) order, projected to the StatusEventRow shape the core consumes — so the test can compute the
// EXACT byte-stable 214 the sweep must produce.
async function seedDeliveredShipment(shipmentId = SHIPMENT_ID): Promise<StatusEventRow[]> {
  const stream = `s:${shipmentId}`;
  const events = [
    await seedEvent(env.TENANT_A_DB, "stop.arrived", { stream_id: stream, shipment_id: shipmentId, seq: 0, ts: T0 }),
    await seedEvent(env.TENANT_A_DB, "stop.departed", { stream_id: stream, shipment_id: shipmentId, seq: 1, ts: T0 + 1_000 }),
    await seedEvent(env.TENANT_A_DB, "pod.signed", { stream_id: stream, shipment_id: shipmentId, seq: 2, ts: T0 + 2_000 }),
  ];
  return events.map((e) => ({ id: e.id, kind: e.kind, ts: e.ts, payload: e.payload }));
}

async function seedTenderMarker(shipmentId = SHIPMENT_ID): Promise<void> {
  await env.EVIDENCE.put(
    tenderKey("tenant-a", shipmentId),
    JSON.stringify({ partnerId: PARTNER_ID, partnerScac: PARTNER_SCAC, isaControl: ISA }),
  );
}

// The exact expected 214 for a set of status rows — through the SAME pure core + serializer the sweep uses.
function expected(rows: StatusEventRow[], shipmentId = SHIPMENT_ID): { bytes: string; dedupeKey: string } {
  const { view, dedupeKey } = buildStatusView({
    shipmentRef: shipmentId,
    partnerScac: PARTNER_SCAC,
    isaControl: ISA,
    gsControl: gsControlFromIsa(ISA),
    mapping: DEFAULT_004010,
    events: rows,
  });
  return { bytes: build214(view), dedupeKey };
}

beforeAll(async () => {
  await applyAll(env.TENANT_A_DB);
  await applyAll(env.TENANT_B_DB);
});
beforeEach(() => resetCounter());

describe("REQ-200 — outbound 214 sweep", () => {
  it("transmits exactly ONE byte-stable 214, and a second run transmits NOTHING (R2 dedupe marker)", async () => {
    const rows = await seedDeliveredShipment();
    await seedEdiPartner(env.TENANT_A_DB, PARTNER_ID, "certified");
    await seedTenderMarker();
    const exp = expected(rows);

    const transport = new RecordingTransport();
    await run214Sweep(env, transport);

    // (a) exactly one 214, and its bytes EQUAL build214(expectedView) — byte-for-byte.
    expect(transport.sent).toHaveLength(1);
    const [first] = transport.sent;
    expect(first).toBeDefined();
    expect(first!.bytes).toBe(exp.bytes);
    expect(first!.partnerScac).toBe(PARTNER_SCAC);
    expect(first!.idempotencyKey).toBe(exp.dedupeKey);

    // the sent-record IS the R2 marker (the wire bytes, no new table).
    const marker = await env.EVIDENCE.get(sent214Key("tenant-a", exp.dedupeKey));
    expect(marker, "the 214 sent-marker exists after a successful transmit").not.toBeNull();
    expect(await marker!.text()).toBe(exp.bytes);

    // (b) a SECOND run sees the dedupe marker and transmits nothing new.
    await run214Sweep(env, transport);
    expect(transport.sent, "second sweep is idempotent — no re-transmit").toHaveLength(1);
  });

  it("an UNCERTIFIED partner's shipment transmits NOTHING and writes no sent-marker", async () => {
    const rows = await seedDeliveredShipment();
    await seedEdiPartner(env.TENANT_A_DB, PARTNER_ID, "pending"); // not 'certified'
    await seedTenderMarker();
    const exp = expected(rows);

    const transport = new RecordingTransport();
    await run214Sweep(env, transport);

    expect(transport.sent, "uncertified partner is never transmitted").toHaveLength(0);
    expect(await env.EVIDENCE.get(sent214Key("tenant-a", exp.dedupeKey)), "no sent-marker for an uncertified partner").toBeNull();
  });

  it("does NOT throw when a tendered shipment has no status events (clean skip)", async () => {
    await seedEdiPartner(env.TENANT_A_DB, PARTNER_ID, "certified");
    await seedTenderMarker("shp-no-status"); // a tender marker but zero status events on that stream

    const transport = new RecordingTransport();
    await expect(run214Sweep(env, transport)).resolves.toBeUndefined();
    expect(transport.sent).toHaveLength(0);
  });

  it("scheduled() ACTUALLY drives the sweep (per-tenant sweep log emitted) — non-tautological", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await worker.scheduled(controller(), env, ctx());
      const swept = logSpy.mock.calls.some((call) => call.some((a) => typeof a === "string" && a.includes("214-sweep: tenant")));
      expect(swept, "scheduled() must invoke run214Sweep").toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});
