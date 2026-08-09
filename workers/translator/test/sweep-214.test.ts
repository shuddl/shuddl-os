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
  return { bytes: build214({ ...view, sentAt: SENT_AT }), dedupeKey };
}

beforeAll(async () => {
  await applyAll(env.TENANT_A_DB);
  await applyAll(env.TENANT_B_DB);
});
beforeEach(() => resetCounter());

// The fixed send instant every run in this suite stamps (2026-08-01: real interchange dates at send —
// the sweep is byte-DETERMINISTIC given its injected clock, no longer byte-CONSTANT).
const SENT_AT = Date.UTC(2026, 7, 1, 12, 0, 0);
const clock = (): number => SENT_AT;

describe("REQ-200/204 — outbound 214 sweep with allocated control numbers", () => {
  it("transmits ONE byte-stable 214 carrying SHUDDL's ALLOCATED ISA13 (not the inbound one); a second run transmits NOTHING and burns no number", async () => {
    const rows = await seedDeliveredShipment();
    await seedEdiPartner(env.TENANT_A_DB, PARTNER_ID, "certified", COUNTER_CONFIG); // counter 41 → first alloc 42
    await seedTenderMarker();
    const exp = expected(rows);

    const transport = new RecordingTransport();
    await run214Sweep(env, transport, clock);

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
    // (2026-08-01) the wire carries the REAL send instant, never the year-2000 fixture constants a partner
    // VAN would reject: ISA09/ISA10 from the injected clock, and no 000101/20000101 anywhere in the envelope.
    expect(first!.bytes).toContain("*260801*1200*U*");
    // delimiter-bounded (the review caught the bare substrings false-failing on a legitimate control
    // number: "000000101" contains "000101") — anchor to the envelope date positions, like the positive.
    expect(first!.bytes).not.toContain("*000101*0000*U*");
    expect(first!.bytes).not.toContain("*20000101*0000*");
    expect(await readOutboundIsa(), "the counter advanced exactly once (41 → 42)").toBe(42);

    // the sent-record IS the R2 marker (the wire bytes, no new table).
    const marker = await env.EVIDENCE.get(sent214Key("tenant-a", exp.dedupeKey));
    expect(marker, "the 214 sent-marker exists after a successful transmit").not.toBeNull();
    expect(await marker!.text()).toBe(exp.bytes);

    // (b) a SECOND run sees the dedupe marker: no re-transmit AND — crucially — no control-number burn.
    await run214Sweep(env, transport, clock);
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
    await run214Sweep(env, transport, clock);

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
    await run214Sweep(env, transport, clock);
    expect(transport.sent, "uncertified → nothing transmitted").toHaveLength(0);
    expect(await env.EVIDENCE.get(sent214Key("tenant-a", exp.dedupeKey)), "no sent-marker for an uncertified partner").toBeNull();
    expect(await readOutboundIsa(), "uncertified → no control-number burn").toBe(41);

    // certify THROUGH the Task-9 entrypoint → the SAME sweep now transmits + allocates the first number.
    await certifyPartner(env.TENANT_A_DB, PARTNER_ID, "fixtures/edi/roundtrip.json");
    await run214Sweep(env, transport, clock);
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
      await run214Sweep(env, transport, clock);
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

  it("a FAILED send leaves NO phantom sent-marker, and the next tick actually transmits (§775)", async () => {
    // The module header's send-then-mark law: "[the sent-marker] is written ONLY after a successful transmit,
    // so an unwired/failed send never leaves a phantom sent-marker and the next tick re-attempts."
    //
    // NOTHING pinned it. Measured: swapping the two lines so the marker is written BEFORE the send left this
    // worker 117/117 GREEN. Under that inversion a rejecting transport writes "already sent", the catch below
    // logs it, and EVERY LATER TICK SKIPS THE SHIPMENT — the 214 is stranded and the partner never learns the
    // load delivered. Silent, permanent, and invisible to the summary (which counts it `failed`, correctly,
    // exactly once — after that the shipment is simply gone from the sweep's view).
    //
    // The dormant state is what makes this urgent rather than theoretical: `NotConfiguredTransport` ALWAYS
    // rejects, so with the ordering inverted every tendered shipment would be marked sent-but-never-sent on
    // its first tick, and wiring the live VAN adapter later would transmit NONE of them.
    //
    // `transport-dormancy.test.ts` is named "…so the sweep records no phantom send" but asserts only that the
    // transport rejects — it never drives the sweep. That is the name-vs-body gap (§"a gate's green certifies
    // less than its name"); this test is the missing half, and it belongs here, where the sweep is driven.
    const rows = await seedDeliveredShipment();
    await seedEdiPartner(env.TENANT_A_DB, PARTNER_ID, "certified", COUNTER_CONFIG);
    await seedTenderMarker();
    const exp = expected(rows);

    // A transport that rejects exactly as the live adapter would on a VAN fault (and as the dormant one always does).
    const failing = {
      send214: () => Promise.reject(new Error("VAN unreachable")),
      send990: () => Promise.reject(new Error("VAN unreachable")),
    };
    // Plainly awaited: reaching the next line IS the "one shipment's fault must not throw the sweep" claim.
    await run214Sweep(env, failing, clock);

    // THE LAW: no marker. A marker here means "already sent" to every future tick.
    expect(
      await env.EVIDENCE.head(sent214Key("tenant-a", exp.dedupeKey)),
      "a FAILED send wrote a sent-marker — every later tick will skip this shipment and the 214 is stranded forever",
    ).toBeNull();

    // …and the consequence that matters, asserted rather than inferred: the retry actually goes out. This is
    // what a marker-presence assertion alone cannot prove, and it is the behaviour the partner experiences.
    const good = new RecordingTransport();
    await run214Sweep(env, good, clock);
    expect(good.sent, "the next tick must re-attempt a failed 214").toHaveLength(1);
    // Compared on the dedupe key, NOT on `exp.bytes`: `expected()` stamps ALLOC_ISA (42), and the re-attempt
    // legitimately carries 43 — the burned-number gap asserted below. Byte-equality against the first
    // attempt's envelope would fail for the very reason this test exists to document.
    expect(good.sent[0]!.idempotencyKey).toBe(exp.dedupeKey);
    expect(good.sent[0]!.partnerScac).toBe(PARTNER_SCAC);
    // `head`, not `get`: a `get` hands back an R2ObjectBody whose stream this assertion never consumes,
    // and an undisposed stream breaks the pool's isolated-storage pop ("unable to pop R2 storage") — a
    // harness fault that reads as an unrelated unhandled error. Presence is what is being asserted anyway.
    expect(await env.EVIDENCE.head(sent214Key("tenant-a", exp.dedupeKey)), "now it is genuinely sent").not.toBeNull();

    // The burned control number is EXPECTED, not a defect: allocation precedes the send, and the header states
    // a re-attempt allocates a FRESH number — "the burned-but-unsent number is a legal X12 gap, never reused".
    // Pinned so the gap stays deliberate: 41 → 42 (burned by the failed attempt) → 43 (the one on the wire).
    expect(await readOutboundIsa()).toBe(43);
    expect(isaOf(good.sent[0]!.bytes)).toBe("000000043");
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
