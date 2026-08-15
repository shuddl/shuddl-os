import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/migrate.js";
import ledgerCore from "../../../db/tenant/migrations/0001_ledger_core.sql?raw";
import domain from "../../../db/tenant/migrations/0002_domain.sql?raw";
import insertGuards from "../../../db/tenant/migrations/0003_insert_guards.sql?raw";
import uniqueGuards from "../../../db/tenant/migrations/0008_append_only_unique_guards.sql?raw";

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

// A money_lines row (append-only projection, I1). event_id is a FK into events(id), so the
// two events it points at must already exist. corrects_event_id is a free TEXT (no FK) that
// feeds the ux_ml_corrects UNIQUE INDEX (corrects_event_id, line_no) WHERE corrects_event_id IS NOT NULL.
function moneyLineRow(over: Row = {}): Row {
  return {
    id: `ml-${(n += 1)}`,
    shipment_id: "ship1",
    event_id: "mlE-a",
    line_no: 1,
    direction: "ar",
    kind: "correction_credit",
    amount_cents: 100,
    currency: "USD",
    party_id: "p:acme",
    division: "main",
    gl_map: "{}",
    created_ts: 1000,
    ...over,
  };
}
function moneyLineStmt(verb: "INSERT" | "INSERT OR REPLACE", row: Row): D1PreparedStatement {
  const c = Object.keys(row);
  return DB.prepare(`${verb} INTO money_lines (${c.join(", ")}) VALUES (${c.map(() => "?").join(", ")})`).bind(...Object.values(row));
}

