import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { EventInput } from "@shuddl/contracts";
import { sweepTenantLegacyMirror, LEGACY_MIRROR_INTEGRATION_ID, type SeqStubLike, type FeedReader } from "../src/mirror-sweep.js";
import { applyAll } from "./helpers.js";
import genericExport from "../../../fixtures/legacy-mirror/generic-export.csv?raw";

// REQ-021 / REQ-022 / REQ-035 (WP-15 Task 4) — the CONTINUOUS legacy-mirror SWEEP. The pure mapper's law is
// proven in packages/adapters/test/legacy-mirror.test.ts; this file proves the I/O half against a MIGRATED tenant
// D1: source:'legacy' events appended THROUGH the (injected) sequencer DO, the gap-row-EVERY-sweep no-silent-drop,
// echo-skip + deterministic-id DO-dedupe (no ping-pong), the watermark (O(changed)), tenant isolation, and
// quarantine-not-drop. The api sequencer DO is STUBBED in this worker's harness, so the append surface is an
// injected recording double that MODELS the DO's real dedupe-by-id (proven for real in workers/api/test).

const MAPPING = {
  typeColumn: "rec_type",
  cursorColumn: "feed_seq",
  echoColumn: "shuddl_ref",
  keyColumn: "rec_id",
  streamColumn: "ship_ref",
  records: [
    { kind: "quote.priced", module: "rating", match: "RATE", fields: { sell_cents: { column: "amount_cents" } } },
    { kind: "invoice.issued", module: "invoicing", match: "INVOICE", fields: { total_cents: { column: "amount_cents" } } },
    { kind: "split.computed", module: "settlement", match: "SETTLE", fields: { total_cents: { column: "amount_cents" } } },
    { kind: "dispatch.assigned", module: "dispatch", match: "DISPATCH", fields: { driver: { column: "driver_ref" } } },
    {
      kind: "appointment.set",
      module: "dispatch",
      match: "APPOINT",
      fields: {
        facility: { column: "facility_ref" },
        slot: { column: "slot_ref" },
        window_start_ms: { column: "win_start_ms" },
        window_end_ms: { column: "win_end_ms" },
      },
    },
  ],
} as const;

// The recording double MODELS the real api sequencer DO: dedupe-by-id (a redelivered/duplicate id is a no-op).
class RecordingSeq implements SeqStubLike {
  readonly appended: Array<{ tenant: string; streamId: string; input: Record<string, unknown> }> = [];
  /** §1373 — CALLS, not distinct rows. The DO dedupe saves the ROW; it does not save the SUBREQUEST. */
  calls = 0;
  private readonly seen = new Set<string>();
  async append(req: { tenant: string; streamId: string; input: unknown }): Promise<{ id: string }> {
    this.calls += 1;
    const input = req.input as { id: string };
    if (this.seen.has(input.id)) return { id: input.id }; // DO dedupe by id — no duplicate row
    this.seen.add(input.id);
    this.appended.push({ tenant: req.tenant, streamId: req.streamId, input: input as Record<string, unknown> });
    return { id: input.id };
  }
}

// A static feed the test controls (production wires a real R2/HTTP reader; the default is fail-closed).
class StaticFeed implements FeedReader {
  constructor(public text: string | null) {}
  async read(): Promise<string | null> {
    return this.text;
  }
}

