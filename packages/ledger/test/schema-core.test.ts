import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/migrate.js";
import ledgerCore from "../../../db/tenant/migrations/0001_ledger_core.sql?raw";
import domain from "../../../db/tenant/migrations/0002_domain.sql?raw";
import insertGuards from "../../../db/tenant/migrations/0003_insert_guards.sql?raw";

// Task 2 (REQ-011, REQ-002, I3): events + positions against a REAL D1 (pool-workers),
// proving the append-only guards, the composite PK, the stream_id/shipment_id CHECK,
// and the offline device dedupe index — not mocks.
const DB = env.TENANT_A_DB;

// Distinct id + hash per row so uniqueness collisions in a test can only come from the
// key we are actually asserting (PK / device index), never from an accidental hash clash.
let n = 0;
type Row = Record<string, unknown>;
function eventRow(over: Row = {}): Row {
  n += 1;
  const merged: Row = {
    stream_id: "s:ship1",
    seq: 0,
    id: `evt-${n}`,
    shipment_id: "ship1",
    ts: 1000,
    recorded_at: 1000,
    kind: "quote.requested",
    actor_party_id: "p:acme",
    prev_hash: "0".repeat(64),
    visibility: "internal",
    source: "native",
    ...over,
  };
  if (merged.hash === undefined) merged.hash = n.toString(16).padStart(64, "0");
  return merged;
}