beforeAll(async () => {
  // 0003's money_lines_guard_ins references the money_lines table (0002), so the full tenant
  // migration set is applied here; the events/positions assertions below are unaffected by it.
  await applyMigrations(DB, [
    { path: "0001_ledger_core.sql", sql: ledgerCore },
    { path: "0002_domain.sql", sql: domain },
    { path: "0003_insert_guards.sql", sql: insertGuards },
    // 0008 adds the events.hash / ux_events_device and money_lines ux_ml_corrects BEFORE INSERT guards.
    { path: "0008_append_only_unique_guards.sql", sql: uniqueGuards },
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

// Task 5 (REQ-002, REQ-011, I3, I1): 0003's events_guard_ins WHEN-clause enumerated ONLY (stream_id, seq)
// and id; it OMITTED the `hash` UNIQUE column and the ux_events_device UNIQUE index. money_lines_guard_ins
// omitted ux_ml_corrects. So an out-of-band INSERT OR REPLACE colliding ONLY on one of those un-enumerated
// keys (not on the enumerated PK/id) slipped past the BEFORE INSERT guard, and — with recursive_triggers=0
// — REPLACE's implicit DELETE (which never fires the BEFORE DELETE guard) SILENTLY erased the chained
// victim row. Migration 0008 enumerates every remaining uniqueness surface, so each collision now aborts
// and the victim stays byte-for-byte intact.
describe("Task 5 — REPLACE cannot destroy a row through an UNENUMERATED unique key (0008)", () => {
  const cols =
    "stream_id, seq, id, shipment_id, ts, recorded_at, kind, actor_party_id, prev_hash, hash, visibility";
  const devCols = `${cols}, device_id, device_seq`;

  it("INSERT OR REPLACE colliding ONLY on the events.hash UNIQUE is aborted; the victim is byte-for-byte intact", async () => {
    await insertEvent(eventRow({ seq: 80, id: "hash-victim", hash: "a".repeat(64) }));
    const before = await DB.prepare("SELECT * FROM events WHERE id = 'hash-victim'").first();
    await expect(
      DB.prepare(
        // same hash, but a fresh (stream_id, seq) and a fresh id: the ONLY collision is events.hash UNIQUE
        `INSERT OR REPLACE INTO events (${cols}) VALUES ('s:ship1', 81, 'hash-attacker', 'ship1', 2000, 2000, 'quote.priced', 'p:evil', ?, ?, 'internal')`,
      )
        .bind("0".repeat(64), "a".repeat(64))
        .run(),
    ).rejects.toThrow(/I3/);
    const after = await DB.prepare("SELECT * FROM events WHERE id = 'hash-victim'").first();
    expect(after).toEqual(before); // present + byte-for-byte unchanged, NOT replaced by the attacker
    expect((after as { seq: number } | null)?.seq).toBe(80);
  });

  it("INSERT OR REPLACE colliding ONLY on ux_events_device (stream_id, device_id, device_seq) is aborted; victim intact", async () => {
    await insertEvent(eventRow({ seq: 70, id: "dev-victim", device_id: "dev-X", device_seq: 9 }));
    const before = await DB.prepare("SELECT * FROM events WHERE id = 'dev-victim'").first();
    await expect(
      DB.prepare(
        // fresh seq/id/hash — the ONLY collision is the ux_events_device tuple (s:ship1, dev-X, 9)
        `INSERT OR REPLACE INTO events (${devCols}) VALUES ('s:ship1', 71, 'dev-attacker', 'ship1', 2000, 2000, 'quote.priced', 'p:evil', ?, ?, 'internal', 'dev-X', 9)`,
      )
        .bind("0".repeat(64), "d".repeat(64))
        .run(),
    ).rejects.toThrow(/I3/);
    const after = await DB.prepare("SELECT * FROM events WHERE id = 'dev-victim'").first();
    expect(after).toEqual(before);
    expect((after as { seq: number } | null)?.seq).toBe(70);
  });

  it("INSERT OR REPLACE colliding ONLY on ux_ml_corrects (corrects_event_id, line_no) is aborted; victim intact", async () => {
    await insertEvent(eventRow({ seq: 100, id: "mlE-a" }));
    await insertEvent(eventRow({ seq: 101, id: "mlE-b" }));
    await moneyLineStmt("INSERT", moneyLineRow({ id: "ml-victim", event_id: "mlE-a", line_no: 1, corrects_event_id: "CE-1" })).run();
    const before = await DB.prepare("SELECT * FROM money_lines WHERE id = 'ml-victim'").first();
    await expect(
      // fresh id + fresh (event_id, line_no) → the ONLY collision is ux_ml_corrects (CE-1, 1)
      moneyLineStmt("INSERT OR REPLACE", moneyLineRow({ id: "ml-attacker", event_id: "mlE-b", line_no: 1, corrects_event_id: "CE-1" })).run(),
    ).rejects.toThrow(/I1/);
    const after = await DB.prepare("SELECT * FROM money_lines WHERE id = 'ml-victim'").first();
    expect(after).toEqual(before);
    expect((after as { id: string } | null)?.id).toBe("ml-victim");
  });
});

// §915 — THE DB'S OWN DOMAIN CHECKS ON `events`, WHICH NOTHING EXERCISED.
//
// `visibility` and `source` each carry a CHECK (col IN (...)) in 0001_ledger_core.sql, and neutralising
// EITHER to `CHECK (1=1)` left the whole ledger suite green. Found by mutating all 23 D1 CHECK constraints,
// not by reading.
//
// They are not redundant in the way "Zod already validates this" suggests. Zod guards the API boundary, so
// every path that parses a LedgerEvent is covered — but the CHECK is what covers the paths that DON'T: a
// migration backfill, a seed loader, a repair script, a console write. That is the whole point of a
// constraint living in the schema, and it is exactly the layer no test was touching.
//
// Each case inserts a VALID row first (§908): the rejection is then attributable to the one column varied,
// not to anything else the row happens to carry.
describe("§915: the events domain CHECKs refuse an out-of-domain value at the DB, not just at Zod", () => {
  it("visibility must be one of internal|counterparty|public", async () => {
    await insertEvent(eventRow({ seq: 900, id: "vis-ok" })); // control: the same shape inserts cleanly
    await expect(insertEvent(eventRow({ seq: 901, id: "vis-bad", visibility: "everyone" }))).rejects.toThrow(/CHECK/i);
  });
  it("source must be one of native|legacy|edi|email", async () => {
    await insertEvent(eventRow({ seq: 902, id: "src-ok" })); // control
    await expect(insertEvent(eventRow({ seq: 903, id: "src-bad", source: "carrier-pigeon" }))).rejects.toThrow(/CHECK/i);
  });
});

// §1567 (REQ-016/118) — THE PER-STREAM HALF OF THE OFFLINE DEDUPE KEY.
//
// `driver-core/src/merge.ts` dedupes captures by `(shipment_id, device_id, device_seq)` and says it *"MIRRORS
// EXACTLY the unique index the sequencer enforces server-side"*, calling out **"PER-STREAM (WP-05 exit audit):
// the key includes `shipment_id`"**. The block above pins the duplicate refusal and the per-DEVICE half (same
// seq, different device ⇒ admitted). The per-STREAM half had no case: nothing showed that the same device
// replaying the same seq on ANOTHER shipment is admitted rather than swallowed.
//
// It matters in the direction that loses freight. If the server were per-DEVICE rather than per-STREAM, a
// driver whose seq counter is monotonic ACROSS shipments would have captures on a second load silently refused
// as duplicates — a signed POD that never lands, on the surface with no operator watching.
//
// WHAT THIS DOES NOT PIN, stated because measuring it corrected me: single-guard mutations SURVIVE here. The
// invariant has two enforcers — `ux_events_device` UNIQUE (0001) and the BEFORE-INSERT trigger
// `events_guard_ins_unique` (0008, which D1 needs because `recursive_triggers=0`) — so dropping either alone
// leaves the other catching the duplicate. Removing BOTH reds the block above. That is defence in depth working,
// and a surviving single mutation here means REDUNDANCY, not absence.
describe("§1567 REQ-016: the offline dedupe key is per-STREAM, so a device may reuse a seq on another shipment", () => {
  it("the same (device, seq) on a DIFFERENT stream is ACCEPTED", async () => {
    await insertEvent(eventRow({ stream_id: "s:dedupe-2", shipment_id: "dedupe-2", seq: 0, device_id: "dev-B", device_seq: 3 }));
    const r = await insertEvent(eventRow({ stream_id: "s:dedupe-3", shipment_id: "dedupe-3", seq: 0, device_id: "dev-B", device_seq: 3 }));
    expect(
      r.success,
      "the same device+seq on another shipment was refused — the server is per-DEVICE, not per-STREAM, and a " +
        "driver with a monotonic counter would lose captures on every load after the first",
    ).toBe(true);
  });
});