async function seedConfig(db: D1Database, cursor = 0, mapping: unknown = MAPPING): Promise<void> {
  const config = JSON.stringify({ legacy_mirror: { mapping, watermark: { cursor } } });
  // The sweep resolves the row BY ID (kind-agnostic); the incumbent feed is modeled as an external-partner
  // integration purely to satisfy the fixed integrations.kind CHECK (never amended — REQ/I8).
  await db.prepare("INSERT INTO integrations (id, kind, config) VALUES (?, 'edi_partner', ?)").bind(LEGACY_MIRROR_INTEGRATION_ID, config).run();
}
async function readWatermark(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT config FROM integrations WHERE id = ?").bind(LEGACY_MIRROR_INTEGRATION_ID).first<{ config: string }>();
  return (JSON.parse(row!.config) as { legacy_mirror: { watermark: { cursor: number } } }).legacy_mirror.watermark.cursor;
}
async function resetWatermark(db: D1Database, cursor: number): Promise<void> {
  const row = await db.prepare("SELECT config FROM integrations WHERE id = ?").bind(LEGACY_MIRROR_INTEGRATION_ID).first<{ config: string }>();
  const cfg = JSON.parse(row!.config) as { legacy_mirror: { watermark: { cursor: number } } };
  cfg.legacy_mirror.watermark.cursor = cursor;
  await db.prepare("UPDATE integrations SET config = ? WHERE id = ?").bind(JSON.stringify(cfg), LEGACY_MIRROR_INTEGRATION_ID).run();
}
function countAnomalies(db: D1Database, rulePrefix: string): Promise<number> {
  return db
    .prepare("SELECT COUNT(*) AS n FROM anomalies WHERE rule LIKE ?")
    .bind(`${rulePrefix}%`)
    .first<{ n: number }>()
    .then((r) => r!.n);
}

const A = () => env.TENANT_A_DB;
const B = () => env.TENANT_B_DB;

beforeAll(async () => {
  await applyAll(env.TENANT_A_DB);
  await applyAll(env.TENANT_B_DB);
});

describe("REQ-021 — a legacy export mirrors to source:'legacy' events of the RIGHT kinds, via the DO append", () => {
  it("rated → quote.priced, invoice → invoice.issued, settle/dispatch/appt too; echo skipped; malformed quarantined", async () => {
    await seedConfig(A(), 0);
    const seq = new RecordingSeq();
    const r = await sweepTenantLegacyMirror({ db: A(), seq, feed: new StaticFeed(genericExport), integrationId: LEGACY_MIRROR_INTEGRATION_ID, tenant: "tenant-a", now: 1_000 });

    expect(r.configured).toBe(true);
    expect(r.appended).toBe(5); // RATE, INVOICE, SETTLE, DISPATCH, APPOINT
    expect(r.echoed).toBe(1); // the embedded-SHUDDL-id row
    expect(r.quarantined).toBe(2); // no-amount RATE + unknown WIDGET

    // Every appended input is a REAL, valid EventInput tagged source:'legacy' (validated at the DO boundary).
    for (const a of seq.appended) {
      const parsed = EventInput.parse(a.input);
      expect(parsed.source).toBe("legacy");
      expect(a.tenant).toBe("tenant-a");
      expect(a.streamId.startsWith("s:shp_lg_")).toBe(true);
    }
    const byKind = (k: string) => seq.appended.map((a) => a.input).find((i) => i["kind"] === k);
    expect((byKind("quote.priced")?.["payload"] as { sell: number }).sell).toBe(120_000);
    expect(byKind("invoice.issued")).toBeDefined();
    expect((byKind("split.computed")?.["payload"] as { total_cents: number }).total_cents).toBe(90_000);
    expect((byKind("dispatch.assigned")?.["payload"] as { driver_user_id: string }).driver_user_id).toBe("DRV-7");
    expect(byKind("appointment.set")).toBeDefined();
  });
});

describe("REQ-035 — gap-row EVERY sweep: an unmapped column re-raises each tick, values retained (continuous no-silent-drop)", () => {
  it("misc_note + legacy_status raise 2 gap anomalies per sweep; a second sweep RE-raises them (now 4); values retained", async () => {
    await seedConfig(A(), 0);
    const seq = new RecordingSeq();
    const feed = new StaticFeed(genericExport);

    await sweepTenantLegacyMirror({ db: A(), seq, feed, integrationId: LEGACY_MIRROR_INTEGRATION_ID, tenant: "tenant-a", now: 1_000 });
    expect(await countAnomalies(A(), "legacy_mirror.unmapped_column")).toBe(2);

    // Second sweep: the watermark now blocks every row (nothing new appended, O(changed)=0) — yet the SCHEMA
    // gap rows STILL re-raise (distinct ids fold the sweep clock). That is the "continuous" in no-silent-drop.
    const r2 = await sweepTenantLegacyMirror({ db: A(), seq, feed, integrationId: LEGACY_MIRROR_INTEGRATION_ID, tenant: "tenant-a", now: 2_000 });
    expect(r2.appended).toBe(0);
    expect(r2.scanned).toBe(0);
    expect(await countAnomalies(A(), "legacy_mirror.unmapped_column")).toBe(4); // re-raised, not deduped away

    // The retained per-row value rode the gap anomaly detail (a human sees the sample, nothing hidden).
    const detail = await A().prepare("SELECT detail FROM anomalies WHERE rule LIKE 'legacy_mirror.unmapped_column%' LIMIT 1").first<{ detail: string }>();
    expect((JSON.parse(detail!.detail) as { sample: string | null }).sample).not.toBeNull();
  });
});

