import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { build214, DEFAULT_004010 } from "@shuddl/edi";
import worker from "../src/index.js";
import { run214Sweep, tenderKey, sent214Key } from "../src/sweep-214.js";
import { certifyPartner } from "../src/partners.js";
import { RecordingTransport } from "../src/transport.js";
import { buildStatusView, type StatusEventRow } from "../src/core/build-214.js";
import { applyAll, resetCounter, seedEdiPartner, seedEvent } from "./helpers.js";

// WP-12 Task 7/9 · REQ-200 / REQ-203 / REQ-204 / REQ-025 — the OUTBOUND 214 SWEEP. Given an R2 tender marker
// linking a shipment to an EDI partner, the cron sweep projects the shipment's SHUDDL status events into a
// byte-stable X12 214 and transmits it via the injected transport port, exactly once. The 214 now carries
// SHUDDL's OWN allocated ISA13/GS06 (Task 9, partners.ts) — NOT an echo of the inbound 204's ISA13. The
// allocation happens AFTER the R2 dedupe check, so an already-sent shipment never burns a control number; an
// UNCERTIFIED partner is never transmitted and allocates nothing (withhold-until-certified). This suite drives
// run214Sweep with a RecordingTransport — the SAME code path scheduled() runs.

const PARTNER_ID = "partner-acme";
const PARTNER_SCAC = "ACME";
// The PARTNER's inbound-204 interchange number, written into the tender marker. It must NEVER appear on the
// outbound 214 (echoing it is the X12 correctness bug Task 9 fixes).
const INBOUND_ISA = "000000999";
// Seed the partner's outbound counter at 41 so the FIRST allocation is deterministically 42 → ISA13 "000000042"
// / GS06 "42" (and the second is 43). Tests can seed the counter for determinism (REQ-204).
const COUNTER_CONFIG = JSON.stringify({ outbound: { isa: 41, gs: 41 } });
const ALLOC_ISA = "000000042";
const ALLOC_GS = "42";
const SHIPMENT_ID = "shp-edi-1";
const T0 = Date.UTC(2026, 6, 17, 9, 0);

function controller(scheduledTime = T0): ScheduledController {
  return { scheduledTime, cron: "*/5 * * * *", noRetry() {} };
}
function ctx(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
}

// The ISA13 (interchange control) of a serialized interchange = the 14th element of the ISA segment (index 13),
// so a test can prove which control number the wire actually carries.
function isaOf(bytes: string): string {
  return bytes.split("~")[0]!.split("*")[13]!;
}

// Read the persisted outbound counter (integrations.config.$.outbound.isa) so a test can prove it advanced —
// or did NOT (a dedup skip / uncertified partner must burn nothing).
async function readOutboundIsa(id = PARTNER_ID): Promise<number | undefined> {
  const row = await env.TENANT_A_DB.prepare("SELECT config FROM integrations WHERE kind='edi_partner' AND id=? LIMIT 1").bind(id).first<{ config: string }>();
  const cfg = JSON.parse(row!.config) as { outbound?: { isa?: number } };
  return cfg.outbound?.isa;
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
    JSON.stringify({ partnerId: PARTNER_ID, partnerScac: PARTNER_SCAC, isaControl: INBOUND_ISA }),
  );
}

