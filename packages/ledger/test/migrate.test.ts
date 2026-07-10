import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyMigrations, splitSql, stripSqlComments } from "../src/migrate.js";

describe("stripSqlComments: string-aware comment removal", () => {
  it("removes line comments", () => {
    const r = stripSqlComments("SELECT 1 -- secret sauce\nSELECT 2");
    expect(r).not.toContain("secret");
    expect(r).toContain("SELECT 1");
    expect(r).toContain("SELECT 2");
  });
  it("removes block comments", () => {
    expect(stripSqlComments("a /* hidden */ b")).not.toContain("hidden");
  });
  it("preserves comment markers and ';' inside string literals", () => {
    const r = stripSqlComments("INSERT INTO t VALUES ('a -- b; c')");
    expect(r).toContain("'a -- b; c'");
  });
});

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
});

describe("splitSql: no silent drops (CLAUDE.md rule 10)", () => {
  it("comment-only and blank fragments are fine and yield nothing", () => {
    expect(splitSql("\n-- a comment\n\n")).toHaveLength(0);
    expect(splitSql("/* block */\n")).toHaveLength(0);
  });
  it("throws on real trailing content with no terminating ';'", () => {
    expect(() => splitSql("CREATE TABLE t (id TEXT)")).toThrow(/trailing SQL/);
  });
  it("a ';' or '--' inside a string literal neither splits nor truncates", () => {
    const stmts = splitSql("INSERT INTO t VALUES ('a -- b; c');");
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toContain("'a -- b; c'");
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

  it("inline column comments do not corrupt a multi-line CREATE TABLE (I4)", async () => {
    // Every column carries an inline comment — the shape Task 2's DDL will have.
    const sql = `CREATE TABLE t (
  id TEXT PRIMARY KEY, -- the id
  name TEXT NOT NULL, -- the display name
  amt INTEGER -- signed cents
);`;
    await applyMigrations(env.TENANT_B_DB, [{ path: "0001.sql", sql }]);
    await env.TENANT_B_DB.prepare("INSERT INTO t (id, name, amt) VALUES ('a', 'b', 5)").run();
    const row = await env.TENANT_B_DB.prepare("SELECT id, name, amt FROM t WHERE id = 'a'").first<{
      id: string;
      name: string;
      amt: number;
    }>();
    expect(row).toEqual({ id: "a", name: "b", amt: 5 });
  });
});
