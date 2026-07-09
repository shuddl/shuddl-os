import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyMigrations, splitSql } from "../src/migrate.js";

describe("splitSql: top-level ';' only — trigger bodies stay whole", () => {
  it("keeps a two-trigger file as 2 statements plus the CREATE TABLE as 1", () => {
    const sql = `CREATE TABLE events (id TEXT, seq INTEGER);
CREATE TRIGGER events_guard_upd BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'I3: append-only');
END;
CREATE TRIGGER events_guard_del BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'I3: append-only');
END;`;
    const stmts = splitSql(sql);
    expect(stmts).toHaveLength(3);
    expect(stmts[0]).toContain("CREATE TABLE events");
    // The inner ';' of a multi-line trigger body must NOT split the statement.
    expect(stmts[1]).toContain("BEGIN");
    expect(stmts[1]).toContain("RAISE(ABORT");
    expect(stmts[1]).toMatch(/END;$/);
    expect(stmts[2]).toContain("events_guard_del");
  });

  it("drops blank/comment-only fragments", () => {
    expect(splitSql("\n-- a comment\n\n")).toHaveLength(0);
  });
});

describe("applyMigrations against a real D1 (pool-workers)", () => {
  it("a guard trigger it installs aborts a later UPDATE (I3, append-only)", async () => {
    const sql = `CREATE TABLE events (id TEXT PRIMARY KEY, payload TEXT);
CREATE TRIGGER events_guard_upd BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'I3: append-only');
END;`;
    await applyMigrations(env.TENANT_A_DB, [{ path: "0001_ledger_core.sql", sql }]);

    // Insert is allowed (append-only).
    await env.TENANT_A_DB.prepare("INSERT INTO events (id, payload) VALUES ('e1', '{}')").run();
    const row = await env.TENANT_A_DB.prepare("SELECT payload FROM events WHERE id = 'e1'").first<{ payload: string }>();
    expect(row?.payload).toBe("{}");

    // Update must be rejected by the guard trigger, surfacing the I3 message.
    await expect(
      env.TENANT_A_DB.prepare("UPDATE events SET payload = '{tampered}' WHERE id = 'e1'").run(),
    ).rejects.toThrow(/I3/);
  });
});
