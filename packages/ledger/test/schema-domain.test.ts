import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/migrate.js";
import ledgerCore from "../../../db/tenant/migrations/0001_ledger_core.sql?raw";
import domain from "../../../db/tenant/migrations/0002_domain.sql?raw";
import insertGuards from "../../../db/tenant/migrations/0003_insert_guards.sql?raw";
import control from "../../../db/control/migrations/0001_control.sql?raw";

// Task 3 (REQ-011, REQ-057, REQ-009, I1): the 16-table tenant domain + 4-table control
// plane against real D1s — money_lines is an append-only projection (I1 guards + the
// event_id FK, no line without an event) and REQ-057 division columns filter everywhere.
const TDB = env.TENANT_A_DB; // tenant domain (0001 + 0002)
const CDB = env.TENANT_B_DB; // control plane (0001_control)

async function insertBaseEvent(id: string): Promise<void> {
  await TDB.prepare(
    `INSERT INTO events (stream_id, seq, id, shipment_id, ts, recorded_at, kind, actor_party_id, prev_hash, hash, visibility)
     VALUES ('s:S1', 0, ?, 'S1', 1000, 1000, 'invoice.issued', 'p:acme', ?, ?, 'internal')`,
  )
    .bind(id, "0".repeat(64), id.padStart(64, "0"))
    .run();
}

async function insertMoneyLine(over: { event_id: string; line_no: number; division: string }): Promise<D1Result> {
  return TDB.prepare(
    `INSERT INTO money_lines (id, shipment_id, event_id, line_no, direction, kind, amount_cents, party_id, division, gl_map, created_ts)
     VALUES (?, 'S1', ?, ?, 'ar', 'freight', 12345, 'p:acme', ?, '{}', 1000)`,
  )
    .bind(`ml-${over.event_id}-${over.line_no}`, over.event_id, over.line_no, over.division)
    .run();
}

beforeAll(async () => {
  await applyMigrations(TDB, [
    { path: "0001_ledger_core.sql", sql: ledgerCore },
    { path: "0002_domain.sql", sql: domain },
    { path: "0003_insert_guards.sql", sql: insertGuards },
  ]);
  await applyMigrations(CDB, [{ path: "0001_control.sql", sql: control }]);
});

describe("Task 3 — money_lines is an append-only projection (I1)", () => {
  it("UPDATE money_lines is aborted by the guard trigger", async () => {
    await insertBaseEvent("evt-upd");
    await insertMoneyLine({ event_id: "evt-upd", line_no: 0, division: "main" });
    await expect(TDB.prepare("UPDATE money_lines SET amount_cents = 1 WHERE event_id = 'evt-upd'").run()).rejects.toThrow(
      /I1/,
    );
  });
  it("DELETE money_lines is aborted by the guard trigger", async () => {
    await insertBaseEvent("evt-del");
    await insertMoneyLine({ event_id: "evt-del", line_no: 0, division: "main" });
    await expect(TDB.prepare("DELETE FROM money_lines WHERE event_id = 'evt-del'").run()).rejects.toThrow(/I1/);
  });
  it("event_id FK rejects a money_line for an unknown event (no line without event)", async () => {
      // ATTRIBUTED (§906): a bare `.toThrow()` here passed when the row was refused by a NOT NULL instead —
      // proved by rewriting the case so the event EXISTS and `division` is null (39 passed). I1's
      // referential half rests on this FK ALONE (§905: the BEFORE INSERT trigger guards append-only, not
      // existence), so the assertion must name the mechanism or it cannot notice the FK going away.
      await expect(insertMoneyLine({ event_id: "ghost-event", line_no: 0, division: "main" })).rejects.toThrow(
        /FOREIGN KEY/i,
      );
  });
});

