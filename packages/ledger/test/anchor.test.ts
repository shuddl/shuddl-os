import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { EventKind, LedgerEvent } from "@shuddl/contracts";
import { applyMigrations } from "../src/migrate.js";
import { anchorProof, canonicalPositionBytes, dayOf, runDailyAnchor, type PositionRow } from "../src/anchor.js";
import { bytesToHex, hexToBytes, merkleRoot, verifyInclusion } from "../src/merkle.js";
import { parseTimeStampResp } from "../src/tsa/der.js";
import { FakeTsaClient, type TsaClient } from "../src/tsa/client.js";
import { sha256Hex } from "../src/canonical.js";
import { eventInsertStmt, mkEvent, resetEventCounter } from "./helpers.js";
import ledgerCore from "../../../db/tenant/migrations/0001_ledger_core.sql?raw";
import domain from "../../../db/tenant/migrations/0002_domain.sql?raw";
import insertGuards from "../../../db/tenant/migrations/0003_insert_guards.sql?raw";
import partyRefsGuard from "../../../db/tenant/migrations/0004_party_refs_guard.sql?raw";

// REQ-014 — the daily Merkle -> TSA anchor. vitest-pool-workers isolates storage PER TEST (each it's
// D1 + R2 writes roll back at its end), so every test seeds its own day-scoped rows.

const DB = env.TENANT_A_DB;
const R2 = env.EVIDENCE;
const TENANT = "tenant-a";
const FIRE = (): Date => new Date("2026-07-10T01:00:00Z"); // anchors up to 2026-07-09
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const noon = (day: string): number => Date.parse(`${day}T12:00:00.000Z`);

async function seed(kind: EventKind, over: Partial<LedgerEvent>): Promise<LedgerEvent> {
  const e = mkEvent(kind, over);
  await eventInsertStmt(DB, e).run();
  return e;
}

async function insertPosition(row: PositionRow, recordedAt: number): Promise<void> {
  const hash = await sha256Hex(canonicalPositionBytes(row));
  await DB.prepare(
    "INSERT INTO positions (shipment_id, device_id, ts, recorded_at, lat_e6, lon_e6, accuracy_m, speed_cms, hash) VALUES (?,?,?,?,?,?,?,?,?)",
  )
    .bind(row.shipment_id, row.device_id, row.ts, recordedAt, row.lat_e6, row.lon_e6, row.accuracy_m, row.speed_cms, hash)
    .run();
}

async function anchorHash(day: string): Promise<string | null> {
  const r = await DB.prepare("SELECT hash FROM documents WHERE id = ?").bind(`anchor:${day}`).first<{ hash: string }>();
  return r?.hash ?? null;
}

const failingTsa: TsaClient = { timestamp: () => Promise.reject(new Error("TSA_DOWN")) };

beforeAll(async () => {
  resetEventCounter();
  await applyMigrations(DB, [
    { path: "0001_ledger_core.sql", sql: ledgerCore },
    { path: "0002_domain.sql", sql: domain },
    { path: "0003_insert_guards.sql", sql: insertGuards },
    { path: "0004_party_refs_guard.sql", sql: partyRefsGuard },
  ]);
});

describe("REQ-014 DoD — a POD hash verifies against a TSA receipt", () => {
  it("REQ-014 DoD: a pod.signed hash verifies against the day's TSA-stamped root, and the receipt imprint binds that root", async () => {
    const day = "2026-07-09";
    await seed("stop.arrived", { stream_id: "s:dod", shipment_id: "dod", seq: 0, recorded_at: noon(day) });
    await seed("freight.counted", { stream_id: "s:dod", shipment_id: "dod", seq: 1, recorded_at: noon(day) });
    const pod = await seed("pod.signed", { stream_id: "s:dod", shipment_id: "dod", seq: 2, recorded_at: noon(day) });

    const res = await runDailyAnchor({ db: DB, r2: R2, tsa: new FakeTsaClient(), tenant: TENANT, now: FIRE });
    expect(res.anchored).toContain(day);

    // 1) the POD hash is provably in the anchored root
    const proof = await anchorProof(DB, day, pod.hash!);
    expect(await verifyInclusion(hexToBytes(pod.hash!), proof.steps, hexToBytes(proof.root))).toBe(true);

    // 2) the TSA receipt in R2 stamped the imprint that binds exactly this root + leaf count
    const obj = await R2.get(`anchors/${TENANT}/${day}/tsr.der`);
    expect(obj).not.toBeNull();
    const receipt = parseTimeStampResp(await obj!.arrayBuffer());
    expect(receipt.granted).toBe(true);
    const expectedImprint = await sha256Hex(utf8(`shuddl-anchor-v1:${TENANT}:${day}:${proof.root}:${proof.leafCount}`));
    expect(receipt.imprintDigestHex).toBe(expectedImprint);
  });
});

