import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { LedgerEvent, PodSignedPayload } from "@shuddl/contracts";
import { applyMigrations } from "../src/migrate.js";
import { projectPassport } from "../src/projection/passports.js";
import { projectStatusCache } from "../src/projection/status-cache.js";
import { eventInsertStmt, mkEvent, resetEventCounter } from "./helpers.js";
import ledgerCore from "../../../db/tenant/migrations/0001_ledger_core.sql?raw";
import domain from "../../../db/tenant/migrations/0002_domain.sql?raw";
import insertGuards from "../../../db/tenant/migrations/0003_insert_guards.sql?raw";

// NOTE: vitest-pool-workers isolates storage PER TEST — each `it`'s writes are rolled back at its
// end (only beforeAll writes persist as the base). So every test here seeds its own shipment/party.

const DB = env.TENANT_A_DB;

async function seedParty(id: string): Promise<void> {
  await DB.prepare("INSERT OR IGNORE INTO parties (id, kind, names) VALUES (?, 'carrier', '[]')").bind(id).run();
}
async function appendStatus(e: LedgerEvent): Promise<void> {
  await DB.batch([eventInsertStmt(DB, e), ...projectStatusCache(DB, e)]);
}
async function appendPassport(e: LedgerEvent): Promise<void> {
  await DB.batch([eventInsertStmt(DB, e), ...projectPassport(DB, e)]);
}
async function statusCache(shipmentId: string): Promise<Record<string, unknown> | null> {
  const r = await DB.prepare("SELECT status_cache AS s FROM shipments WHERE id = ?").bind(shipmentId).first<{ s: string }>();
  return r === null ? null : (JSON.parse(r.s) as Record<string, unknown>);
}
async function scores(partyId: string): Promise<Record<string, number> | null> {
  const r = await DB.prepare("SELECT scores AS s FROM passports WHERE party_id = ?").bind(partyId).first<{ s: string }>();
  return r === null ? null : (JSON.parse(r.s) as Record<string, number>);
}
function booking(shipmentId: string, division = "north"): LedgerEvent {
  return mkEvent("booking.created", {
    stream_id: `s:${shipmentId}`,
    shipment_id: shipmentId,
    payload: { division, shipper_party_id: "p-ship", consignee_party_id: "p-cons", bill_to_party_id: "p-bill", created_ts: 1_720_000_000_000 },
  });
}

beforeAll(async () => {
  resetEventCounter();
  await applyMigrations(DB, [
    { path: "0001_ledger_core.sql", sql: ledgerCore },
    { path: "0002_domain.sql", sql: domain },
    { path: "0003_insert_guards.sql", sql: insertGuards },
  ]);
});

describe("REQ-015 / audit#11 — status_cache is the projection the driver lens + OFD depend on", () => {
  it("booking.created UPSERTS the shipments row itself (id/division/parties) then sets state=booked", async () => {
    await appendStatus(booking("shp-1"));
    const row = await DB.prepare(
      "SELECT division, shipper_party_id, consignee_party_id, bill_to_party_id FROM shipments WHERE id = 'shp-1'",
    ).first<{ division: string; shipper_party_id: string; consignee_party_id: string; bill_to_party_id: string }>();
    expect(row).toEqual({ division: "north", shipper_party_id: "p-ship", consignee_party_id: "p-cons", bill_to_party_id: "p-bill" });
    expect((await statusCache("shp-1"))?.state).toBe("booked");
  });

  it("full lifecycle: dispatched(+assigned_driver) -> in_transit -> OFD -> delivered", async () => {
    await appendStatus(booking("shp-1")); // seq 0

    await appendStatus(mkEvent("dispatch.assigned", { stream_id: "s:shp-1", shipment_id: "shp-1", seq: 1, actor: { party: "p-ops", user: "driver-1" } }));
    let sc = await statusCache("shp-1");
    expect(sc?.state).toBe("dispatched");
    expect(sc?.assigned_driver).toBe("driver-1");
    // The driver lens finds the shipment ONLY because the projection wrote assigned_driver.
    const found = await DB.prepare("SELECT id FROM shipments WHERE json_extract(status_cache,'$.assigned_driver') = 'driver-1'").first<{ id: string }>();
    expect(found?.id).toBe("shp-1");

    await appendStatus(mkEvent("custody.transferred", { stream_id: "s:shp-1", shipment_id: "shp-1", seq: 2 }));
    expect((await statusCache("shp-1"))?.state).toBe("in_transit");

    await appendStatus(mkEvent("stop.departed", { stream_id: "s:shp-1", shipment_id: "shp-1", seq: 3, payload: { out_for_delivery: true } }));
    // The lens predicate is json_extract(...)=1; prove it directly.
    const ofd = await DB.prepare("SELECT id FROM shipments WHERE id='shp-1' AND json_extract(status_cache,'$.out_for_delivery') = 1").first<{ id: string }>();
    expect(ofd?.id).toBe("shp-1");

    await appendStatus(mkEvent("pod.signed", { stream_id: "s:shp-1", shipment_id: "shp-1", seq: 4 }));
    sc = await statusCache("shp-1");
    expect(sc?.state).toBe("delivered");
    expect(sc?.assigned_driver).toBe("driver-1"); // earlier projection fields survive later json_set
  });

  it("a plain stop.departed (no flag) does NOT flip out_for_delivery (v1 rule)", async () => {
    await appendStatus(booking("shp-3"));
    await appendStatus(mkEvent("stop.departed", { stream_id: "s:shp-3", shipment_id: "shp-3", seq: 1, payload: {} }));
    expect((await statusCache("shp-3"))?.out_for_delivery).toBeUndefined();
  });

  it("exception.raised -> state=exception (the pulse the map dims on)", async () => {
    await appendStatus(booking("shp-2", "south"));
    await appendStatus(mkEvent("exception.raised", { stream_id: "s:shp-2", shipment_id: "shp-2", seq: 1 }));
    expect((await statusCache("shp-2"))?.state).toBe("exception");
  });

  it("non-projecting kinds leave status_cache untouched", async () => {
    await appendStatus(booking("shp-4"));
    const before = await statusCache("shp-4");
    await appendStatus(mkEvent("message.sent", { stream_id: "s:shp-4", shipment_id: "shp-4", seq: 1 }));
    expect(await statusCache("shp-4")).toEqual(before);
  });
});