// recursive_triggers=0 means REPLACE's implicit DELETE skips the BEFORE DELETE guard; the
// BEFORE INSERT guard (migration 0003) closes it for money_lines (I1) and positions (I3),
// while Decision 14's idempotent INSERT OR IGNORE re-ingest must still succeed.
describe("Task 3 fix — REPLACE / OR IGNORE / upsert interaction with the guards", () => {
  it("INSERT OR REPLACE cannot rewrite a money_line (I1 defeated by REPLACE otherwise)", async () => {
    await insertBaseEvent("evt-mlrep");
    await insertMoneyLine({ event_id: "evt-mlrep", line_no: 0, division: "main" }); // id ml-evt-mlrep-0, amount 12345
    await expect(
      TDB.prepare(
        `INSERT OR REPLACE INTO money_lines (id, shipment_id, event_id, line_no, direction, kind, amount_cents, party_id, division, gl_map, created_ts)
         VALUES ('ml-evt-mlrep-0', 'S1', 'evt-mlrep', 0, 'ar', 'freight', 99999, 'p:evil', 'main', '{}', 2000)`,
      ).run(),
    ).rejects.toThrow(/I1/);
    const row = await TDB.prepare("SELECT amount_cents AS a FROM money_lines WHERE id = 'ml-evt-mlrep-0'").first<{
      a: number;
    }>();
    expect(row?.a).toBe(12345); // original amount intact
  });
  it("INSERT OR IGNORE of a byte-identical position row is idempotent (Decision 14) — succeeds, no dup", async () => {
    await TDB.prepare(
      "INSERT INTO positions (shipment_id, device_id, ts, recorded_at, lat_e6, lon_e6, hash) VALUES ('S1', 'dev-idem', 5, 5, 10, 20, 'samehash')",
    ).run();
    const r = await TDB.prepare(
      "INSERT OR IGNORE INTO positions (shipment_id, device_id, ts, recorded_at, lat_e6, lon_e6, hash) VALUES ('S1', 'dev-idem', 5, 5, 10, 20, 'samehash')",
    ).run();
    expect(r.success).toBe(true);
    const c = await TDB.prepare("SELECT count(*) AS c FROM positions WHERE device_id = 'dev-idem'").first<{ c: number }>();
    expect(c?.c).toBe(1);
  });
  it("INSERT OR IGNORE of a DUPLICATE event is NOT a silent drop — the guard raises loudly (CLAUDE.md rule 10)", async () => {
    await insertBaseEvent("evt-orig");
    // Same (stream_id, seq) as the base event, different id — a would-be overwrite via OR IGNORE.
    await expect(
      TDB.prepare(
        `INSERT OR IGNORE INTO events (stream_id, seq, id, shipment_id, ts, recorded_at, kind, actor_party_id, prev_hash, hash, visibility)
         VALUES ('s:S1', 0, 'evt-dupe', 'S1', 2000, 2000, 'quote.priced', 'p:evil', ?, ?, 'internal')`,
      )
        .bind("0".repeat(64), "d".repeat(64))
        .run(),
    ).rejects.toThrow(/I3/);
  });
  it("upsert (ON CONFLICT DO UPDATE) on events is aborted (regression — the UPDATE guard already blocks it)", async () => {
    await insertBaseEvent("evt-upsert");
    await expect(
      TDB.prepare(
        `INSERT INTO events (stream_id, seq, id, shipment_id, ts, recorded_at, kind, actor_party_id, prev_hash, hash, visibility)
         VALUES ('s:S1', 0, 'evt-upsert-2', 'S1', 3000, 3000, 'quote.priced', 'p:evil', ?, ?, 'internal')
         ON CONFLICT (stream_id, seq) DO UPDATE SET payload = '{evil}'`,
      )
        .bind("0".repeat(64), "c".repeat(64))
        .run(),
    ).rejects.toThrow(/I3/);
  });
});