describe("REQ-022 — echo-safe: no ping-pong (embedded-id skip + deterministic-id DO-dedupe)", () => {
  it("an embedded-SHUDDL-id row is never appended as legacy (no ping-pong)", async () => {
    await seedConfig(A(), 0);
    const seq = new RecordingSeq();
    await sweepTenantLegacyMirror({ db: A(), seq, feed: new StaticFeed(genericExport), integrationId: LEGACY_MIRROR_INTEGRATION_ID, tenant: "tenant-a", now: 1_000 });
    // SH-1003 is the echoed stream — no legacy event may carry it (that would be a native fact masquerading as legacy).
    expect(seq.appended.some((a) => a.streamId.includes(String("SH-1003")))).toBe(false);
    expect(seq.appended.some((a) => (a.input["payload"] as { sell?: number }).sell === 55_000)).toBe(false);
  });

  it("re-ingesting the SAME rows (watermark reset) appends NOTHING new — deterministic ids dedupe at the DO", async () => {
    await seedConfig(A(), 0);
    const seq = new RecordingSeq();
    const feed = new StaticFeed(genericExport);
    await sweepTenantLegacyMirror({ db: A(), seq, feed, integrationId: LEGACY_MIRROR_INTEGRATION_ID, tenant: "tenant-a", now: 1_000 });
    expect(seq.appended.length).toBe(5);

    // Simulate a full re-ingest (a cursor reset / a redelivered feed): the deterministic ids reproduce → the DO
    // dedupes → not one duplicate event. Idempotent.
    await resetWatermark(A(), 0);
    await sweepTenantLegacyMirror({ db: A(), seq, feed, integrationId: LEGACY_MIRROR_INTEGRATION_ID, tenant: "tenant-a", now: 3_000 });
    expect(seq.appended.length).toBe(5); // unchanged — no ping-pong, no duplicate

    // §1373 (REQ-021, audit §1361) — THE DEDUPE SAVES THE ROW, NOT THE SUBREQUEST.
    //
    // The assertion above is about DATA: no duplicate event exists. This one is about COST, and it is the
    // premise the GO-LIVE row "Live legacy-feed provisioning" and `feed-dormancy.test.ts`'s HOLD message both
    // rest on: a zero-watermark sweep EXAMINES every row, and each examined row costs one `anchorStream` read
    // plus one sequencer append CALL. Idempotence is enforced at the DO, downstream of the subrequest — so a
    // re-ingest is free in rows and NOT free in Cloudflare subrequests, against a per-invocation ceiling of
    // 1,000 (Free) / 10,000 (Paid).
    //
    // Written because §1372 caught me attributing a defect I had reasoned about rather than exercised. This
    // file's `RecordingSeq` dedupes internally, so `appended.length` staying at 5 across two full sweeps reads
    // like "the second sweep did no work" — it did all of it.
    expect(seq.calls, "the re-sweep issued no append calls — then the first-sweep cost claim is wrong").toBe(10);

  });
});

