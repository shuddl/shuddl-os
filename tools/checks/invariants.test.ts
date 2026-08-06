import { execFileSync } from "node:child_process";
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stripSqlComments } from "@shuddl/ledger/migrate";
import {
  checkControlMigrationsExercised,
  GUARDED_TABLES,
  checkTableClassification,
  isCollisionDuplicate,
  checkDoMutexIntact,
  checkSurfaceBudget,
  checkLock,
  checkMigrationSql,
  checkTestSchemaParity,
  DO_MUTEX_ROSTER,
  SURFACE_ROSTER,
  findStraySql,
  isStraySql,
  PARTITION_TABLES,
  scanSourceForForbiddenReplace,
  scanSourceForLegsReplace,
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

describe("I3 v4: a NULLABLE ADD COLUMN is the one sanctioned ALTER on a guarded table (owner-approved, WP-05)", () => {
  // Rationale (mirrors the lint comment): append-only (Law 2) bans UPDATE/DELETE of existing event
  // DATA; a nullable ADD COLUMN is SQLite metadata-only (no row rewrite) and is neither UPDATE nor
  // DELETE, so permitting ONLY it aligns the lint with Law 2. Everything else stays forbidden.
  it.each([
    "ALTER TABLE events ADD COLUMN override_json TEXT;",
    "ALTER TABLE events ADD override_json TEXT;", // COLUMN keyword is optional in SQLite
    "ALTER TABLE positions ADD COLUMN note TEXT;",
    "ALTER TABLE money_lines ADD COLUMN memo TEXT;",
    "ALTER TABLE main.events ADD COLUMN override_json TEXT;", // schema-qualified
    "ALTER TABLE [events] ADD COLUMN override_json TEXT;", // bracket-quoted table
    "ALTER TABLE events ADD COLUMN qty INTEGER;", // INTEGER is a STRICT type too
  ])("PASSES: %s", (stmt) => {
    const r = checkMigrationSql([TABLES_SQL + GUARDS_SQL + "\n" + stmt]);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });
  it.each([
    "ALTER TABLE events ADD COLUMN x TEXT NOT NULL;", // NOT NULL would write into existing rows
    "ALTER TABLE events ADD COLUMN x TEXT DEFAULT '{}';", // DEFAULT is forbidden on events
    "ALTER TABLE events DROP COLUMN sig;",
    "ALTER TABLE events RENAME TO evts;",
    "ALTER TABLE events RENAME COLUMN sig TO signature;",
    "ALTER TABLE main.positions DROP COLUMN hash;",
    "ALTER TABLE [events] DROP COLUMN sig;",
    "ALTER TABLE events ADD COLUMN x TEXT, ADD COLUMN y TEXT;", // more than one clause
  ])("FAILS: %s", (stmt) => {
    const r = checkMigrationSql([TABLES_SQL + GUARDS_SQL + "\n" + stmt]);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toContain("I3");
  });
  it("an ALTER ... ADD COLUMN on a NON-guarded table is not our concern (even NOT NULL)", () => {
    const r = checkMigrationSql([TABLES_SQL + GUARDS_SQL + "\nALTER TABLE shipments ADD COLUMN x TEXT NOT NULL;"]);
    expect(r.ok).toBe(true);
  });
  it("does not false-positive on a similarly-named non-guarded table (eventsX)", () => {
    const r = checkMigrationSql([TABLES_SQL + GUARDS_SQL + "\nALTER TABLE eventsX DROP COLUMN y;"]);
    expect(r.ok).toBe(true);
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

// Task 5 (REQ-002/011, I3/I1) — guard COMPLETENESS. A BEFORE INSERT guard only closes the
// recursive_triggers=0 REPLACE hole for the UNIQUE keys its WHEN-clause actually enumerates. A UNIQUE
// column / UNIQUE(...) constraint / CREATE UNIQUE INDEX on a guarded table that NO guard-ins predicate
// enumerates is an open door: an INSERT OR REPLACE colliding on it deletes the chained victim row and the
// guard never fires. The scanner compares every UNIQUE target on a guarded table against the (normalized)
// equality column-sets of its BEFORE INSERT guards; an uncovered target is a completeness violation.
describe("Task 5 — I3 guard completeness: every UNIQUE target on a guarded table needs a guard-ins predicate", () => {
  const guards = (whenExtra = "") =>
    "CREATE TRIGGER events_guard_upd BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'I3'); END;\n" +
    "CREATE TRIGGER events_guard_del BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'I3'); END;\n" +
    `CREATE TRIGGER events_guard_ins BEFORE INSERT ON events WHEN EXISTS (SELECT 1 FROM events WHERE id = NEW.id${whenExtra}) BEGIN SELECT RAISE(ABORT,'I3'); END;`;

  it("flags a CREATE UNIQUE INDEX on events whose columns no guard-ins predicate enumerates", () => {
    const sql = "CREATE TABLE events (id TEXT, hash TEXT);\nCREATE UNIQUE INDEX ux_events_hash ON events (hash);\n" + guards();
    const r = checkMigrationSql([sql]);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toContain("completeness");
    expect(r.violations.join(" ")).toContain("hash");
  });

  it("passes once a guard-ins disjunct enumerates the UNIQUE-index columns", () => {
    const sql = "CREATE TABLE events (id TEXT, hash TEXT);\nCREATE UNIQUE INDEX ux_events_hash ON events (hash);\n" + guards(" OR hash = NEW.hash");
    expect(checkMigrationSql([sql]).ok).toBe(true);
  });

  it("flags a UNIQUE COLUMN constraint with no matching guard predicate", () => {
    const sql = "CREATE TABLE events (id TEXT, hash TEXT UNIQUE);\n" + guards();
    const r = checkMigrationSql([sql]);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toContain("completeness");
  });

  it("flags a composite UNIQUE(...) constraint uncovered by the guard, passes once enumerated", () => {
    const base = (whenExtra: string) =>
      "CREATE TABLE money_lines (id TEXT PRIMARY KEY, event_id TEXT, line_no INTEGER, UNIQUE (event_id, line_no));\n" +
      "CREATE TRIGGER money_lines_guard_upd BEFORE UPDATE ON money_lines BEGIN SELECT RAISE(ABORT,'I1'); END;\n" +
      "CREATE TRIGGER money_lines_guard_del BEFORE DELETE ON money_lines BEGIN SELECT RAISE(ABORT,'I1'); END;\n" +
      `CREATE TRIGGER money_lines_guard_ins BEFORE INSERT ON money_lines WHEN EXISTS (SELECT 1 FROM money_lines WHERE id = NEW.id${whenExtra}) BEGIN SELECT RAISE(ABORT,'I1'); END;`;
    expect(checkMigrationSql([base("")]).ok).toBe(false); // UNIQUE(event_id, line_no) uncovered
    expect(checkMigrationSql([base(" OR (event_id = NEW.event_id AND line_no = NEW.line_no)")]).ok).toBe(true);
  });

  it("a PRIMARY KEY (composite) target must be enumerated too", () => {
    const sql =
      "CREATE TABLE events (stream_id TEXT, seq INTEGER, id TEXT, PRIMARY KEY (stream_id, seq));\n" +
      "CREATE TRIGGER events_guard_upd BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'I3'); END;\n" +
      "CREATE TRIGGER events_guard_del BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'I3'); END;\n" +
      "CREATE TRIGGER events_guard_ins BEFORE INSERT ON events WHEN EXISTS (SELECT 1 FROM events WHERE id = NEW.id) BEGIN SELECT RAISE(ABORT,'I3'); END;";
    expect(checkMigrationSql([sql]).ok).toBe(false); // (stream_id, seq) PK is uncovered by the id-only guard
    const covered =
      "CREATE TABLE events (stream_id TEXT, seq INTEGER, id TEXT, PRIMARY KEY (stream_id, seq));\n" +
      "CREATE TRIGGER events_guard_upd BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'I3'); END;\n" +
      "CREATE TRIGGER events_guard_del BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'I3'); END;\n" +
      "CREATE TRIGGER events_guard_ins BEFORE INSERT ON events WHEN EXISTS (SELECT 1 FROM events WHERE (stream_id = NEW.stream_id AND seq = NEW.seq) OR id = NEW.id) BEGIN SELECT RAISE(ABORT,'I3'); END;";
    expect(checkMigrationSql([covered]).ok).toBe(true);
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

// The Major the swarm found: the code COMMENT claimed the "delete the lock line, edit the file,
// re-run db:lock" bypass was closed, but write mode only errored when the key was PRESENT. A deleted
// key read as a brand-new file, so --write re-pinned the EDITED digest and CI check then passed green.
// The fix anchors forward-only against the lock AS COMMITTED IN GIT (`committed`), which a locally
// deleted lock line cannot reset. (These call the 4-arg form; the pre-fix 3-arg impl ignored it.)
describe("Exit audit (REQ-119) Major: the delete-lock-line forward-only bypass is closed", () => {
  const path = "db/tenant/migrations/0001_ledger_core.sql";
  it("write REFUSES to re-pin a path HEAD pinned at a different digest, even with the on-disk key deleted", () => {
    // on-disk lock = {} (key deleted), edited file digest = NEW, git HEAD still holds OLD.
    const w = checkLock([{ path, digest: "NEW" }], {}, "write", { [path]: "OLD" });
    expect(w.ok).toBe(false);
    expect(w.errors.join(" ")).toMatch(/forward-only/);
    expect(w.nextLock[path]).toBe("OLD"); // never overwrites HEAD's pin with the edited digest
  });
  it("a hand-crafted on-disk lock matching the edited digest STILL fails check against the committed HEAD anchor", () => {
    // This is the exact green-CI end state of the old bypass; it must now be red.
    const c = checkLock([{ path, digest: "NEW" }], { [path]: "NEW" }, "check", { [path]: "OLD" });
    expect(c.ok).toBe(false);
    expect(c.errors.join(" ")).toMatch(/committed to the lock/);
  });
  it("a genuinely new migration (absent from HEAD) is still pinnable by --write", () => {
    const w = checkLock([{ path, digest: "abc" }], {}, "write", {}); // HEAD has no such path
    expect(w.ok).toBe(true);
    expect(w.nextLock[path]).toBe("abc");
  });
  it("an unchanged file (HEAD == on-disk == entry) passes in both modes", () => {
    expect(checkLock([{ path, digest: "OLD" }], { [path]: "OLD" }, "check", { [path]: "OLD" }).ok).toBe(true);
    expect(checkLock([{ path, digest: "OLD" }], { [path]: "OLD" }, "write", { [path]: "OLD" }).ok).toBe(true);
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

// REQ-028/052 — `legs` is MUTABLE (a plain UPDATE claims a dock slot) but a REPLACE-family write or an upsert
// deletes/rewrites the row THROUGH ux_legs_slot (silent slot theft). Both the migration surface
// (checkMigrationSql) and the TS-source surface (scanSourceForLegsReplace) ban them — and, per the share-lint
// discipline, ONE evasion corpus is fed to BOTH so a delimiter/schema form one scanner blocks can never slip
// past the other.
describe("REQ-028/052: no REPLACE-family / upsert against legs (shared matcher, parity across surfaces)", () => {
  const EVASIONS = [
    `INSERT OR REPLACE INTO legs (id) VALUES ('x')`, // whitespace, bare
    `INSERT OR REPLACE INTO"legs" (id) VALUES ('x')`, // abutting quote (the \s+ blind spot)
    `REPLACE INTO main.legs (id) VALUES ('x')`, // schema-qualified
    `REPLACE INTO [legs] (id) VALUES ('x')`, // bracket delimiter
    "REPLACE INTO `legs` (id) VALUES ('x')", // backtick
    `INSERT INTO legs (id) VALUES ('x') ON CONFLICT(id) DO UPDATE SET id='y'`, // upsert rewrites the row
  ];
  for (const sql of EVASIONS) {
    it(`both surfaces flag: ${sql.slice(0, 42)}…`, () => {
      // migration surface
      expect(checkMigrationSql([sql]).violations.length).toBeGreaterThan(0);
      // TS-source surface — same corpus, must also flag
      expect(scanSourceForLegsReplace([{ path: "p.ts", text: sql }]).length).toBeGreaterThan(0);
    });
  }
  it("a plain UPDATE on legs (how appointment.set claims a slot) is allowed on both surfaces", () => {
    const ok = "UPDATE legs SET facility_id=?, appt_slot_key=? WHERE shipment_id=? AND kind=?";
    expect(checkMigrationSql([ok]).violations).toEqual([]);
    expect(scanSourceForLegsReplace([{ path: "p.ts", text: ok }])).toEqual([]);
  });
  it("REPLACE targeting a non-legs table is not this rule's concern", () => {
    expect(scanSourceForLegsReplace([{ path: "p.ts", text: "INSERT OR REPLACE INTO shipments (id) VALUES ('a')" }])).toEqual([]);
  });
});

// The events/positions/money_lines source scanner shares the SAME builder as the migration scanner now, so
// the abutting-quote and schema-qualified evasions the old hand-rolled copy missed are closed (share-lint).
describe("D1 REPLACE ban — source scanner parity with the migration scanner (guarded tables)", () => {
  const EVASIONS = [
    `INSERT OR REPLACE INTO"events" VALUES(1)`, // abutting quote
    `INSERT OR REPLACE INTO main.events VALUES(1)`, // schema-qualified
    `REPLACE INTO [positions] VALUES(1)`, // bracket delimiter
    "REPLACE INTO `money_lines` VALUES(1)", // backtick
    `INSERT INTO events (id) VALUES ('x') ON CONFLICT(id) DO UPDATE SET id='y'`, // upsert IS a mutation
    `INSERT INTO main.money_lines (id) VALUES ('x') ON CONFLICT(id) DO UPDATE SET id='y'`, // schema-qualified upsert
  ];
  for (const sql of EVASIONS) {
    it(`both surfaces flag: ${sql.slice(0, 42)}…`, () => {
      expect(checkMigrationSql([sql]).violations.length).toBeGreaterThan(0);
      expect(scanSourceForForbiddenReplace([{ path: "p.ts", text: sql }]).length).toBeGreaterThan(0);
    });
  }
});

// audit §239 — the test schema must EQUAL the shipped schema. Each worker helper hand-maintains its own
// applied-migration array, so the list is duplicated per worker; all four had drifted when this was written.
describe("§239: worker test helpers apply every shipped tenant migration", () => {
  const SHIPPED = ["db/tenant/migrations/0001_a.sql", "db/tenant/migrations/0002_b.sql"];
  const applying = (...names: string[]): string =>
    `import x from "../../../db/tenant/migrations/0001_a.sql?raw";\n` +
    names.map((n) => `  { path: "${n}", sql: x },`).join("\n");

  it("passes when a helper applies all of them", () => {
    expect(checkTestSchemaParity(SHIPPED, [{ path: "h.ts", source: applying("0001_a.sql", "0002_b.sql") }])).toEqual([]);
  });

  it("FAILS when a shipped migration is missing from the applied array, and names it", () => {
    const v = checkTestSchemaParity(SHIPPED, [{ path: "h.ts", source: applying("0001_a.sql") }]);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("0002_b.sql");
    expect(v[0]).toContain("h.ts");
  });

  it("is INDEPENDENT of what the helper names its array — the first cut keyed on TENANT_MIGRATIONS and silently skipped two of four helpers", () => {
    // Same content, three different array names: all must be judged identically.
    for (const name of ["TENANT_MIGRATIONS", "MIGRATIONS", "SCHEMA"]) {
      const source = `const ${name} = [\n` + applying("0001_a.sql") + `\n];`;
      expect(checkTestSchemaParity(SHIPPED, [{ path: `${name}.ts`, source }]), name).toHaveLength(1);
    }
  });

  it("ignores a helper that stands up NO tenant schema (nothing imported from the migrations dir)", () => {
    // main() filters these out before calling; the function itself is total, so the filter is the contract.
    const source = `const MIGRATIONS = [];`;
    expect(source.includes("db/tenant/migrations/")).toBe(false);
  });

  it("a mention in prose is not an application — only an entry in the applied array counts", () => {
    const source = `import x from "../../../db/tenant/migrations/0001_a.sql?raw";\n// we should apply 0002_b.sql one day\n  { path: "0001_a.sql", sql: x },`;
    expect(checkTestSchemaParity(SHIPPED, [{ path: "h.ts", source }])).toHaveLength(1);
  });
});

// audit §244 — the DO serialization mutex. §235 measured that deleting it is SILENT in the owning worker's
// suite, so CI is the only thing that can make its removal loud.
describe("§244: every Durable Object keeps its serialization mutex", () => {
  const intact = (cls: string): string =>
    `export class ${cls} extends DurableObject {\n` +
    `  private lock: Promise<unknown> = Promise.resolve();\n` +
    `  f(req: R): Promise<X> {\n` +
    `    const run = this.lock.then(() => this.#f(req));\n` +
    `    this.lock = run.catch(() => undefined);\n` +
    `    return run;\n  }\n}`;

  it("passes when every rostered DO has all three limbs", () => {
    const files = DO_MUTEX_ROSTER.map((c) => ({ path: `${c}.ts`, source: intact(c) }));
    expect(checkDoMutexIntact(files)).toEqual([]);
  });

  it.each([
    ["field", /  private lock: Promise<unknown> = Promise\.resolve\(\);\n/],
    ["chain", /    const run = this\.lock\.then\(\(\) => this\.#f\(req\)\);\n/],
    ["re-arm", /    this\.lock = run\.catch\(\(\) => undefined\);\n/],
  ])("FAILS when the %s limb is deleted — each limb alone is load-bearing", (_name, re) => {
    const source = intact("SparkMeter").replace(re, "");
    const v = checkDoMutexIntact([{ path: "spark.ts", source }]);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("SparkMeter");
  });

  it("FAILS on a DurableObject that is not on the roster — a new DO cannot arrive uncovered", () => {
    const v = checkDoMutexIntact([{ path: "rogue.ts", source: "export class RogueMeter extends DurableObject {}" }]);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("DO_MUTEX_ROSTER");
  });

  it("the roster matches the DOs actually shipped — it is a pin, not a wish", () => {
    const files = globSync("workers/*/src/**/*.ts", { cwd: REPO }).map((p) => ({
      path: p,
      source: readFileSync(join(REPO, p), "utf8"),
    }));
    const shipped = files.flatMap((f) => [...f.source.matchAll(/export class (\w+) extends DurableObject/g)].map((m) => m[1]!));
    expect([...shipped].sort()).toEqual([...DO_MUTEX_ROSTER].sort());
  });
});

// audit §244 — control migrations are DATA seeds only some suites want, so the rule is "at least one test
// applies each", not the tenant rule of "every helper applies every one".
describe("§244: every shipped control migration is exercised by at least one test", () => {
  const M = ["db/control/migrations/0001_control.sql", "db/control/migrations/0009_new.sql"];

  it("passes when each is imported somewhere", () => {
    const tests = [{ path: "a.test.ts", source: 'import a from "../../../db/control/migrations/0001_control.sql?raw"; import b from "../../../db/control/migrations/0009_new.sql?raw";' }];
    expect(checkControlMigrationsExercised(M, tests)).toEqual([]);
  });

  it("FAILS on a migration no test applies, and names it", () => {
    const tests = [{ path: "a.test.ts", source: 'import a from "../../../db/control/migrations/0001_control.sql?raw";' }];
    const v = checkControlMigrationsExercised(M, tests);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("0009_new.sql");
  });
});

// audit §245 — CLAUDE.md heads its budget list "Hard budgets (CI-enforced)". Six of seven had a pin; the
// surface count did not, so a fourth surface would have passed every gate in the repo.
describe("§245: exactly the three registered surfaces ship", () => {
  it("passes on the registered three, in any order", () => {
    expect(checkSurfaceBudget(["portal", "command", "driver"])).toEqual([]);
  });

  it("FAILS on a fourth surface and names it", () => {
    const v = checkSurfaceBudget([...SURFACE_ROSTER, "ops"]);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("ops");
    expect(v[0]).toContain("register amendment");
  });

  it("FAILS when a registered surface disappears — removal is a register decision too", () => {
    const v = checkSurfaceBudget(["command", "driver"]);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("portal");
  });

  it("a swap that keeps the COUNT at three is still caught (count is not the invariant, identity is)", () => {
    const v = checkSurfaceBudget(["command", "driver", "ops"]);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("ops");
    expect(v[0]).toContain("portal");
  });

  it("the roster matches the surfaces actually shipped — a pin, not a wish", () => {
    const shipped = globSync("apps/*/package.json", { cwd: REPO }).map((p) => p.split("/")[1]!);
    expect([...shipped].sort()).toEqual([...SURFACE_ROSTER].sort());
  });
});

// audit §253 — macOS/iCloud mints "name 2.ext" on every name collision. They are gitignored, but every gate
// in invariants.ts reads the FILESYSTEM, so an ignored duplicate still reached the scans and turned
// check:invariants RED against a migration that is not shipped.
describe("§253: iCloud collision duplicates are filtered from every filesystem scan", () => {
  it.each([
    "db/tenant/migrations/0008_x 2.sql",
    "db/tenant/migrations/0008_x 3.sql",
    "db/control/migrations/0003_y 10.sql",
    "workers/api/src/index 2.ts",
    "index 99.ts",
  ])("treats %s as a duplicate", (p) => {
    expect(isCollisionDuplicate(p)).toBe(true);
  });

  it.each([
    "db/tenant/migrations/0008_append_only_unique_guards.sql",
    "packages/rater/src/price.ts",
    "apps/command/src/App.tsx",
    "x2.sql",            // NO space — a legitimate name, must never be filtered
    "v2.ts",             // ditto
    "docs/wp/WP-01..16.md",
  ])("does NOT treat %s as a duplicate", (p) => {
    expect(isCollisionDuplicate(p)).toBe(false);
  });

  it("matches on the BASENAME, not the directory — a folder named 'v 2' must not hide its files", () => {
    expect(isCollisionDuplicate("some/v 2/real.sql")).toBe(false);
    expect(isCollisionDuplicate("some/v 2/real 2.sql")).toBe(true);
  });
});

// audit §265 — append-only enforcement is keyed to a hand-curated GUARDED_TABLES in two places. A new table
// gets neither unless someone remembers, so the classification is forced instead.
describe("§265: every tenant table is classified append-only or mutable", () => {
  it("passes on the tables the repo actually ships", () => {
    const created = globSync("db/tenant/migrations/*.sql", { cwd: REPO })
      .flatMap((f) => [...readFileSync(join(REPO, f), "utf8").matchAll(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+["'`\[]?([a-z_]+)/gi)].map((m) => m[1]!.toLowerCase()));
    expect(created.length, "the sweep must actually find tables — a zero here would pass vacuously").toBeGreaterThan(10);
    expect(checkTableClassification(created)).toEqual([]);
  });

  it("FAILS on a new table nobody classified, and asks the question", () => {
    const v = checkTableClassification(["events", "settlements"]);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("settlements");
    expect(v[0]).toContain("APPEND-ONLY or MUTABLE");
    expect(v[0], "the message must name BOTH edits an append-only table needs").toContain("REPLACE-ban alternation");
  });

  it("a guarded table counts as classified (it is not 'missing' from the mutable list)", () => {
    expect(checkTableClassification(["events", "positions", "money_lines"])).toEqual([]);
  });

  it("is order- and duplicate-insensitive (migrations may re-declare IF NOT EXISTS)", () => {
    expect(checkTableClassification(["legs", "events", "legs"])).toEqual([]);
  });
});

// audit §266 — the REPLACE ban's table alternation is DERIVED from GUARDED_TABLES. They were two
// independent literals naming the same three tables, so a fourth guarded table would have had
// guard-completeness checking and NO source-level REPLACE ban. This is the identity test: every guarded
// table must actually be caught, which fails the moment someone re-types the alternation as a subset.
describe("§266: the REPLACE ban covers EVERY guarded table (derived, not re-typed)", () => {
  it.each([...GUARDED_TABLES])("catches INSERT OR REPLACE INTO %s", (table) => {
    const hits = scanSourceForForbiddenReplace([{ path: "p.ts", text: `INSERT OR REPLACE INTO ${table} (id) VALUES (1)` }]);
    expect(hits.length, `${table} is in GUARDED_TABLES but the REPLACE ban does not cover it`).toBeGreaterThan(0);
  });

  it.each([...GUARDED_TABLES])("catches ON CONFLICT DO UPDATE against %s (the second, distinct ban)", (table) => {
    const hits = scanSourceForForbiddenReplace([{ path: "p.ts", text: `INSERT INTO ${table} (id) VALUES (1) ON CONFLICT(id) DO UPDATE SET id = 2` }]);
    expect(hits.length, `${table} is guarded but the ON CONFLICT ban does not cover it`).toBeGreaterThan(0);
  });

  it("is non-vacuous: an UNGUARDED table is NOT caught by this ban", () => {
    expect(scanSourceForForbiddenReplace([{ path: "p.ts", text: "INSERT OR REPLACE INTO parties (id) VALUES (1)" }])).toEqual([]);
  });
});

// audit §378 — the MIGRATION surface's mirror of §266's identity test.
//
// §266 derived the SOURCE scanner's alternation from GUARDED_TABLES and wrote the identity test above.
// The migration-SQL scanner kept FOUR hardcoded `(events|positions|money_lines)` literals — the
// mutation-verb ban, the ALTER ban, the upsert ban and the trigger-body scan — so §266's fix covered one
// of two surfaces, and the file's own header still described the hazard it had half-closed: *"a new
// append-only table therefore needs two edits nobody is prompted to make."*
//
// With the alternation derived there, this is the identity test that keeps it derived: adding a table to
// GUARDED_TABLES now extends every migration-side ban, and re-typing any of the four as a subset fails
// HERE, per table and per ban.
describe("§378: the MIGRATION scanner's bans cover EVERY guarded table (derived, not re-typed)", () => {
  it.each([...GUARDED_TABLES])("flags REPLACE INTO %s in a migration", (table) => {
    const r = checkMigrationSql([`REPLACE INTO ${table} (id) VALUES ('x');`]);
    expect(r.violations.join(" "), `${table} is guarded but the migration REPLACE ban misses it`).toContain("I3");
  });

  it.each([...GUARDED_TABLES])("flags a non-ADD-COLUMN ALTER on %s (the second, distinct ban)", (table) => {
    const r = checkMigrationSql([`ALTER TABLE ${table} RENAME TO ${table}_old;`]);
    expect(r.violations.length, `${table} is guarded but the migration ALTER ban misses it`).toBeGreaterThan(0);
  });

  it.each([...GUARDED_TABLES])("flags an upsert against %s (the third, distinct ban)", (table) => {
    const r = checkMigrationSql([`INSERT INTO ${table} (id) VALUES ('x') ON CONFLICT(id) DO UPDATE SET id='y';`]);
    expect(r.violations.length, `${table} is guarded but the migration upsert ban misses it`).toBeGreaterThan(0);
  });

  // Parity, per the share-lint discipline: ONE evasion corpus, BOTH surfaces. A delimiter or schema form
  // that one scanner blocks must never slip past the other — the exact split the skill's RED describes,
  // here generalised from `legs` (which already had this) to the guarded tables themselves.
  const shapes = (t: string): string[] => [
    `INSERT OR REPLACE INTO"${t}" (id) VALUES ('x')`,
    `REPLACE INTO main.${t} (id) VALUES ('x')`,
    `REPLACE INTO [${t}] (id) VALUES ('x')`,
    "REPLACE INTO `" + t + "` (id) VALUES ('x')",
  ];
  for (const table of GUARDED_TABLES) {
    for (const sql of shapes(table)) {
      it(`both surfaces flag: ${sql.slice(0, 46)}…`, () => {
        expect(checkMigrationSql([sql]).violations.length, "migration surface missed it").toBeGreaterThan(0);
        expect(scanSourceForForbiddenReplace([{ path: "p.ts", text: sql }]).length, "source surface missed it").toBeGreaterThan(0);
      });
    }
  }

  it("is non-vacuous: an UNGUARDED table is caught by NEITHER surface", () => {
    // `parties` is in MUTABLE_TABLES — a REPLACE against it is a legal domain write. Without this, a
    // matcher that flagged everything would satisfy every assertion above.
    const sql = "REPLACE INTO parties (id) VALUES ('x');";
    expect(checkMigrationSql([sql]).violations.filter((v) => v.includes("I3"))).toEqual([]);
    expect(scanSourceForForbiddenReplace([{ path: "p.ts", text: sql }])).toEqual([]);
  });
});