describe("Task 3 — REQ-057 division columns filter on shipments / money_lines / invoices", () => {
  it("shipments.division filters", async () => {
    for (const [id, division] of [
      ["sh-main", "main"],
      ["sh-west", "west"],
    ]) {
      await TDB.prepare(
        `INSERT INTO shipments (id, division, shipper_party_id, consignee_party_id, bill_to_party_id, created_ts)
         VALUES (?, ?, 'p:a', 'p:b', 'p:c', 1000)`,
      )
        .bind(id, division)
        .run();
    }
    const r = await TDB.prepare("SELECT count(*) AS c FROM shipments WHERE division = 'west'").first<{ c: number }>();
    expect(r?.c).toBe(1);
  });
  it("money_lines.division filters", async () => {
    await insertBaseEvent("evt-div");
    await insertMoneyLine({ event_id: "evt-div", line_no: 0, division: "main" });
    await insertMoneyLine({ event_id: "evt-div", line_no: 1, division: "west" });
    const r = await TDB.prepare("SELECT count(*) AS c FROM money_lines WHERE division = 'west'").first<{ c: number }>();
    expect(r?.c).toBe(1);
  });
  it("invoices.division filters", async () => {
    for (const [id, division] of [
      ["inv-main", "main"],
      ["inv-west", "west"],
    ]) {
      await TDB.prepare(
        `INSERT INTO invoices (id, party_id, division, total_cents, issued_event_id) VALUES (?, 'p:a', ?, 1000, 'e1')`,
      )
        .bind(id, division)
        .run();
    }
    const r = await TDB.prepare("SELECT count(*) AS c FROM invoices WHERE division = 'west'").first<{ c: number }>();
    expect(r?.c).toBe(1);
  });
});

describe("Task 3 — control plane (4 tables) constraints", () => {
  it("users.role CHECK admits the six roles and rejects others; email is UNIQUE", async () => {
    await CDB.prepare(
      "INSERT INTO tenants (id, name, slug, plan, created_ts) VALUES ('t1', 'Acme', 'acme', 'pro', 1000)",
    ).run();
    for (const role of ["admin", "ops", "finance", "read", "driver", "portal"]) {
      await CDB.prepare("INSERT INTO users (id, tenant_id, email, role) VALUES (?, 't1', ?, ?)")
        .bind(`u-${role}`, `${role}@acme.io`, role)
        .run();
    }
    await expect(
      CDB.prepare("INSERT INTO users (id, tenant_id, email, role) VALUES ('u-bad', 't1', 'bad@acme.io', 'superuser')").run(),
    ).rejects.toThrow();
    await expect(
      CDB.prepare("INSERT INTO users (id, tenant_id, email, role) VALUES ('u-dup', 't1', 'admin@acme.io', 'ops')").run(),
    ).rejects.toThrow();
  });
  it("tenants.slug is UNIQUE and pairings/usage_credits accept rows", async () => {
    await CDB.prepare("INSERT INTO tenants (id, name, slug, plan, created_ts) VALUES ('t2', 'B', 'bravo', 'pro', 1)").run();
    await expect(
      CDB.prepare("INSERT INTO tenants (id, name, slug, plan, created_ts) VALUES ('t3', 'C', 'bravo', 'pro', 1)").run(),
    ).rejects.toThrow();
    await CDB.prepare(
      "INSERT INTO pairings (id, tenant_id, kind, secret_ref, status) VALUES ('pr1', 't2', 'mcp', 'sref', 'active')",
    ).run();
    // §915: the kind CHECK was the LAST control-plane constraint nothing exercised — this test inserted a
    // valid pairing and never probed the domain, so neutralising `CHECK (kind IN (...))` left the suite
    // green. The insert above is its control; a pairing kind decides which credential surface a token may
    // act on, so a value outside the four is an unroutable grant, not a typo.
    await expect(
      CDB.prepare(
        "INSERT INTO pairings (id, tenant_id, kind, secret_ref, status) VALUES ('pr-bad', 't2', 'ftp', 'sref', 'active')",
      ).run(),
    ).rejects.toThrow();
    await CDB.prepare("INSERT INTO usage_credits (id, tenant_id, period) VALUES ('uc1', 't2', '2026-07')").run();
    const r = await CDB.prepare("SELECT count(*) AS c FROM pairings WHERE tenant_id = 't2'").first<{ c: number }>();
    expect(r?.c).toBe(1);
  });
});

