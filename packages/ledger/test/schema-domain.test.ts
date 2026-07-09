import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/migrate.js";
import ledgerCore from "../../../db/tenant/migrations/0001_ledger_core.sql?raw";
import domain from "../../../db/tenant/migrations/0002_domain.sql?raw";
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
    await expect(insertMoneyLine({ event_id: "ghost-event", line_no: 0, division: "main" })).rejects.toThrow();
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
    await CDB.prepare("INSERT INTO usage_credits (id, tenant_id, period) VALUES ('uc1', 't2', '2026-07')").run();
    const r = await CDB.prepare("SELECT count(*) AS c FROM pairings WHERE tenant_id = 't2'").first<{ c: number }>();
    expect(r?.c).toBe(1);
  });
});