describe("REQ-014 — determinism, bucketing, gaps, failures, positions", () => {
  it("determinism: two runs -> identical root; the re-run is a no-op (INSERT OR IGNORE doc row)", async () => {
    const day = "2026-07-09";
    await seed("stop.arrived", { stream_id: "s:det", shipment_id: "det", seq: 0, recorded_at: noon(day) });

    const res1 = await runDailyAnchor({ db: DB, r2: R2, tsa: new FakeTsaClient(), tenant: TENANT, now: FIRE });
    expect(res1.anchored).toContain(day);
    const root1 = await anchorHash(day);

    const res2 = await runDailyAnchor({ db: DB, r2: R2, tsa: new FakeTsaClient(), tenant: TENANT, now: FIRE });
    expect(res2.anchored).not.toContain(day);
    expect(res2.skipped).toContain(day);
    expect(await anchorHash(day)).toBe(root1); // unchanged
  });

  it("late upload: yesterday's ts but today's recorded_at lands in TODAY's tree; yesterday's root excludes it", async () => {
    const inDay = await seed("stop.arrived", { stream_id: "s:late-in", shipment_id: "late-in", seq: 0, recorded_at: noon("2026-07-09"), ts: Date.parse("2026-07-09T09:00:00Z") });
    // a late/airplane-mode upload: physical ts on 07-09, but recorded_at (server clock) is 07-10 (today)
    await seed("pod.signed", { stream_id: "s:late-up", shipment_id: "late-up", seq: 0, recorded_at: noon("2026-07-10"), ts: Date.parse("2026-07-09T23:00:00Z") });

    const res = await runDailyAnchor({ db: DB, r2: R2, tsa: new FakeTsaClient(), tenant: TENANT, now: FIRE });
    expect(res.anchored).toContain("2026-07-09");
    expect(res.anchored).not.toContain("2026-07-10"); // today is never anchored

    // 07-09's root is JUST the in-day event — the late upload (recorded_at 07-10) is excluded
    const expected = bytesToHex(await merkleRoot([hexToBytes(inDay.hash!)]));
    expect(await anchorHash("2026-07-09")).toBe(expected);
    expect(await anchorHash("2026-07-10")).toBeNull();
  });

  it("empty day still anchors (gap-free day chain): the empty tree = SHA-256(\"\")", async () => {
    await seed("stop.arrived", { stream_id: "s:gap-7", shipment_id: "gap-7", seq: 0, recorded_at: noon("2026-07-07") });
    await seed("stop.arrived", { stream_id: "s:gap-9", shipment_id: "gap-9", seq: 0, recorded_at: noon("2026-07-09") });

    const res = await runDailyAnchor({ db: DB, r2: R2, tsa: new FakeTsaClient(), tenant: TENANT, now: FIRE });
    expect(res.anchored).toEqual(["2026-07-07", "2026-07-08", "2026-07-09"]); // 07-08 has NO rows, still anchored
    expect(await anchorHash("2026-07-08")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("TSA failure leaves the day unanchored + retried; 3 consecutive failures escalate to a critical anomaly, cleared on success", async () => {
    const day = "2026-07-09";
    await seed("stop.arrived", { stream_id: "s:fail", shipment_id: "fail", seq: 0, recorded_at: noon(day) });

    for (let i = 1; i <= 3; i++) {
      const res = await runDailyAnchor({ db: DB, r2: R2, tsa: failingTsa, tenant: TENANT, now: FIRE });
      expect(res.failed).toContain(day);
      expect(await anchorHash(day)).toBeNull(); // never anchored on failure
    }
    const anomaly = await DB.prepare("SELECT severity, detail FROM anomalies WHERE id = ?").bind(`anchor-tsa:${TENANT}:${day}`).first<{ severity: string; detail: string }>();
    expect(anomaly?.severity).toBe("critical");
    expect((JSON.parse(anomaly!.detail) as { consecutive: number }).consecutive).toBe(3);

    // recovery: a working TSA anchors the day and clears the failure marker
    const ok = await runDailyAnchor({ db: DB, r2: R2, tsa: new FakeTsaClient(), tenant: TENANT, now: FIRE });
    expect(ok.anchored).toContain(day);
    expect(await anchorHash(day)).not.toBeNull();
    const cleared = await DB.prepare("SELECT 1 AS x FROM anomalies WHERE id = ?").bind(`anchor-tsa:${TENANT}:${day}`).first();
    expect(cleared).toBeNull();
  });

  it("positions participate: a day with ONLY positions produces a stable root (positions hash in like everything else)", async () => {
    const day = "2026-07-09";
    const row: PositionRow = { shipment_id: "pos-ship", device_id: "dev-1", ts: 1_720_000_000_000, lat_e6: 37_421_000, lon_e6: -122_084_000, accuracy_m: 5, speed_cms: null };
    await insertPosition(row, noon(day));

    const res = await runDailyAnchor({ db: DB, r2: R2, tsa: new FakeTsaClient(), tenant: TENANT, now: FIRE });
    expect(res.anchored).toContain(day);
    const expected = bytesToHex(await merkleRoot([canonicalPositionBytes(row)]));
    expect(await anchorHash(day)).toBe(expected);

    // the position's own canonical-bytes leaf verifies against the anchored root
    const leafHex = bytesToHex(canonicalPositionBytes(row));
    const proof = await anchorProof(DB, day, leafHex);
    expect(await verifyInclusion(canonicalPositionBytes(row), proof.steps, hexToBytes(proof.root))).toBe(true);
  });

  it("dayOf buckets on the UTC calendar day", () => {
    expect(dayOf(Date.parse("2026-07-09T23:59:59.999Z"))).toBe("2026-07-09");
    expect(dayOf(Date.parse("2026-07-10T00:00:00.000Z"))).toBe("2026-07-10");
  });
});