// The exact expected 214 for a set of status rows — through the SAME pure core + serializer the sweep uses,
// stamped with the ALLOCATED control numbers (what the sweep now assigns at send time).
function expected(rows: StatusEventRow[], shipmentId = SHIPMENT_ID): { bytes: string; dedupeKey: string } {
  const { view, dedupeKey } = buildStatusView({
    shipmentRef: shipmentId,
    partnerScac: PARTNER_SCAC,
    isaControl: ALLOC_ISA,
    gsControl: ALLOC_GS,
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

describe("REQ-200/204 — outbound 214 sweep with allocated control numbers", () => {
  it("transmits ONE byte-stable 214 carrying SHUDDL's ALLOCATED ISA13 (not the inbound one); a second run transmits NOTHING and burns no number", async () => {
    const rows = await seedDeliveredShipment();
    await seedEdiPartner(env.TENANT_A_DB, PARTNER_ID, "certified", COUNTER_CONFIG); // counter 41 → first alloc 42
    await seedTenderMarker();
    const exp = expected(rows);

    const transport = new RecordingTransport();
    await run214Sweep(env, transport);

    // (a) exactly one 214, byte-for-byte equal to the projection stamped with the ALLOCATED control numbers.
    expect(transport.sent).toHaveLength(1);
    const [first] = transport.sent;
    expect(first).toBeDefined();
    expect(first!.bytes).toBe(exp.bytes);
    expect(first!.partnerScac).toBe(PARTNER_SCAC);
    expect(first!.idempotencyKey).toBe(exp.dedupeKey);
    // the wire carries SHUDDL's ALLOCATED ISA13, NEVER the partner's inbound-204 number (the echo bug is fixed).
    expect(isaOf(first!.bytes)).toBe(ALLOC_ISA);
    expect(isaOf(first!.bytes)).not.toBe(INBOUND_ISA);
    expect(await readOutboundIsa(), "the counter advanced exactly once (41 → 42)").toBe(42);

    // the sent-record IS the R2 marker (the wire bytes, no new table).
    const marker = await env.EVIDENCE.get(sent214Key("tenant-a", exp.dedupeKey));
    expect(marker, "the 214 sent-marker exists after a successful transmit").not.toBeNull();
    expect(await marker!.text()).toBe(exp.bytes);

    // (b) a SECOND run sees the dedupe marker: no re-transmit AND — crucially — no control-number burn.
    await run214Sweep(env, transport);
    expect(transport.sent, "second sweep is idempotent — no re-transmit").toHaveLength(1);
    expect(await readOutboundIsa(), "a dedup skip must NOT burn a control number").toBe(42);
  });

  it("two distinct shipments for one partner get CONSECUTIVE control numbers (monotonic, never reused)", async () => {
    await seedDeliveredShipment("shp-edi-a");
    await seedDeliveredShipment("shp-edi-b");
    await seedEdiPartner(env.TENANT_A_DB, PARTNER_ID, "certified", COUNTER_CONFIG); // 41 → 42, 43
    await seedTenderMarker("shp-edi-a");
    await seedTenderMarker("shp-edi-b");

    const transport = new RecordingTransport();
    await run214Sweep(env, transport);

    expect(transport.sent).toHaveLength(2);
    const isas = transport.sent.map((s) => isaOf(s.bytes)).sort();
    expect(isas, "two distinct, consecutive allocated ISA13 — no reuse").toEqual([ALLOC_ISA, "000000043"]);
    expect(await readOutboundIsa(), "the counter advanced by exactly two").toBe(43);
  });

  it("withhold-until-certified: cert_status≠'certified' → NO 214 and NO burn; after certifyPartner the SAME sweep transmits + allocates", async () => {
    const rows = await seedDeliveredShipment();
    await seedEdiPartner(env.TENANT_A_DB, PARTNER_ID, null, COUNTER_CONFIG); // cert_status NULL, counter 41
    await seedTenderMarker();
    const exp = expected(rows);

    const transport = new RecordingTransport();
    await run214Sweep(env, transport);
    expect(transport.sent, "uncertified → nothing transmitted").toHaveLength(0);
    expect(await env.EVIDENCE.get(sent214Key("tenant-a", exp.dedupeKey)), "no sent-marker for an uncertified partner").toBeNull();
    expect(await readOutboundIsa(), "uncertified → no control-number burn").toBe(41);

    // certify THROUGH the Task-9 entrypoint → the SAME sweep now transmits + allocates the first number.
    await certifyPartner(env.TENANT_A_DB, PARTNER_ID, "fixtures/edi/roundtrip.json");
    await run214Sweep(env, transport);
    expect(transport.sent, "certified → transmitted").toHaveLength(1);
    expect(transport.sent[0]!.bytes).toBe(exp.bytes);
    expect(await readOutboundIsa(), "certified → the counter advanced (41 → 42)").toBe(42);
  });

  // REQ-025 — cross-tenant isolation regression for the R2 key templates + the per-tenant `integrations` read.
  // The tender marker sits under tenant-A's R2 prefix and names a partner that is CERTIFIED but exists ONLY in
  // tenant-B's D1. The tenant-A iteration must resolve that partner via tenant-A's OWN db handle (→ null → a
  // `noPartner` skip), NEVER borrow tenant-B's certified row. Nothing is transmitted, no control number is
  // allocated, and no `edi/tenant-b/…` key is touched while processing tenant-a.
  it("REQ-025 — a partner certified only in tenant-B is invisible to tenant-A's sweep (no cross-tenant read)", async () => {
    const CROSS_ID = "shp-iso-1";
    const B_ONLY_PARTNER = "partner-b-only";
    await seedDeliveredShipment(CROSS_ID); // status events live in tenant-A
    await seedEdiPartner(env.TENANT_B_DB, B_ONLY_PARTNER, "certified"); // the certified row is in tenant-B ONLY
    await env.EVIDENCE.put(
      tenderKey("tenant-a", CROSS_ID),
      JSON.stringify({ partnerId: B_ONLY_PARTNER, partnerScac: PARTNER_SCAC, isaControl: INBOUND_ISA }),
    );

    const transport = new RecordingTransport();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await run214Sweep(env, transport);
      const tenantALine = logSpy.mock.calls
        .map((c) => c.find((a): a is string => typeof a === "string" && a.includes('"tenant":"tenant-a"')))
        .find((s): s is string => s !== undefined);
      expect(tenantALine, "a tenant-a sweep summary was logged").toBeDefined();
      // The partner lookup hit tenant-A's D1 (partner absent) → noPartner skip. Crucially NOT `uncertified`
      // and NOT `transmitted` — either would mean the lookup saw tenant-B's certified row (a leak).
      expect(tenantALine).toContain('"noPartner":1');
      expect(tenantALine).toContain('"transmitted":0');
      expect(tenantALine).toContain('"uncertified":0');
    } finally {
      logSpy.mockRestore();
    }

    expect(transport.sent, "a tenant-B-only partner is never transmitted from tenant-a").toHaveLength(0);
    const tenantB = await env.EVIDENCE.list({ prefix: "edi/tenant-b/" });
    expect(tenantB.objects, "no edi/tenant-b/ key touched while processing tenant-a").toHaveLength(0);
  });

  it("does NOT throw when a tendered shipment has no status events (clean skip, no allocation)", async () => {
    await seedEdiPartner(env.TENANT_A_DB, PARTNER_ID, "certified", COUNTER_CONFIG);
    await seedTenderMarker("shp-no-status"); // a tender marker but zero status events on that stream

    const transport = new RecordingTransport();
    await expect(run214Sweep(env, transport)).resolves.toBeUndefined();
    expect(transport.sent).toHaveLength(0);
    expect(await readOutboundIsa(), "a no-status skip allocates nothing").toBe(41);
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
