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

  it("a schema-invalid tender marker is classified MALFORMED, not FAILED — it must not be retried forever (§783)", async () => {
    // `readTenderMarker` runs `TenderMarker.safeParse` and returns null on failure. Nothing pinned it:
    // replacing it with `return parsed as TenderMarker` left this worker 118/118 GREEN.
    //
    // What that mutation does NOT change is safety. A sibling guard downstream (`buildStatusView`'s own
    // schema) still throws, so nothing reaches the transport either way — measured, not assumed. My first
    // version of this test asserted only `transport.sent === 0` and was therefore VACUOUS: it passed with the
    // guard deleted, for a reason unrelated to the guard.
    //
    // What the guard is load-bearing for is CLASSIFICATION, and that is a real difference:
    //
    //   with it     → `malformed: 1`  — a data fault, terminal, skipped quietly
    //   without it  → `failed: 1`     — logged "transmit failed (retry next tick)"
    //
    // `failed` is the RETRIABLE bucket. A permanently corrupt marker would be re-read, re-parsed and
    // re-thrown on every tick forever, burning a sweep slot each time and reporting a transient fault that no
    // retry can fix — the exact confusion §29's inbound handler was rewritten to avoid ("a deterministic
    // condition never returns 5xx"). The summary is the operator's only view of this sweep, so a permanent
    // fault filed under "retry next tick" is a lie the ops queue will act on.
    //
    // The DISCRIMINATING fixture (§772): `partnerId` VALID — so the partner lookup and the cert gate both
    // pass and the sweep reaches the marker-dependent work — with a non-string `partnerScac`, plus a stray
    // key so `.strict()` is exercised too.
    await seedDeliveredShipment();
    await seedEdiPartner(env.TENANT_A_DB, PARTNER_ID, "certified", COUNTER_CONFIG);
    await env.EVIDENCE.put(
      tenderKey("tenant-a", SHIPMENT_ID),
      JSON.stringify({ partnerId: PARTNER_ID, partnerScac: 42, isaControl: INBOUND_ISA, stray: "x" }),
    );

    const transport = new RecordingTransport();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let summary: string;
    try {
      await run214Sweep(env, transport, clock);
      summary = logSpy.mock.calls.flat().filter((a): a is string => typeof a === "string").find((a) => a.includes('"tenant":"tenant-a"')) ?? "";
    } finally {
      logSpy.mockRestore();
    }

    // THE CLASSIFICATION — the half that only this guard delivers.
    expect(summary, "the tenant summary was not emitted").not.toBe("");
    expect(JSON.parse(summary.slice(summary.indexOf("{"))), "a schema-invalid marker is a DATA fault, not a retriable one").toMatchObject({
      scanned: 1,
      malformed: 1,
      failed: 0,
      transmitted: 0,
    });

    // …and the safety half, which the sibling guard also delivers — asserted so a future refactor that removes
    // the sibling cannot quietly make this the only thing standing between a bad marker and the wire.
    expect(transport.sent, "a schema-invalid marker must never reach the transport").toHaveLength(0);
    expect(await readOutboundIsa(), "a malformed marker must not burn a control number").toBe(41);
  });

  it("an OTHERWISE-VALID marker carrying a stray key is also refused — `.strict()` is deliberate here (§783)", async () => {
    // Separated from the case above because that fixture's bad `partnerScac` MASKED this one: dropping
    // `.strict()` left the suite green, since a non-string SCAC fails the field check either way. A guard
    // needs a fixture whose only defect is the thing the guard catches (§772).
    //
    // WHY STRICT HERE, when §781/§782 chose NON-strict for the surface seams — the distinction is the
    // deploy boundary, not taste:
    //   · a SURFACE parses a body from a SEPARATELY deployed API, so a field the server adds must be
    //     STRIPPED; rejecting it would blank a page over a harmless addition.
    //   · this marker is written by `inbound.ts` and read by `sweep-214.ts` — the SAME worker, deployed
    //     atomically. Writer and reader are always the same version, so an unexpected key cannot be a
    //     version skew; it can only be a writer/reader disagreement, which is exactly what to catch.
    // If the marker ever gains a writer outside this worker, that reasoning ends and this test is the place
    // the change will announce itself.
    await seedDeliveredShipment();
    await seedEdiPartner(env.TENANT_A_DB, PARTNER_ID, "certified", COUNTER_CONFIG);
    await env.EVIDENCE.put(
      tenderKey("tenant-a", SHIPMENT_ID),
      JSON.stringify({ partnerId: PARTNER_ID, partnerScac: PARTNER_SCAC, isaControl: INBOUND_ISA, unexpected: "field" }),
    );

    const transport = new RecordingTransport();
    await run214Sweep(env, transport, clock);
    expect(transport.sent, "a marker with an unrecognised key must not be trusted onto the wire").toHaveLength(0);
    expect(await readOutboundIsa(), "…and must burn no control number").toBe(41);
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
  // ── §1065 — CHARACTERIZATION of the L409 race. THIS TEST ASSERTS A DEFECT. ──────────────────────────────
  //
  // Checklist L409 (**High, latent**) records that the sent-marker is a presence CHECK, not a CLAIM, and that
  // Cloudflare gives `scheduled()` no mutual exclusion — so a `*/5` tick outrunning five minutes overlaps the
  // next one, both `head` the marker while it is absent, and both transmit. That was MEASURED ONCE by hand at
  // audit §236 and pinned by NOTHING: this suite covers byte-stability, control numbers, certification,
  // tenant isolation, failed sends and malformed markers, and never drives two sweeps at once.
  //
  // An unpinned defect is as fragile as an unpinned fix. It can silently change shape, silently worsen, or
  // silently disappear — and when the eventual fix lands there is nothing to prove it changed anything.
  //
  // SO THIS TEST EXPECTS **2** TRANSMITS. It is deliberately the wrong number for production and the right
  // number for today, which is what a characterization test is. It does NOT choose between the two candidate
  // fixes — claim-before-send (closes the race, but strands a 214 permanently if the process dies between
  // claim and send) and a lease with expiry — because that trade-off is L410's open owner decision, and a
  // silent omission is worse than a duplicate for freight status.
  //
  // WHEN THE FIX LANDS: flip this expectation to 1, keep the concurrency, and move this comment to the fix.
  // A green `toHaveLength(1)` here is then the only evidence in the repo that the race is actually closed.
  it("CHARACTERIZATION (L409, unfixed): two overlapping sweeps BOTH transmit the same 214", async () => {
    await seedDeliveredShipment();
    await seedEdiPartner(env.TENANT_A_DB, PARTNER_ID, "certified", COUNTER_CONFIG);
    await seedTenderMarker();

    // COUNT CALLS INTO THE TRANSPORT, NOT `transport.sent` — and this is the whole reason the race went
    // unpinned for 800 sections. `RecordingTransport.send214` keeps its own `byKey` map and returns early on
    // a repeat key with identical bytes ("no second record"), so **`transport.sent` can never exceed 1 for one
    // idempotency key, by construction of the double**. The natural assertion is structurally incapable of
    // seeing the defect: measured here, the naive version reports 1 and reads as "the race is closed".
    //
    // The 60ms hold keeps BOTH sweeps inside `send214` before either writes its marker (the sweep is
    // send-THEN-mark), which is exactly the overlap a `*/5` tick outrunning five minutes produces.
    const transport = new RecordingTransport();
    let calls = 0;
    const inner = transport.send214.bind(transport);
    (transport as unknown as { send214: typeof inner }).send214 = async (partner, bytes, key) => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 60));
      return inner(partner, bytes, key);
    };
    await Promise.all([run214Sweep(env, transport, clock), run214Sweep(env, transport, clock)]);

    expect(
      calls,
      "the L409 race no longer reproduces — TWO transmits of one 214 no longer occur. If a claim or lease " +
        "landed, this is the GOOD failure: change the expectation to 1, keep the concurrency and the " +
        "call-counting, and close checklist L409/L410. Do NOT switch back to asserting `transport.sent`: the " +
        "double dedupes, so it would report success whether or not the race is fixed.",
    ).toBe(2);
    expect(transport.sent, "the double collapses the duplicate — this is the masking, pinned").toHaveLength(1);
  });
});