describe("REQ-021 — watermark-diffed: only NEW/CHANGED rows are appended (O(changed))", () => {
  it("a second sweep over a feed with one new row appends ONLY the new row and advances the cursor", async () => {
    await seedConfig(A(), 0);
    const seq = new RecordingSeq();
    const feed = new StaticFeed(genericExport);
    await sweepTenantLegacyMirror({ db: A(), seq, feed, integrationId: LEGACY_MIRROR_INTEGRATION_ID, tenant: "tenant-a", now: 1_000 });
    expect(seq.appended.length).toBe(5);
    expect(await readWatermark(A())).toBe(8); // the max feed_seq processed

    // Append ONE new record (feed_seq 9) to the live feed and sweep again.
    feed.text = `${genericExport}R-2000,RATE,9,,SH-2000,77000,,,,,,new lane,OPEN\n`;
    const r2 = await sweepTenantLegacyMirror({ db: A(), seq, feed, integrationId: LEGACY_MIRROR_INTEGRATION_ID, tenant: "tenant-a", now: 2_000 });
    expect(r2.scanned).toBe(1); // only the new row was examined
    expect(r2.appended).toBe(1);
    expect(seq.appended.length).toBe(6);
    expect(await readWatermark(A())).toBe(9); // cursor advanced
  });
});

describe("REQ-025 — tenant isolation: a tenant-A sweep never writes tenant-B", () => {
  it("sweeping tenant-A leaves tenant-B's anomalies + integrations untouched", async () => {
    await seedConfig(A(), 0);
    const seq = new RecordingSeq();
    await sweepTenantLegacyMirror({ db: A(), seq, feed: new StaticFeed(genericExport), integrationId: LEGACY_MIRROR_INTEGRATION_ID, tenant: "tenant-a", now: 1_000 });

    expect(await countAnomalies(B(), "legacy_mirror")).toBe(0);
    const bRow = await B().prepare("SELECT COUNT(*) AS n FROM integrations WHERE id = ?").bind(LEGACY_MIRROR_INTEGRATION_ID).first<{ n: number }>();
    expect(bRow!.n).toBe(0);
    for (const a of seq.appended) expect(a.tenant).toBe("tenant-a");
  });
});

describe("REQ-035 — quarantine, never drop: a malformed row → an idempotent anomaly, never a throw", () => {
  it("2 quarantine anomalies (missing-field + unknown-type); a re-sweep does NOT storm them (idempotent by content)", async () => {
    await seedConfig(A(), 0);
    const seq = new RecordingSeq();
    const feed = new StaticFeed(genericExport);
    const r1 = await sweepTenantLegacyMirror({ db: A(), seq, feed, integrationId: LEGACY_MIRROR_INTEGRATION_ID, tenant: "tenant-a", now: 1_000 });
    expect(r1.quarantined).toBe(2);
    expect(await countAnomalies(A(), "legacy_mirror.quarantine")).toBe(2);

    // Re-ingest (watermark reset): the quarantine anomaly id folds the row content (not the clock), so the SAME
    // bad rows dedupe — no throw-storm, no unbounded growth.
    await resetWatermark(A(), 0);
    await expect(
      sweepTenantLegacyMirror({ db: A(), seq, feed, integrationId: LEGACY_MIRROR_INTEGRATION_ID, tenant: "tenant-a", now: 3_000 }),
    ).resolves.toBeDefined();
    expect(await countAnomalies(A(), "legacy_mirror.quarantine")).toBe(2); // still 2 — idempotent
  });

  // §1540 (REQ-035/030) — THE SECOND INSTANCE OF §1539. The quarantine id folds the ROW CONTENT, not the clock,
  // which is what makes the case above hold — and it is exactly what makes a cleared row unable to come back.
  // The gap rows in this same file re-raise safely because their id folds `now` (LAW 2), so each sweep mints a
  // NEW id; a content-keyed id cannot do that, so the row must be REOPENED instead. With `INSERT OR IGNORE`
  // it never was: an operator clears the quarantine, the legacy feed still carries the same bad row, every
  // later sweep re-encounters it and writes nothing, and every ops read of `anomalies` filters `status='open'`.
  //
  // The discriminator, stated because it decides which writers of this table need which clause: an id keyed on a
  // RECURRING CONDITION (this one; the EDI partner+ISA one) must reopen; an id keyed on a ONE-SHOT OCCURRENCE
  // (`lgm_gap_`'s folded clock, `import.ts`'s per-run `importId`) mints a fresh row and OR IGNORE is correct.
  it("a CLEARED quarantine reopens when the same bad row is swept again — still ONE row per bad row", async () => {
    await seedConfig(A(), 0);
    const seq = new RecordingSeq();
    const feed = new StaticFeed(genericExport);
    await sweepTenantLegacyMirror({ db: A(), seq, feed, integrationId: LEGACY_MIRROR_INTEGRATION_ID, tenant: "tenant-a", now: 1_000 });
    expect(await countAnomalies(A(), "legacy_mirror.quarantine")).toBe(2);

    // An operator clears them — byte-identical to watchtower's clearAlarm, the only clear this table has.
    await A().prepare("UPDATE anomalies SET status = 'resolved' WHERE rule = 'legacy_mirror.quarantine'").run();

    // The legacy feed is unchanged: the same bad rows are still there and the next sweep re-reads them.
    await resetWatermark(A(), 0);
    await sweepTenantLegacyMirror({ db: A(), seq, feed, integrationId: LEGACY_MIRROR_INTEGRATION_ID, tenant: "tenant-a", now: 3_000 });

    expect(await countAnomalies(A(), "legacy_mirror.quarantine"), "the content-keyed id stopped collapsing — a re-sweep forked new rows").toBe(2);
    const open = await A()
      .prepare("SELECT COUNT(*) AS n FROM anomalies WHERE rule = 'legacy_mirror.quarantine' AND status = 'open'")
      .first<{ n: number }>();
    expect(
      open?.n,
      "the bad rows are still in the feed and still unmappable, but their anomalies sit at 'resolved' — every ops " +
        "read filters status = 'open', so the quarantine is invisible while the sweep keeps hitting it",
    ).toBe(2);
  });
});