describe("REQ-009 — passports accrue from events (mutable projection; truth stays in the events)", () => {
  beforeAll(async () => {
    await seedParty("party-carrier");
    await seedParty("party-osd");
  });

  it("pod.signed accrues scores.deliveries; a party with no passport row gets one (upsert, accrue not overwrite)", async () => {
    expect(await scores("party-carrier")).toBeNull(); // no passport yet (rows created here roll back after)
    await appendPassport(mkEvent("pod.signed", { stream_id: "s:shp-p1", shipment_id: "shp-p1" }));
    expect((await scores("party-carrier"))?.deliveries).toBe(1);
    await appendPassport(mkEvent("pod.signed", { stream_id: "s:shp-p2", shipment_id: "shp-p2" }));
    expect((await scores("party-carrier"))?.deliveries).toBe(2);
  });

  it("exception.raised/osd.captured/custody.transferred accrue their counters and coexist on one party", async () => {
    await appendPassport(mkEvent("exception.raised", { stream_id: "s:shp-p3", shipment_id: "shp-p3", actor: { party: "party-carrier" } }));
    await appendPassport(mkEvent("custody.transferred", { stream_id: "s:shp-p5", shipment_id: "shp-p5" })); // fixture actor = party-carrier
    await appendPassport(mkEvent("osd.captured", { stream_id: "s:shp-p4", shipment_id: "shp-p4", actor: { party: "party-osd" } }));
    const carrier = await scores("party-carrier");
    expect(carrier?.exceptions).toBe(1);
    expect(carrier?.custody_events).toBe(1); // multiple counters merge in one scores object
    expect((await scores("party-osd"))?.claims_opened).toBe(1);
  });

  // GUARD (type-level): OTD accrual was deliberately removed (deferred to WP-08 — the appointment
  // window that defines on-time is the Scheduler's, and PodSignedPayload has no schema-valid on_time
  // field). This asserts that ABSENCE at the type level: if a future change adds `on_time` to the
  // contract, `HasOnTime` flips to `true`, `const _guard: HasOnTime = false` stops compiling, and the
  // build fails HERE — forcing whoever adds the field to also restore the accrual in passports.ts.
  type HasOnTime = "on_time" extends keyof PodSignedPayload ? true : false;
  it("PodSignedPayload has NO on_time field, so pod.signed accrues ONLY deliveries (OTD deferred to WP-08)", () => {
    const _guard: HasOnTime = false; // ← breaks the build if on_time is ever added to the contract
    expect(_guard).toBe(false);
    // And the runtime projection posts exactly one accrual (deliveries), never an on_time counter.
    const e = mkEvent("pod.signed", { stream_id: "s:shp-p6", shipment_id: "shp-p6" });
    expect(projectPassport(DB, e)).toHaveLength(1);
  });

  it("REQ-009 FK: accruing for an UNSEEDED party aborts the whole append (party must exist first)", async () => {
    const e = mkEvent("pod.signed", { stream_id: "s:shp-p7", shipment_id: "shp-p7", actor: { party: "party-GHOST", user: "u", device: "d" } });
    await expect(DB.batch([eventInsertStmt(DB, e), ...projectPassport(DB, e)])).rejects.toThrow();
    // The batch is atomic: neither the passport NOR the event survived the FK abort.
    expect(await scores("party-GHOST")).toBeNull();
    const evt = await DB.prepare("SELECT COUNT(*) AS c FROM events WHERE id = ?").bind(e.id).first<{ c: number }>();
    expect(evt?.c).toBe(0);
  });
});
