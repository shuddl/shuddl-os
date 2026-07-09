import { describe, expect, it } from "vitest";
import { checkMigrationSql, PARTITION_TABLES, TABLE_BUDGET } from "./invariants.js";

// The six mandatory RAISE(ABORT) guard triggers for the append-only tables (I3/I1).
export const GUARDS_SQL = `
CREATE TRIGGER events_guard_upd BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'I3: append-only'); END;
CREATE TRIGGER events_guard_del BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'I3: append-only'); END;
CREATE TRIGGER positions_guard_upd BEFORE UPDATE ON positions BEGIN SELECT RAISE(ABORT,'I3: append-only'); END;
CREATE TRIGGER positions_guard_del BEFORE DELETE ON positions BEGIN SELECT RAISE(ABORT,'I3: append-only'); END;
CREATE TRIGGER money_lines_guard_upd BEFORE UPDATE ON money_lines BEGIN SELECT RAISE(ABORT,'I1'); END;
CREATE TRIGGER money_lines_guard_del BEFORE DELETE ON money_lines BEGIN SELECT RAISE(ABORT,'I1'); END;`;

describe("I8: table budget", () => {
  it("budget is 22 (21 named + one spare needing a written deletion)", () => {
    expect(TABLE_BUDGET).toBe(22);
  });
  it("fails when migrations create a 23rd table", () => {
    const sql = Array.from({ length: 23 }, (_, i) => `CREATE TABLE t${i} (id TEXT);`).join("\n");
    const result = checkMigrationSql([sql]);
    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toContain("I8");
  });
  it("passes at 21 tables and warns on the spare (22nd)", () => {
    const sql21 = Array.from({ length: 21 }, (_, i) => `CREATE TABLE t${i} (id TEXT);`).join("\n");
    expect(checkMigrationSql([sql21]).ok).toBe(true);
    const sql22 = sql21 + "\nCREATE TABLE spare (id TEXT);";
    const r = checkMigrationSql([sql22]);
    expect(r.ok).toBe(true);
    expect(r.warnings.join(" ")).toContain("spare");
  });
  it("does not double-count IF NOT EXISTS re-runs of the same table", () => {
    const sql = "CREATE TABLE IF NOT EXISTS events (id TEXT);\nCREATE TABLE IF NOT EXISTS events (id TEXT);";
    expect(checkMigrationSql([sql]).tableCount).toBe(1);
  });
});

describe("I3: events are append-only — including migrations", () => {
  it.each([
    "UPDATE events SET payload = '{}' WHERE id = '1';",
    "DELETE FROM events WHERE seq > 10;",
    "ALTER TABLE events DROP COLUMN sig;",
    "DROP TABLE events;",
  ])("fails on: %s", (stmt) => {
    const r = checkMigrationSql([`CREATE TABLE events (id TEXT);\n${stmt}`]);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toContain("I3");
  });
  it("allows CREATE TABLE events and CREATE INDEX on events", () => {
    // Guard triggers are mandatory once the events table exists (I3 v2), so the CREATE/INDEX
    // intent of this case carries the two events guards alongside it.
    const r = checkMigrationSql([
      "CREATE TABLE events (id TEXT);\nCREATE INDEX idx_events_seq ON events (seq);\n" +
        "CREATE TRIGGER events_guard_upd BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'I3: append-only'); END;\n" +
        "CREATE TRIGGER events_guard_del BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'I3: append-only'); END;",
    ]);
    expect(r.ok).toBe(true);
  });
  it("fails on triggers that UPDATE or DELETE events", () => {
    const r = checkMigrationSql([
      "CREATE TABLE events (id TEXT);\nCREATE TRIGGER bad AFTER INSERT ON events BEGIN UPDATE events SET id = 'x'; END;",
    ]);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toContain("I3");
  });
});

describe("I3 v2: trigger bodies may only RAISE(ABORT)", () => {
  const guards = GUARDS_SQL;
  const tables = "CREATE TABLE events (id TEXT);\nCREATE TABLE positions (id TEXT);\nCREATE TABLE money_lines (id TEXT);";

  it("stacked RAISE(ABORT) guard triggers are green (old regex false-positived here)", () => {
    expect(checkMigrationSql([tables + guards]).ok).toBe(true);
  });
  it("a trigger that mutates events is red", () => {
    const bad = tables + guards + "\nCREATE TRIGGER sneak AFTER INSERT ON events BEGIN UPDATE events SET id='x'; END;";
    const r = checkMigrationSql([bad]);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toContain("I3");
  });
  it("missing guard triggers is itself a violation when the table exists", () => {
    const r = checkMigrationSql([tables]); // tables without guards
    expect(r.violations.join(" ")).toContain("missing guard trigger");
  });
});

describe("I8 v2: positions is a partition of entry 9", () => {
  it("events + positions + 20 more = effective 21, ok, no spare warning", () => {
    const sql =
      ["CREATE TABLE events (id TEXT);", "CREATE TABLE positions (id TEXT);",
        ...Array.from({ length: 20 }, (_, i) => `CREATE TABLE t${i} (id TEXT);`)].join("\n") + GUARDS_SQL;
    const r = checkMigrationSql([sql]);
    expect(r.ok).toBe(true);
    expect(r.tableCount).toBe(21);
  });
  it("positions without events counts as a full table", () => {
    const sql = ["CREATE TABLE positions (id TEXT);", ...Array.from({ length: 22 }, (_, i) => `CREATE TABLE t${i} (id TEXT);`)].join("\n");
    expect(checkMigrationSql([sql]).ok).toBe(false);
  });
  it("the partition map is pinned to exactly ['positions']", () => {
    expect(Object.keys(PARTITION_TABLES)).toEqual(["positions"]);
  });
});