describe("fail-closed — no config / no feed is a clean no-op (production is inert until a pack wires it)", () => {
  it("no legacy-mirror integration row ⇒ configured:false, nothing appended", async () => {
    const seq = new RecordingSeq();
    const r = await sweepTenantLegacyMirror({ db: A(), seq, feed: new StaticFeed(genericExport), integrationId: LEGACY_MIRROR_INTEGRATION_ID, tenant: "tenant-a", now: 1_000 });
    expect(r.configured).toBe(false);
    expect(seq.appended.length).toBe(0);
  });

  it("a configured row but a fail-closed (null) feed ⇒ no append, no throw", async () => {
    await seedConfig(A(), 0);
    const seq = new RecordingSeq();
    const r = await sweepTenantLegacyMirror({ db: A(), seq, feed: new StaticFeed(null), integrationId: LEGACY_MIRROR_INTEGRATION_ID, tenant: "tenant-a", now: 1_000 });
    expect(r.configured).toBe(true);
    expect(r.appended).toBe(0);
  });
});

// §1588 (REQ-021/025/118) — THE WATERMARK ADVANCE IS A PATH WRITE, NOT A COLUMN REWRITE.
//
// `integrations.config` has TWO writers. The translator's `allocatePartnerControls` mutates `$.outbound` with
// its own `json_set` — atomic, server-side, sibling-safe. This sweep used to read the whole column, merge the
// new watermark in memory and write the ENTIRE object back, silently reverting anything that landed between its
// read and its write. The sweep scans, maps and appends per row in that window, so the window is wide and the
// loser is an operator action: a partner certification that simply vanishes.
//
// Same class as §1587's `device_keys` lost update, different remedy: there the whole array is the unit, so a
// compare-and-set is right; here only one path changes, so `json_set` is better — it cannot lose a sibling key
// under ANY schedule, where a retry only narrows the window.
//
// THE INTERLEAVING IS FORCED, NOT AWAITED. A first draft issued the sibling write concurrently with the sweep
// and passed 3/3 against the BROKEN code — the write simply landed before the sweep read its config, so the
// in-memory merge preserved it and nothing was proved. `FeedReader.read()` is called AFTER the config read and
// BEFORE the watermark write, so a feed that performs the sibling write puts it exactly in the window. No race,
// no flake: the schedule is the test's, not the scheduler's.
class SiblingWritingFeed implements FeedReader {
  constructor(
    private readonly text: string,
    private readonly db: D1Database,
  ) {}
  async read(): Promise<string | null> {
    await this.db
      .prepare("UPDATE integrations SET config = json_set(config, '$.outbound', json_object('isa', 7)) WHERE id = ?")
      .bind(LEGACY_MIRROR_INTEGRATION_ID)
      .run();
    return this.text;
  }
}

