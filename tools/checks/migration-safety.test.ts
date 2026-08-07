import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// REQ-002/118 §590 — A MIGRATION MUST APPLY TO A DATABASE THAT ALREADY HAS ROWS.
//
// SQLite refuses `ALTER TABLE t ADD COLUMN c NOT NULL` on a NON-EMPTY table unless the column carries a
// DEFAULT: there is no value to write into the existing rows. The failure is invisible in development and
// in CI, because both meet an EMPTY database — `applyAll` runs the set once against a fresh D1, and
// `migrate.test.ts` covers the SQL splitter rather than the schema. It surfaces on **deploy**, against the
// one database that has data, at the moment it is least welcome.
//
// This is §579's shape at its most expensive: the discriminating input is not one extra item but an entire
// POPULATED database, so no test builds it.
//
// A static rule beats a dynamic test here, and that is the deliberate choice. A test that seeds rows and
// re-applies the set proves only the eight migrations that exist today; this proves the property for every
// migration ever added, including the one that will be written after nobody remembers this note.
//
// MEASURED when this landed: eight `ADD COLUMN` statements — six nullable, two `NOT NULL DEFAULT …`. Zero
// violations. A clean state locked in, not a defect repaired.

interface AddColumn {
  file: string;
  line: number;
  text: string;
}

function migrationFiles(root: string): string[] {
  return execSync('git ls-files "db/*/migrations/*.sql"', { cwd: root, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
}

/** Every `ALTER TABLE … ADD [COLUMN] …` across the migration set, with the statement text. */
function addColumns(root: string): AddColumn[] {
  const out: AddColumn[] = [];
  for (const f of migrationFiles(root)) {
    readFileSync(`${root}/${f}`, "utf8")
      .split("\n")
      .forEach((raw, i) => {
        // Strip a trailing `-- comment` so an explanatory word like "default" cannot satisfy the rule.
        const line = raw.replace(/--.*$/, "").trim();
        if (!/^ALTER\s+TABLE\s+\S+\s+ADD\s/i.test(line)) return;
        out.push({ file: f, line: i + 1, text: line });
      });
  }
  return out;
}

describe("REQ-002 §590: every migration applies to a populated database", () => {
  const root = repoRoot();

  it("finds the migration set and its ADD COLUMNs (non-vacuity)", () => {
    // A renamed directory would scan nothing and pass — the class this repo met in six gates
    // (§487/§554/§572/§584/§586).
    expect(migrationFiles(root).length, "no migrations found — the scan is broken, not the tree").toBeGreaterThan(8);
    expect(addColumns(root).length, "no ADD COLUMN statements found — the pattern is stale").toBeGreaterThan(5);
  });

  it("no ADD COLUMN is NOT NULL without a DEFAULT", () => {
    const offenders = addColumns(root).filter((c) => /\bNOT\s+NULL\b/i.test(c.text) && !/\bDEFAULT\b/i.test(c.text));
    expect(
      offenders,
      "SQLite cannot add a NOT NULL column to a table that already has rows — there is no value for them. " +
        "This passes on every empty dev/CI database and fails on DEPLOY, against the only database with data. " +
        "Give the column a DEFAULT, or make it nullable and backfill in a separate step:\n  " +
        offenders.map((c) => `${c.file}:${c.line}  ${c.text}`).join("\n  "),
    ).toEqual([]);
  });

  it("no migration DROPs or DELETEs — the set is additive (rule 2, I3/I7)", () => {
    // CLAUDE.md rule 2: no UPDATE/DELETE paths on events, EVER, including migrations. `check:invariants`
    // enforces the events-specific half; this is the broader shape — a DROP of any table or column is
    // unreplayable, and a migration set that is not additive cannot be re-run against a live database.
    const bad: string[] = [];
    for (const f of migrationFiles(root)) {
      readFileSync(`${root}/${f}`, "utf8")
        .split("\n")
        .forEach((raw, i) => {
          const line = raw.replace(/--.*$/, "").trim();
          if (/^\s*(DROP\s+(TABLE|INDEX|COLUMN)|DELETE\s+FROM)\b/i.test(line)) bad.push(`${f}:${i + 1}  ${line}`);
        });
    }
    expect(bad, `a destructive statement in a migration:\n  ${bad.join("\n  ")}`).toEqual([]);
  });
});