async function insertEvent(row: Row): Promise<D1Result> {
  const cols = Object.keys(row);
  const sql = `INSERT INTO events (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
  return DB.prepare(sql).bind(...Object.values(row)).run();
}

async function insertPosition(deviceId: string): Promise<D1Result> {
  return DB.prepare(
    "INSERT INTO positions (shipment_id, device_id, ts, recorded_at, lat_e6, lon_e6, hash) VALUES ('ship1', ?, 1, 1, 100, 200, 'h')",
  )
    .bind(deviceId)
    .run();
}

beforeAll(async () => {
  // 0003's money_lines_guard_ins references the money_lines table (0002), so the full tenant
  // migration set is applied here; the events/positions assertions below are unaffected by it.
  await applyMigrations(DB, [
    { path: "0001_ledger_core.sql", sql: ledgerCore },
    { path: "0002_domain.sql", sql: domain },
    { path: "0003_insert_guards.sql", sql: insertGuards },
  ]);
});

describe("Task 2 — events append-only guards (I3)", () => {
  it("UPDATE events is aborted by the guard trigger", async () => {
    await insertEvent(eventRow({ seq: 10 }));
    await expect(DB.prepare("UPDATE events SET payload = '{tampered}' WHERE seq = 10").run()).rejects.toThrow(/I3/);
  });
  it("DELETE events is aborted by the guard trigger", async () => {
    await insertEvent(eventRow({ seq: 11 }));
    await expect(DB.prepare("DELETE FROM events WHERE seq = 11").run()).rejects.toThrow(/I3/);
  });
  it("UPDATE positions is aborted by the guard trigger", async () => {
    await insertPosition("d-upd");
    await expect(DB.prepare("UPDATE positions SET lat_e6 = 999 WHERE device_id = 'd-upd'").run()).rejects.toThrow(/I3/);
  });
  it("DELETE positions is aborted by the guard trigger", async () => {
    await insertPosition("d-del");
    await expect(DB.prepare("DELETE FROM positions WHERE device_id = 'd-del'").run()).rejects.toThrow(/I3/);
  });
});

describe("Task 2 — events keys & CHECKs (REQ-011)", () => {
  it("rejects a duplicate (stream_id, seq)", async () => {
    await insertEvent(eventRow({ seq: 20 }));
    await expect(insertEvent(eventRow({ seq: 20 }))).rejects.toThrow();
  });
  it("CHECK rejects a stream_id / shipment_id mismatch", async () => {
    await expect(insertEvent(eventRow({ seq: 21, stream_id: "s:other", shipment_id: "ship1" }))).rejects.toThrow();
  });
  it("admits a shipment-less stream (shipment_id NULL, e.g. agent.acted / quote.*)", async () => {
    const r = await insertEvent(eventRow({ seq: 22, stream_id: "t:root", shipment_id: null, kind: "agent.acted" }));
    expect(r.success).toBe(true);
  });
  it("rejects a duplicate (stream_id, device_id, device_seq) — offline dedupe", async () => {
    await insertEvent(eventRow({ seq: 30, device_id: "dev-A", device_seq: 5 }));
    await expect(insertEvent(eventRow({ seq: 31, device_id: "dev-A", device_seq: 5 }))).rejects.toThrow();
  });
  it("admits the same device_seq on a different device (index is per stream+device)", async () => {
    await insertEvent(eventRow({ seq: 32, device_id: "dev-B", device_seq: 7 }));
    const r = await insertEvent(eventRow({ seq: 33, device_id: "dev-C", device_seq: 7 }));
    expect(r.success).toBe(true);
  });
  it("CHECK rejects device_id present without device_seq", async () => {
    await expect(insertEvent(eventRow({ seq: 34, device_id: "dev-D" }))).rejects.toThrow();
  });
});

// D1 runs PRAGMA recursive_triggers = 0, so INSERT OR REPLACE's implicit DELETE never fires
// the BEFORE DELETE guard — REPLACE could silently rewrite ledger history. The BEFORE INSERT
// guard (migration 0003) closes it: it fires while the old row still exists.
describe("Task 2 fix — REPLACE cannot rewrite history (I3, recursive_triggers=0)", () => {
  const cols =
    "stream_id, seq, id, shipment_id, ts, recorded_at, kind, actor_party_id, prev_hash, hash, visibility";
  it("INSERT OR REPLACE on a (stream_id, seq) collision is aborted", async () => {
    await insertEvent(eventRow({ seq: 40 })); // original at (s:ship1, 40)
    await expect(
      DB.prepare(
        `INSERT OR REPLACE INTO events (${cols}) VALUES ('s:ship1', 40, 'evt-replace', 'ship1', 2000, 2000, 'quote.priced', 'p:evil', ?, ?, 'internal')`,
      )
        .bind("0".repeat(64), "f".repeat(64))
        .run(),
    ).rejects.toThrow(/I3/);
  });
  it("INSERT OR REPLACE on a UNIQUE(id) collision cannot destroy the original row", async () => {
    await insertEvent(eventRow({ seq: 50, id: "victim" })); // (s:ship1, 50), id=victim
    await expect(
      DB.prepare(
        `INSERT OR REPLACE INTO events (${cols}) VALUES ('s:ship1', 51, 'victim', 'ship1', 2000, 2000, 'quote.priced', 'p:evil', ?, ?, 'internal')`,
      )
        .bind("0".repeat(64), "e".repeat(64))
        .run(),
    ).rejects.toThrow(/I3/);
    const row = await DB.prepare("SELECT seq FROM events WHERE id = 'victim'").first<{ seq: number }>();
    expect(row?.seq).toBe(50); // original intact, not replaced by seq 51
  });
  it("INSERT OR REPLACE on positions with different data is aborted", async () => {
    await insertPosition("p-rep"); // hash 'h'
    await expect(
      DB.prepare(
        "INSERT OR REPLACE INTO positions (shipment_id, device_id, ts, recorded_at, lat_e6, lon_e6, hash) VALUES ('ship1', 'p-rep', 1, 1, 999, 999, 'DIFFERENT')",
      ).run(),
    ).rejects.toThrow(/I3/);
  });
  it("a normal INSERT of a genuinely new event still succeeds (happy path — Task 13 appends these)", async () => {
    const r = await insertEvent(eventRow({ seq: 60 }));
    expect(r.success).toBe(true);
  });
});
