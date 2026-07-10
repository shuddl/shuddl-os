import { execFileSync } from "node:child_process";
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stripSqlComments } from "@shuddl/ledger/migrate";
import {
  checkLock,
  checkMigrationSql,
  findStraySql,
  isStraySql,
  PARTITION_TABLES,
  scanSourceForForbiddenReplace,
  TABLE_BUDGET,
} from "./invariants.js";

const HERE = dirname(fileURLToPath(import.meta.url)); // tools/checks
const REPO = join(HERE, "..", "..");
const CLI = join(HERE, "invariants.ts");
const TSX = join(REPO, "node_modules", ".bin", "tsx");

// A lint-clean migration: one table + its two correctly-timed guard triggers.
const VALID_MIGRATION =
  "CREATE TABLE events (id TEXT);\n" +
  "CREATE TRIGGER events_guard_upd BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'I3'); END;\n" +
  "CREATE TRIGGER events_guard_del BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'I3'); END;\n" +
  "CREATE TRIGGER events_guard_ins BEFORE INSERT ON events WHEN EXISTS (SELECT 1 FROM events WHERE id = NEW.id) BEGIN SELECT RAISE(ABORT,'I3'); END;\n";

function runCli(cwd: string, args: string[] = []): { code: number; out: string } {
  try {
    const out = execFileSync(TSX, [CLI, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number | null; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

function withTempRepo(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "shuddl-stray-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The three append-only tables, and the six mandatory RAISE(ABORT) guard triggers.
export const TABLES_SQL = "CREATE TABLE events (id TEXT);\nCREATE TABLE positions (id TEXT);\nCREATE TABLE money_lines (id TEXT);";
export const GUARDS_SQL = `
CREATE TRIGGER events_guard_upd BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'I3: append-only'); END;
CREATE TRIGGER events_guard_del BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'I3: append-only'); END;
CREATE TRIGGER positions_guard_upd BEFORE UPDATE ON positions BEGIN SELECT RAISE(ABORT,'I3: append-only'); END;
CREATE TRIGGER positions_guard_del BEFORE DELETE ON positions BEGIN SELECT RAISE(ABORT,'I3: append-only'); END;
CREATE TRIGGER money_lines_guard_upd BEFORE UPDATE ON money_lines BEGIN SELECT RAISE(ABORT,'I1'); END;
CREATE TRIGGER money_lines_guard_del BEFORE DELETE ON money_lines BEGIN SELECT RAISE(ABORT,'I1'); END;
CREATE TRIGGER events_guard_ins BEFORE INSERT ON events WHEN EXISTS (SELECT 1 FROM events WHERE id = NEW.id) BEGIN SELECT RAISE(ABORT,'I3: append-only'); END;
CREATE TRIGGER positions_guard_ins BEFORE INSERT ON positions WHEN EXISTS (SELECT 1 FROM positions WHERE shipment_id = NEW.shipment_id AND device_id = NEW.device_id AND ts = NEW.ts AND hash <> NEW.hash) BEGIN SELECT RAISE(ABORT,'I3: append-only'); END;
CREATE TRIGGER money_lines_guard_ins BEFORE INSERT ON money_lines WHEN EXISTS (SELECT 1 FROM money_lines WHERE id = NEW.id) BEGIN SELECT RAISE(ABORT,'I1'); END;`;

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
        "CREATE TRIGGER events_guard_del BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'I3: append-only'); END;\n" +
        "CREATE TRIGGER events_guard_ins BEFORE INSERT ON events WHEN EXISTS (SELECT 1 FROM events WHERE id = NEW.id) BEGIN SELECT RAISE(ABORT,'I3: append-only'); END;",
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
  const tables = TABLES_SQL;

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

describe("C1: a guard trigger can never be dropped by a later migration", () => {
  it.each([
    "DROP TRIGGER events_guard_del;",
    "DROP TRIGGER IF EXISTS positions_guard_upd;",
    "DROP TRIGGER money_lines_guard_del ;",
  ])("flags %s even when every CREATE guard is present", (drop) => {
    // guard-presence is satisfied (all CREATEs present) — the drop is the whole attack.
    const r = checkMigrationSql([TABLES_SQL + GUARDS_SQL + "\n" + drop]);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toContain("I3");
    expect(r.violations.join(" ")).toContain("DROP TRIGGER");
  });
});

describe("I1: REPLACE is a disguised delete+insert on append-only tables", () => {
  it.each([
    "REPLACE INTO events (id) VALUES ('x');",
    "INSERT OR REPLACE INTO events (id) VALUES ('x');",
    "REPLACE INTO money_lines (id) VALUES ('x');",
  ])("flags %s", (stmt) => {
    const r = checkMigrationSql([TABLES_SQL + GUARDS_SQL + "\n" + stmt]);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toContain("I3");
  });
});

describe("I3 v3: BEFORE INSERT guard is mandatory (closes the recursive_triggers=0 REPLACE hole)", () => {
  it("a table with upd+del but no _guard_ins is flagged", () => {
    const sql =
      "CREATE TABLE events (id TEXT);\n" +
      "CREATE TRIGGER events_guard_upd BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'I3'); END;\n" +
      "CREATE TRIGGER events_guard_del BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'I3'); END;";
    const r = checkMigrationSql([sql]);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toContain("events_guard_ins");
  });
  it("all three tables must each carry a _guard_ins (positions, money_lines too)", () => {
    const r = checkMigrationSql([TABLES_SQL + GUARDS_SQL]);
    // GUARDS_SQL now carries the three ins guards, so the full set is complete.
    expect(r.ok).toBe(true);
  });
  it("a _guard_ins with a WHEN EXISTS clause and a one-statement RAISE body is allowed", () => {
    const sql =
      "CREATE TABLE events (id TEXT);\n" +
      "CREATE TRIGGER events_guard_upd BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'I3'); END;\n" +
      "CREATE TRIGGER events_guard_del BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'I3'); END;\n" +
      "CREATE TRIGGER events_guard_ins BEFORE INSERT ON events WHEN EXISTS (SELECT 1 FROM events WHERE id = NEW.id) BEGIN SELECT RAISE(ABORT,'I3'); END;";
    expect(checkMigrationSql([sql]).ok).toBe(true);
  });
});

describe("D1: application source may not REPLACE a guarded table (recursive_triggers=0 defense)", () => {
  it("flags INSERT OR REPLACE INTO events in TS source", () => {
    const v = scanSourceForForbiddenReplace([
      { path: "workers/api/src/x.ts", text: "await db.exec(`INSERT OR REPLACE INTO events (id) VALUES ('a')`);" },
    ]);
    expect(v.length).toBe(1);
    expect(v.join(" ")).toContain("events");
  });
  it("flags a bare REPLACE INTO money_lines", () => {
    const v = scanSourceForForbiddenReplace([{ path: "p.ts", text: "REPLACE INTO money_lines (id) VALUES ('a')" }]);
    expect(v.length).toBe(1);
  });
  it("flags REPLACE INTO positions", () => {
    const v = scanSourceForForbiddenReplace([{ path: "p.ts", text: "insert or replace into positions values (1)" }]);
    expect(v.length).toBe(1);
  });
  it("clean source (plain INSERT) passes", () => {
    const v = scanSourceForForbiddenReplace([{ path: "p.ts", text: "await db.prepare('INSERT INTO events (id) VALUES (?)').run();" }]);
    expect(v).toEqual([]);
  });
  it("REPLACE targeting a non-guarded table is not our concern", () => {
    const v = scanSourceForForbiddenReplace([{ path: "p.ts", text: "INSERT OR REPLACE INTO shipments (id) VALUES ('a')" }]);
    expect(v).toEqual([]);
  });
});

describe("I2: guard-presence requires correct timing and ignores comments", () => {
  it("a guard with wrong timing (AFTER INSERT) does not satisfy presence", () => {
    const sql =
      "CREATE TABLE events (id TEXT);\n" +
      "CREATE TRIGGER events_guard_upd AFTER INSERT ON events BEGIN SELECT RAISE(ABORT,'x'); END;\n" +
      "CREATE TRIGGER events_guard_del BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'x'); END;";
    const r = checkMigrationSql([sql]);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toContain("missing guard trigger events_guard_upd");
  });
  it("a commented-out guard does not satisfy presence", () => {
    const sql =
      "CREATE TABLE events (id TEXT);\n" +
      "-- CREATE TRIGGER events_guard_upd BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'x'); END;\n" +
      "CREATE TRIGGER events_guard_del BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'x'); END;";
    const r = checkMigrationSql([sql]);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toContain("missing guard trigger events_guard_upd");
  });
  it("a commented-out mutation is NOT a violation", () => {
    const r = checkMigrationSql([TABLES_SQL + GUARDS_SQL + "\n-- UPDATE events SET id='x';"]);
    expect(r.ok).toBe(true);
  });
});

describe("I3 lint: bracket-quoted identifiers do not evade the lint", () => {
  it("UPDATE [events] is flagged (bracket identifier)", () => {
    const r = checkMigrationSql([TABLES_SQL + GUARDS_SQL + "\nUPDATE [events] SET id='x';"]);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toContain("I3");
  });
  it("CREATE TABLE [events] is counted and still demands guards", () => {
    const r = checkMigrationSql(["CREATE TABLE [events] (id TEXT);"]);
    expect(r.tableCount).toBe(1);
    expect(r.violations.join(" ")).toContain("missing guard trigger events_guard_upd");
  });
});

// ─── WP-02 exit-audit (REQ-119) — the three Criticals the swarm found: the lint's regexes ignored
// SQLite `schema.` qualifiers and zero-width bracket/quote delimiters, so a guard drop / a mutation /
// a table could all evade. Each block below FAILED against the pre-fix lint (the hole was real).

describe("Exit audit (REQ-119) C1: a schema-qualified guard DROP is still flagged", () => {
  it.each([
    "DROP TRIGGER main.events_guard_del;",
    "DROP TRIGGER IF EXISTS main.positions_guard_upd;",
    "DROP TRIGGER `main`.money_lines_guard_del;",
    'DROP TRIGGER "main".events_guard_ins;',
  ])("flags %s — the unqualified tail names the guard, not the schema `main`", (drop) => {
    // Pre-fix: the matcher captured `main` (stopped at the dot), which is not a guard name, so the
    // drop passed green and `DELETE FROM events` would then run with no BEFORE-DELETE backstop.
    const r = checkMigrationSql([TABLES_SQL + GUARDS_SQL + "\n" + drop]);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toContain("DROP TRIGGER");
    expect(r.violations.join(" ")).toContain("I3");
  });
});

describe("Exit audit (REQ-119) C2: schema-qualified / upsert mutations of a guarded table are caught", () => {
  it.each([
    "DELETE FROM main.events WHERE seq > 0;",
    "DROP TABLE main.events;", // no trigger fires on DROP TABLE — the lint is the ONLY backstop
    "DELETE FROM `main`.events;",
    'UPDATE "main".money_lines SET amount_cents = 0;',
    "ALTER TABLE main.positions DROP COLUMN hash;",
    "INSERT INTO events (id) VALUES ('x') ON CONFLICT(id) DO UPDATE SET id = 'y';", // an upsert IS a mutation
    "INSERT INTO main.money_lines (id) VALUES ('x') ON CONFLICT(id) DO UPDATE SET id = 'y';",
  ])("flags %s", (stmt) => {
    const r = checkMigrationSql([TABLES_SQL + GUARDS_SQL + "\n" + stmt]);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toContain("I3");
  });
  it("an upsert on a NON-guarded table (invoices) is not our concern", () => {
    const r = checkMigrationSql([
      TABLES_SQL + GUARDS_SQL + "\nINSERT INTO invoices (id) VALUES ('x') ON CONFLICT(id) DO UPDATE SET id = 'y';",
    ]);
    expect(r.ok).toBe(true);
  });
});

describe("Exit audit (REQ-119) C3: bracket/quote tables with no whitespace count toward the ≤22 budget", () => {
  it("CREATE TABLE[t](a int) counts (pre-fix it was invisible → I8 defeatable)", () => {
    expect(checkMigrationSql(["CREATE TABLE[t](a int);"]).tableCount).toBe(1);
  });
  it('CREATE TABLE"x"(a int) counts', () => {
    expect(checkMigrationSql(['CREATE TABLE"x"(a int);']).tableCount).toBe(1);
  });
  it("23 no-space bracket tables bust the budget (pre-fix they summed to 0 → tableCount stayed low, ok=true)", () => {
    const sql = Array.from({ length: 23 }, (_, i) => `CREATE TABLE[t${i}](a int);`).join("\n");
    const r = checkMigrationSql([sql]);
    expect(r.tableCount).toBe(23);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toContain("I8");
  });
  it("the real attack: 21 space-delimited tables + 3 no-space (bracket/quote) tables = 24 → over budget", () => {
    const real = Array.from({ length: 21 }, (_, i) => `CREATE TABLE t${i} (id TEXT);`).join("\n");
    const sneaked = ["CREATE TABLE[t22](a int);", 'CREATE TABLE"t23"(a int);', "CREATE TABLE[t24](a int);"].join("\n");
    const r = checkMigrationSql([real + "\n" + sneaked]);
    expect(r.tableCount).toBe(24);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toContain("I8");
  });
});

describe("Exit audit (REQ-119) positive controls: legitimate SQL still passes", () => {
  it("the real committed migrations (db/**/migrations/*.sql) still yield 21/22, no violations", () => {
    const files = globSync("db/**/migrations/*.sql", { cwd: REPO }).map((f) => readFileSync(join(REPO, f), "utf8"));
    expect(files.length).toBeGreaterThanOrEqual(5);
    const r = checkMigrationSql(files);
    expect(r.tableCount).toBe(21);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });
  it("a schema-qualified guard definition still satisfies guard-presence (main.events + main.-qualified guards)", () => {
    const sql =
      "CREATE TABLE events (id TEXT);\n" +
      "CREATE TRIGGER main.events_guard_upd BEFORE UPDATE ON main.events BEGIN SELECT RAISE(ABORT,'I3'); END;\n" +
      "CREATE TRIGGER main.events_guard_del BEFORE DELETE ON main.events BEGIN SELECT RAISE(ABORT,'I3'); END;\n" +
      "CREATE TRIGGER main.events_guard_ins BEFORE INSERT ON main.events WHEN EXISTS (SELECT 1 FROM events WHERE id = NEW.id) BEGIN SELECT RAISE(ABORT,'I3'); END;";
    expect(checkMigrationSql([sql]).ok).toBe(true);
  });
});

describe("C2: forward-only migration lock (checkLock)", () => {
  const path = "db/tenant/migrations/0001_ledger_core.sql";
  it("check mode fails when a migration on disk is not pinned in the lock", () => {
    const r = checkLock([{ path, digest: "abc" }], {}, "check");
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/not pinned/);
  });
  it("an edited file fails even when its lock key was KEPT (digest diverged)", () => {
    const r = checkLock([{ path, digest: "NEW" }], { [path]: "OLD" }, "check");
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/EDITED/);
  });
  it("write mode refuses to re-pin an edited file (forward-only, even locally)", () => {
    expect(checkLock([{ path, digest: "NEW" }], { [path]: "OLD" }, "write").ok).toBe(false);
  });
  it("write mode pins a brand-new file", () => {
    const r = checkLock([{ path, digest: "abc" }], {}, "write");
    expect(r.ok).toBe(true);
    expect(r.nextLock[path]).toBe("abc");
  });
  it("a matching digest passes in both modes", () => {
    expect(checkLock([{ path, digest: "abc" }], { [path]: "abc" }, "check").ok).toBe(true);
    expect(checkLock([{ path, digest: "abc" }], { [path]: "abc" }, "write").ok).toBe(true);
  });
});

describe("M1: stray-SQL fence — only real migration files are exempt", () => {
  const migrations = new Set(["db/tenant/migrations/0001_ledger_core.sql"]);
  it("a .sql under db/ that is NOT a migration (e.g. db/tenant/seed.sql) is a stray", () => {
    expect(isStraySql("db/tenant/seed.sql", migrations)).toBe(true);
  });
  it("a real migration file is exempt", () => {
    expect(isStraySql("db/tenant/migrations/0001_ledger_core.sql", migrations)).toBe(false);
  });
  it("fixtures and node_modules are exempt", () => {
    expect(isStraySql("fixtures/qb/export.sql", migrations)).toBe(false);
    expect(isStraySql("packages/x/node_modules/dep/schema.sql", migrations)).toBe(false);
  });
  it("a stray anywhere else (e.g. packages/ledger/rogue.sql) is caught", () => {
    expect(isStraySql("packages/ledger/rogue.sql", migrations)).toBe(true);
  });
});

// stripSqlComments is shared from @shuddl/ledger — but the lint's own robustness
// depends on it, so its adversarial contract is pinned HERE, at the control's site.
describe("stripSqlComments (control-site contract — must survive any future weakening)", () => {
  it("does not strip a '--' that lives inside a string literal", () => {
    expect(stripSqlComments("SELECT '-- not a comment'")).toContain("-- not a comment");
  });
  it("does not strip a ';' inside a string literal", () => {
    expect(stripSqlComments("INSERT INTO t VALUES ('a;b')")).toContain("a;b");
  });
  it("strips a /* */ block comment that spans multiple lines", () => {
    const r = stripSqlComments("CREATE TABLE t (\n/* multi\n line\n danger */ id TEXT\n);");
    expect(r).not.toContain("danger");
    expect(r).toContain("id TEXT");
  });
  it("erases a commented-out guard trigger (so guard-presence cannot be fooled)", () => {
    const r = stripSqlComments("-- CREATE TRIGGER events_guard_upd BEFORE UPDATE ON events ...");
    expect(r).not.toContain("events_guard_upd");
  });
});

// The regression the isStraySql unit tests could NOT catch: globSync passes basenames
// to `exclude` for leaf files, so the membership test must run on the RESULT array.
// These exercise the real glob+filter composition against a real temp filesystem.
describe("M1 regression: findStraySql accepts real migrations, rejects everything else", () => {
  it("a migration at db/tenant/migrations/*.sql is NOT reported stray", () => {
    withTempRepo((dir) => {
      mkdirSync(join(dir, "db", "tenant", "migrations"), { recursive: true });
      writeFileSync(join(dir, "db", "tenant", "migrations", "0001_x.sql"), VALID_MIGRATION);
      expect(findStraySql(dir)).toEqual([]);
    });
  });
  it("a migration at db/control/migrations/*.sql is NOT reported stray", () => {
    withTempRepo((dir) => {
      mkdirSync(join(dir, "db", "control", "migrations"), { recursive: true });
      writeFileSync(join(dir, "db", "control", "migrations", "0001_y.sql"), VALID_MIGRATION);
      expect(findStraySql(dir)).toEqual([]);
    });
  });
  it("db/tenant/seed.sql (under db/, not a migration) IS reported stray", () => {
    withTempRepo((dir) => {
      mkdirSync(join(dir, "db", "tenant"), { recursive: true });
      writeFileSync(join(dir, "db", "tenant", "seed.sql"), "CREATE TABLE x (id TEXT);");
      expect(findStraySql(dir)).toContain("db/tenant/seed.sql");
    });
  });
  it("packages/ledger/oops.sql IS reported stray", () => {
    withTempRepo((dir) => {
      mkdirSync(join(dir, "packages", "ledger"), { recursive: true });
      writeFileSync(join(dir, "packages", "ledger", "oops.sql"), "CREATE TABLE x (id TEXT);");
      expect(findStraySql(dir)).toContain("packages/ledger/oops.sql");
    });
  });
  it("a real migration alongside a stray: only the stray is reported", () => {
    withTempRepo((dir) => {
      mkdirSync(join(dir, "db", "tenant", "migrations"), { recursive: true });
      writeFileSync(join(dir, "db", "tenant", "migrations", "0001_x.sql"), VALID_MIGRATION);
      writeFileSync(join(dir, "db", "tenant", "seed.sql"), "CREATE TABLE x (id TEXT);");
      expect(findStraySql(dir)).toEqual(["db/tenant/seed.sql"]);
    });
  });
});

describe("M1 regression: the actual check:invariants CLI exit code (end-to-end)", () => {
  it("exits 0 with a real migration present (positive control — was exit 1 under the bug)", () => {
    withTempRepo((dir) => {
      mkdirSync(join(dir, "db", "tenant", "migrations"), { recursive: true });
      writeFileSync(join(dir, "db", "tenant", "migrations", "0001_x.sql"), VALID_MIGRATION);
      const r = runCli(dir, ["--write"]); // --write pins the new migration so the lock check passes too
      expect(r.code).toBe(0);
    });
  }, 30000);
  it("exits 1 and names the stray when a non-migration .sql sits under db/", () => {
    withTempRepo((dir) => {
      mkdirSync(join(dir, "db", "tenant"), { recursive: true });
      writeFileSync(join(dir, "db", "tenant", "seed.sql"), "CREATE TABLE x (id TEXT);");
      const r = runCli(dir);
      expect(r.code).toBe(1);
      expect(r.out).toContain("stray");
    });
  }, 30000);
});