// ─── REQ-118 §668 — THE TENANT DOMAIN'S CHECK CONSTRAINTS WERE ENFORCED BY THE DATABASE AND BY NOTHING ELSE.
//
// The control-plane half of this file already does this: "users.role CHECK admits the six roles and rejects
// others" (above). The pattern was written once and never extended one migration over. Measured by neutering
// every CHECK in 0002_domain.sql — `CHECK (` → `CHECK (1=1 OR `, which keeps the SQL valid and makes the
// constraint always true — and running every suite that could own these tables:
//
//   ledger 634 · api 798 · agents 122 · billing 58 · translator 116 · rater 157 · mcp 185   ALL GREEN
//
// Sixteen constraints, 1,670 tests, zero detection. The same mutation on the CONTROL plane fires one test.
//
// This is the class CLAUDE.md's own audit flagged as the most deletable: a DDL constraint is the last line
// below every gate and test double, and it is exactly the clause a schema refactor drops because nothing in
// the application layer references it. Two of the eight schema invariants (I1's foreign key, I3's triggers)
// already live here for that reason.
//
// It matters most on money_lines. `direction IN ('ar','ap')` and the `kind` list — which carries
// `interline_split`, `correction_credit` and `correction_debit`, the values REQ-040's floor comparison and
// I7's netting identity are written in terms of — have NO Zod counterpart anywhere in src. For those three
// the database is not a backstop, it is the only guard.
//
// TWO KINDS OF ASSERTION, because the hazard and the guarantee are different failures:
//   1. the constraint still EXISTS, with exactly the values it is supposed to admit (catches a refactor
//      deleting it, neutering it, OR quietly widening the enum — the third is invisible to a behavioural test
//      that only ever tries one bad value);
//   2. the constraint actually BITES on a real insert.

const DOMAIN_CHECKS: ReadonlyArray<{ table: string; column: string; values: readonly string[] }> = [
  { table: "parties", column: "kind", values: ["shipper", "consignee", "carrier", "broker", "cartage", "factor", "insurer"] },
  { table: "shipments", column: "mode", values: ["LTL", "TL", "brokered", "cartage", "dray", "transload"] },
  { table: "legs", column: "kind", values: ["pickup", "linehaul", "interline", "cartage", "delivery", "dray"] },
  { table: "documents", column: "kind", values: ["BOL", "POD", "photo", "WI_cert", "invoice", "ratecon", "COI", "W9", "claim", "tsa_receipt"] },
  { table: "documents", column: "visibility", values: ["internal", "counterparty", "public"] },
  { table: "money_lines", column: "direction", values: ["ar", "ap"] },
  { table: "money_lines", column: "kind", values: ["freight", "fsc", "accessorial", "correction_credit", "correction_debit", "interline_split", "cod_collect", "settle_fee", "credit_purchase"] },
  { table: "messages", column: "channel", values: ["email", "sms", "voice", "portal", "note"] },
  { table: "facilities", column: "kind", values: ["terminal", "dock", "yard"] },
  { table: "assets", column: "kind", values: ["tractor", "trailer", "pup"] },
  { table: "rate_config", column: "kind", values: ["zone_tariff", "floors", "fsc", "accessorials", "transit_matrix", "class_adapter"] },
  { table: "authority_map", column: "module", values: ["rating", "invoicing", "dispatch", "settlement", "comms"] },
  { table: "authority_map", column: "authority", values: ["native", "legacy"] },
  { table: "anomalies", column: "severity", values: ["info", "warn", "critical"] },
  { table: "integrations", column: "kind", values: ["edi_partner", "eld", "quickbooks", "email_inbox", "tiles", "tsa"] },
];

async function tableSql(table: string): Promise<string> {
  const row = await TDB.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").bind(table).first<{ sql: string }>();
  return (row?.sql ?? "").replace(/\s+/g, " ");
}