// §1651 — THE OTHER HALF OF §1588's WRITE: the advance must be MONOTONIC IN THE DATABASE, not just in this
// process. `maxCursor` starts at the config's own watermark and only grows, and line ~283 refuses to write
// unless it grew — so a single sweep can never regress its own cursor, and that JS guard is what the existing
// cases exercise. The `WHERE … COALESCE(cursor, -1) < ?1` defends a case those cannot reach: TWO sweeps, where
// a SLOW one computed a low cursor before a FAST one wrote a high one, and lands its UPDATE afterwards.
//
// MEASURED at §1651: deleting that WHERE clause left the whole worker suite 147/147 GREEN — a guard with no
// test, which §1634 records as the shape that eventually gets deleted by someone doing everything right.
// The consequence is bounded (the DO dedupes by deterministic id, so a re-scan re-appends nothing) but real:
// the watermark moves backwards, so the next sweeps re-read rows the mirror already has, indefinitely.
//
// The same seam §1588 used makes the schedule the test's rather than the scheduler's: `read()` runs AFTER the
// config read and BEFORE the watermark write, so a feed that advances the watermark there puts the fast sweep
// exactly inside the slow one's window.
class WatermarkAdvancingFeed implements FeedReader {
  constructor(
    private readonly text: string,
    private readonly db: D1Database,
  ) {}
  async read(): Promise<string | null> {
    await this.db
      .prepare("UPDATE integrations SET config = json_set(config, '$.legacy_mirror.watermark', json_object('cursor', ?1)) WHERE id = ?2")
      .bind(9_999, LEGACY_MIRROR_INTEGRATION_ID)
      .run();
    return this.text;
  }
}

describe("§1651 REQ-021 — the watermark advance is monotonic in the DATABASE, not merely in this process", () => {
  it("a sweep whose cursor was computed BEFORE a faster sweep's write cannot drag the watermark backwards", async () => {
    await seedConfig(B(), 0); // this sweep reads 0 and will compute a small cursor from the export
    const seq = new RecordingSeq();
    const r = await sweepTenantLegacyMirror({
      db: B(), seq, feed: new WatermarkAdvancingFeed(genericExport, B()), integrationId: LEGACY_MIRROR_INTEGRATION_ID, tenant: "tenant-b", now: 1_000,
    });
    expect(r.configured, "setup: the sweep must actually run for its write to be under test").toBe(true);

    expect(
      await readWatermark(B()),
      "the watermark REGRESSED: a slow sweep's UPDATE overwrote a faster sweep's higher cursor, so every " +
        "later tick re-reads rows the mirror already holds. The advance must be conditional in SQL — a JS " +
        "`maxCursor > cfg.watermark` check cannot see a write that landed after this process read its config.",
    ).toBe(9_999);
  });
});

describe("§1588 REQ-021 — a concurrent writer's key on integrations.config survives the watermark advance", () => {
  it("a sibling `$.outbound` write landing INSIDE the sweep's window is not reverted, and the watermark advances", async () => {
    await seedConfig(B(), 0);
    const seq = new RecordingSeq();
    const r = await sweepTenantLegacyMirror({
      db: B(), seq, feed: new SiblingWritingFeed(genericExport, B()), integrationId: LEGACY_MIRROR_INTEGRATION_ID, tenant: "tenant-b", now: 1_000,
    });
    expect(r.configured, "setup: the sweep must actually run for its write to be under test").toBe(true);

    const row = await B().prepare("SELECT config FROM integrations WHERE id = ?").bind(LEGACY_MIRROR_INTEGRATION_ID).first<{ config: string }>();
    const cfg = JSON.parse(row!.config) as { outbound?: { isa?: number }; legacy_mirror: { watermark: { cursor: number } } };

    expect(
      cfg.outbound?.isa,
      "the concurrent partner-control write was REVERTED — the sweep wrote back a `config` it had read before " +
        "that write landed. An operator's certification disappears with nothing logged.",
    ).toBe(7);
    expect(cfg.legacy_mirror.watermark.cursor, "the sweep must still advance its own watermark").toBeGreaterThan(0);
  });
});