describe("REQ-118 §668 — every tenant-domain CHECK still exists, with exactly its allowed values", () => {
  it("the schema is readable at all (non-vacuity — an empty read must not pass 15 assertions)", async () => {
    expect((await tableSql("money_lines")).length, "sqlite_master returned nothing for money_lines").toBeGreaterThan(200);
  });

  it.each(DOMAIN_CHECKS)("$table.$column admits exactly its documented values", async ({ table, column, values }) => {
    const sql = await tableSql(table);
    // Anchored on `CHECK (<column> IN (` so a neutered `CHECK (1=1 OR <column> IN (` does not match either —
    // an always-true constraint is a deleted constraint that still reads like one.
    const m = new RegExp(String.raw`CHECK \(${column} IN \(([^)]*)\)\)`).exec(sql);
    expect(m, `${table}.${column} no longer carries a \`CHECK (${column} IN (...))\` clause — it was deleted, renamed, or made always-true`).not.toBeNull();
    const live = m![1]!.split(",").map((v) => v.trim().replace(/^'|'$/g, ""));
    // toEqual, not toContain: a value ADDED to the enum widens what the database will store, and no
    // behavioural test that tries one bad value can see that happen.
    expect(live, `${table}.${column} admits a different value set than this repo documents`).toEqual([...values]);
  });

  it("money_lines.amount_cents still refuses zero", async () => {
    expect(await tableSql("money_lines")).toContain("CHECK (amount_cents != 0)");
  });

  it("DOMAIN_CHECKS enumerates EVERY check in the migration — a new one cannot arrive unenrolled", () => {
    // §668 shipped this list hand-maintained and recorded that as a standing limit: a CHECK added to
    // 0002_domain.sql would be invisible to the assertions above until somebody remembered to add a row.
    // That is §610's shape — a SELECTOR sits between the artifacts and the run, so the selector needs its
    // own floor. Counted against the migration SOURCE (already imported here for the migrations), so the
    // list cannot silently fall behind the schema it claims to describe.
    const declared = [...domain.matchAll(/\bCHECK\s*\(/gi)].length;
    // +1 for money_lines.amount_cents, which is an expression rather than an IN-list and is asserted above.
    expect(
      DOMAIN_CHECKS.length + 1,
      `0002_domain.sql declares ${declared} CHECK constraints and DOMAIN_CHECKS covers ${DOMAIN_CHECKS.length + 1}. ` +
        "A new CHECK was added without enrolling it — add a row (table, column, values) so its allowed set is " +
        "pinned, or extend this count's exemption if it is an expression check like amount_cents != 0",
    ).toBe(declared);
  });
});

describe("REQ-118 §668 — the money and authority CHECKs actually bite on a real insert", () => {
  // Behavioural half. Scoped to the constraints with NO application-layer counterpart (money_lines) plus the
  // WP-15 authority pair, rather than all 16: for the rest, a Zod enum refuses the value long before D1 sees
  // it, so the schema assertion above is the part that is load-bearing.
  async function money(over: Partial<{ direction: string; kind: string; amount_cents: number }>, tag: string): Promise<D1Result> {
    await insertBaseEvent(`evt-${tag}`);
    return TDB.prepare(
      `INSERT INTO money_lines (id, shipment_id, event_id, line_no, direction, kind, amount_cents, party_id, division, gl_map, created_ts)
       VALUES (?, 'S1', ?, 0, ?, ?, ?, 'p:acme', 'main', '{}', 1000)`,
    )
      .bind(`ml-${tag}`, `evt-${tag}`, over.direction ?? "ar", over.kind ?? "freight", over.amount_cents ?? 12345)
      .run();
  }

  it("accepts an honest AR freight line (non-vacuity — the rejections below must mean the CHECK)", async () => {
    await expect(money({}, "ok")).resolves.toBeTruthy();
  });

  it("rejects a direction that is neither ar nor ap — money on no side of the ledger", async () => {
    await expect(money({ direction: "xx" }, "dir")).rejects.toThrow();
  });

  it("rejects an unknown money_line kind — REQ-040 and I7 are written in terms of this list", async () => {
    await expect(money({ kind: "not_a_kind" }, "kind")).rejects.toThrow();
  });

  it("rejects a ZERO-amount money line — a line that projects no money is not a projection of physics", async () => {
    await expect(money({ amount_cents: 0 }, "zero")).rejects.toThrow();
  });

  it("rejects an unknown authority module, and an authority that is neither native nor legacy (WP-15, L8)", async () => {
      // CONTROL (§909): a VALID two-column row must insert first, or the two rejections below prove nothing.
      // Without it this case was sound only because every OTHER authority_map column is NOT NULL DEFAULT — a
      // fact stated in the DDL and nowhere in the test. Add a required column with no default to that table
      // and both rejections would start passing for the wrong reason, silently. Now the control fails loudly.
      await TDB.prepare("INSERT INTO authority_map (module, authority) VALUES ('dispatch','native')").run();
    await expect(TDB.prepare("INSERT INTO authority_map (module, authority) VALUES ('not_a_module','native')").run()).rejects.toThrow();
    await expect(TDB.prepare("INSERT INTO authority_map (module, authority) VALUES ('rating','neither')").run()).rejects.toThrow();
  });
});

// ─── REQ-118 §669 — THE UNIQUE CLASS IS FULLY BACKED, AND THE MUTATION CAUGHT MY OWN WRONG CLAIM. ─────
//
// §668's trigger sent the sweep at the UNIQUE class. Eight constraints, measured one at a time. Five fire a
// test when neutered (control `tenants.slug` and `users.email`, `events.id` at 73, `ux_ml_corrects` at 2,
// `ux_legs_slot` at 1 in workers/api). Three were silent — and ALL THREE turn out to be redundant with a
// live BEFORE INSERT trigger that raises loudly on the same duplicate:
//
//   0008 events_guard_ins_unique     ... hash = NEW.hash OR (device_id IS NOT NULL AND stream_id = ...)
//   0003 money_lines_guard_ins       ... id = NEW.id OR (event_id = NEW.event_id AND line_no = NEW.line_no)
//
// §531's fourth explanation, three times over. The UNIQUE indexes are the backstop; the triggers are the
// live guard, which is the arrangement 0008's own header describes (REPLACE\'s implicit DELETE skips the
// BEFORE DELETE guard, so the INSERT guards enumerate every unique key).
//
// WORTH RECORDING HOW THIS WAS NEARLY GOT WRONG. The first draft of this block asserted that
// `(event_id, line_no)` had NO trigger twin and that the UNIQUE constraint was "the only thing stopping a
// doubled invoice line" — because 0008\'s money_lines guard enumerates only `corrects_event_id`, and that
// was the only file read. 0003 was never opened. The claim was false, and what caught it was the
// BEHAVIOURAL test below CONTINUING TO PASS while the constraint was neutered: the assertion disagreed with
// the prose above it, and the assertion was right. A grep over one migration proved nothing about the other.
//
// Both assertions are kept, with their attribution corrected. The duplicate really is refused — by the
// trigger — and the constraint really is declared. Neither had a test before this.
describe("REQ-118 §669 — a money_line cannot be inserted twice for the same (event_id, line_no)", () => {
  it("the UNIQUE constraint is still declared on the table", async () => {
    // A backstop, not the live guard. Kept because a schema refactor that drops it should have to say so:
    // it is the layer that survives if 0003\'s trigger is ever narrowed, and nothing else watches it.
    expect(await tableSql("money_lines")).toContain("UNIQUE (event_id, line_no)");
  });

  it("rejects a second line at the same (event_id, line_no) — a doubled invoice line", async () => {
    // Enforced by money_lines_guard_ins (0003), with the UNIQUE constraint behind it. A duplicate here is
    // the same invoice line counted twice: the total moves, AR moves with it, and money stops being a
    // projection of physics (L3) while every hash in the chain stays valid, because nothing about the event
    // stream is wrong. The read model is where it goes bad.
    await insertBaseEvent("evt-dup-line");
    const line = (id: string): Promise<D1Result> =>
      TDB.prepare(
        `INSERT INTO money_lines (id, shipment_id, event_id, line_no, direction, kind, amount_cents, party_id, division, gl_map, created_ts)
         VALUES (?, 'S1', 'evt-dup-line', 0, 'ar', 'freight', 12345, 'p:acme', 'main', '{}', 1000)`,
      )
        .bind(id)
        .run();
    // DISTINCT primary keys, deliberately: reusing the same `id` would collide on the PK and this would pass
    // without either layer existing, proving nothing about (event_id, line_no).
    await expect(line("ml-dup-a")).resolves.toBeTruthy();
    await expect(line("ml-dup-b")).rejects.toThrow();
  });
});

// ─── REQ-118 §670 — legs.shipment_id WAS THE ONE FOREIGN KEY OF THREE WITH NO TEST. ────────────────────
//
// §669's trigger sent the sweep at the last DDL class. All 12 triggers fire when dropped (the six UPDATE/
// DELETE guards, the three 0003 INSERT guards, 0004's party_refs guard — owned by `lens.test.ts`, not by
// this file — and both 0008 unique-key guards). That left the three foreign keys, and they split two-one:
//
//   money_lines.event_id -> events(id)     I1, tested above and mutation-proved in §340
//   party_credit.party_id -> parties(id)   1 test fires when dropped
//   legs.shipment_id -> shipments(id)      ledger 658 + api 798 = 1,456 tests, ALL GREEN
//
// The same shape as §668's CHECK finding: siblings declared on adjacent lines of one migration, two watched
// and one not, with nothing about the third making it less load-bearing.
//
// A leg is a movement segment — the unit dispatch assigns, appointments book (ux_legs_slot) and interline
// splits divide. An orphan leg is a leg the shipment lens cannot reach: it holds an appointment slot and a
// split share against a shipment that does not exist, and no read path joins it back to anything.
describe("REQ-118 §670 — a leg cannot exist without its shipment", () => {
  const leg = (id: string, shipmentId: string): Promise<D1Result> =>
    TDB.prepare(
      `INSERT INTO legs (id, shipment_id, seq, kind, executor_party_id) VALUES (?, ?, 0, 'linehaul', 'p:carrier')`,
    )
      .bind(id, shipmentId)
      .run();

  it("accepts a leg on a real shipment (non-vacuity — the rejection below must mean the FK)", async () => {
    await TDB.prepare(
      `INSERT INTO shipments (id, shipper_party_id, consignee_party_id, bill_to_party_id, created_ts)
       VALUES ('S-leg-fk', 'p:a', 'p:b', 'p:c', 1000)`,
    ).run();
    await expect(leg("leg-ok", "S-leg-fk")).resolves.toBeTruthy();
  });

  it("rejects a leg whose shipment does not exist — an orphan holding a slot and a split share", async () => {
    await expect(leg("leg-orphan", "S-does-not-exist")).rejects.toThrow();
  });
});

// ─── §923 — documents.id DEDUPES, WHICH IS WHAT THE UPLOAD ROUTE'S 201-vs-200 RESTS ON ──────────────────
//
// `/v1/evidence` writes `INSERT OR IGNORE INTO documents (id, …)` and reads `meta.changes` to tell a true
// first store (201) from the concurrent-duplicate LOSER whose row already landed (200). Dropping
// `documents.id PRIMARY KEY` left the whole api suite green.
//
// The reason it stayed green is worth stating, because it bounds what this test can claim: the suite's
// idempotent-repeat case is SEQUENTIAL, so it returns 200 through the earlier `existing !== null` branch
// and never reaches the insert at all. The PK only decides the CONCURRENT case — two inserts racing — and
// that race is not deterministically reproducible against a single-writer D1.
//
// So this pins the SCHEMA PROPERTY the route depends on rather than the race: a second insert of the same
// document id must not create a second row. Without the key, `OR IGNORE` is `INSERT`, `meta.changes` is
// always > 0, every racing writer answers 201, and the duplicate rows break the row-iff-bytes invariant
// that retention and the Biller's POD lookup both read.
describe("§923: documents.id dedupes a duplicate insert (the 201-vs-200 discriminator's foundation)", () => {
  it("INSERT OR IGNORE with a repeated id leaves exactly one row and reports no change", async () => {
    const ins = (id: string): Promise<D1Result> =>
      TDB.prepare(
        // Base columns only: this suite applies 0001-0003, and `created_ts` arrives in a later migration.
        "INSERT OR IGNORE INTO documents (id, shipment_id, kind, r2_key, hash) VALUES (?, 'S-dedupe', 'POD', ?, ?)",
      )
        .bind(id, `evidence/t/${id}`, id.padEnd(64, "0"))
        .run();

    const first = await ins("doc-dedupe-1");
    expect(first.meta.changes, "the first insert wrote nothing — 'exactly one row' would pass over an empty table").toBe(1);

    const repeat = await ins("doc-dedupe-1");
    expect(repeat.meta.changes, "a repeated document id inserted AGAIN — OR IGNORE found no key to conflict on, so every racing writer would answer 201").toBe(0);

    const n = await TDB.prepare("SELECT COUNT(*) AS n FROM documents WHERE id = 'doc-dedupe-1'").first<{ n: number }>();
    expect(n?.n).toBe(1);
  });
});
