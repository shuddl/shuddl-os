import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// REQ-116/I8 §1767 — AN INSERT THAT OMITS A DEFAULTED COLUMN TAKES THE DEFAULT, AND THE DEFAULT MAY MEAN "ACT".
//
// §1766 found `documents.created_ts INTEGER NOT NULL DEFAULT 0`, which for the retention sweep is the
// MAXIMALLY-EXPIRED value: a row written without the column is born expired and its R2 bytes are deleted on
// the next tick. One instance is a bug; the question this gate answers is whether it was an epidemic.
//
// SWEPT (§1767): 47 defaulted columns across 19 tables, against every production INSERT. Zero further live
// instances, for two structural reasons worth writing down because they are what this gate protects:
//
//   1. THE MAJORITY OF DEFAULTS ARE COLLECTIONS. `'[]'` / `'{}'` on a JSON column means "empty", which is the
//      same thing an omitting writer means. Omitting them is not merely safe, it is the intended shape — so
//      flagging them would be pure noise, and this gate ignores them by construction.
//   2. THE SCALAR ONES ARE ALL WRITTEN. Every scalar-defaulted column is named by every writer of its table,
//      with the two `documents` exceptions allowlisted below. The events path is stronger still: it binds
//      `?? null` into NOT NULL columns, so an absent value is a LOUD abort rather than a silent default.
//
// So this gate does not report a backlog. It is a RATCHET: the next INSERT that omits a scalar defaulted
// column fails here, and whoever adds it either names the column or writes down why the default is safe for
// every reader of it. That question — safe for the READER, not merely valid for the column — is the one
// §1766 shows is easy to skip.
//
// THE PROBE'S OWN FAILURE MODE, FIXED HERE. The first version read the column list with `\(([^)]*)\)` and
// reported the sequencer's events INSERT as omitting `source`, `confidence` and three more — a five-column
// false alarm on the ledger's central write path. The list is built as `${EVENT_COLUMNS.join(",")}`, so the
// regex captured an interpolation, not columns. Column lists are therefore resolved through the named array
// when the SQL interpolates one, and a statement whose list cannot be resolved is a FAILURE, never a skip:
// an unreadable list is exactly what an omission looks like.

/** Tables whose defaults are worth policing at all — everything else is JSON-collection noise. */
const COLLECTION_DEFAULT = /^\s*NOT NULL DEFAULT '(\[\]|\{\})'/;

interface DefaultedColumn {
  table: string;
  column: string;
  clause: string;
}

/** Every `NOT NULL DEFAULT <scalar>` column in the migrations (collections excluded — see the header). */
function scalarDefaultedColumns(sql: string): DefaultedColumn[] {
  const out: DefaultedColumn[] = [];
  for (const m of sql.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\)\s*(?:STRICT)?\s*;/g)) {
    const table = m[1]!;
    for (const c of m[2]!.matchAll(/(?:^|,)\s*(\w+)\s+(?:TEXT|INTEGER|REAL|BLOB)\b([^,]*)/g)) {
      const clause = c[2]!;
      if (clause.includes("DEFAULT") && !COLLECTION_DEFAULT.test(clause)) {
        out.push({ table, column: c[1]!, clause: clause.trim() });
      }
    }
  }
  for (const m of sql.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+) (?:TEXT|INTEGER|REAL|BLOB)([^;]*);/g)) {
    if (m[3]!.includes("DEFAULT") && !COLLECTION_DEFAULT.test(m[3]!)) {
      out.push({ table: m[1]!, column: m[2]!, clause: m[3]!.trim() });
    }
  }
  return out;
}

/**
 * The column names an INSERT statement writes. Handles a literal list AND the `${NAME.join(",")}` form the
 * ledger's hot paths use — resolving NAME's array literal in the same file. Returns undefined when the list
 * cannot be resolved, which callers must treat as a failure rather than a skip.
 */
function insertColumns(src: string, stmt: string): string[] | undefined {
  const interp = /INSERT(?: OR \w+)? INTO \w+ \(\$\{(\w+)\.join\(/.exec(stmt);
  if (interp !== null) {
    const decl = new RegExp(`const ${interp[1]!}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`).exec(src);
    if (decl === null) return undefined;
    return [...decl[1]!.matchAll(/"(\w+)"/g)].map((m) => m[1]!);
  }
  const literal = /INSERT(?: OR \w+)? INTO \w+ \(([^)]*)\)/.exec(stmt);
  if (literal === null || literal[1]!.includes("${")) return undefined;
  return literal[1]!.split(",").map((c) => c.trim());
}

/**
 * Writers that deliberately omit a scalar-defaulted column, each with the reason the default is right FOR
 * ITS READERS. A row here is a claim, not a suppression — it says someone checked.
 */
const ALLOWED: ReadonlyArray<{ file: string; table: string; column: string; why: string }> = [
  {
    file: "packages/ledger/src/anchor.ts",
    table: "documents",
    column: "created_ts",
    why:
      "the daily tsa_receipt takes DEFAULT 0. That is the maximally-expired value, and it is safe for two " +
      "independent reasons: the retention sweep excludes tsa_receipt BY KIND (§1536), and since §1766 it also " +
      "floors any candidate whose clock is unknown. Do NOT copy this row for a new kind.",
  },
  {
    file: "packages/ledger/src/anchor.ts",
    table: "documents",
    column: "retention_status",
    why: "DEFAULT 'active' is the truthful value at write time — the bytes were just stored (row-iff-bytes).",
  },
  {
    file: "workers/api/src/routes/evidence.ts",
    table: "documents",
    column: "retention_status",
    why: "same: 'active' is what an evidence upload means, and the sweep is the only writer of 'expired'.",
  },
  // ── shipments.mode / shipments.division — DEFAULTS THAT DESCRIBE, RATHER THAN DECIDE ───────────────────
  // Unlike created_ts, no gate, sweep or money path branches on either. `mode` is read by the Migrator (which
  // MAPS an incoming value, never the stored one), by intake and the MCP quote tool (both of which SET it),
  // and for display. `division` reaches the journal only through money_lines, which carry their OWN division
  // — the money projection resolves `deps.division ?? "main"`, the same fallback, so an omitted shipments
  // column cannot make the export disagree with the ledger.
  {
    file: "packages/ledger/src/projection/status-cache.ts",
    table: "shipments",
    column: "mode",
    why:
      "the booking projection cannot know it: BookingCreatedPayload requires the four party FKs + division and " +
      "makes `mode` an OPTIONAL refinement, so a booking that carries none must project SOMETHING. 'LTL' is " +
      "the modal case and is descriptive only — nothing gates on it.",
  },
  {
    file: "workers/agents/src/concierge.ts",
    table: "shipments",
    column: "mode",
    why: "an inbound email states no mode; inventing one would be worse than the descriptive default.",
  },
  {
    file: "workers/agents/src/concierge.ts",
    table: "shipments",
    column: "division",
    why:
      "an inbound email states no division either. 'main' matches what the money projection independently " +
      "falls back to, so the shipments row and the journal agree rather than drifting.",
  },
  {
    file: "tools/seed/load.ts",
    table: "shipments",
    column: "mode",
    why: "the seed loader writes fixture shipments; mode is not part of any fixture assertion.",
  },
  {
    file: "tools/deploy/staging-smoke.ts",
    table: "shipments",
    column: "mode",
    why: "a smoke-test row, never read for a decision.",
  },
  {
    file: "tools/deploy/staging-smoke.ts",
    table: "shipments",
    column: "division",
    why: "a smoke-test row, never read for a decision.",
  },
];

const allowed = (file: string, table: string, column: string): string | undefined =>
  ALLOWED.find((a) => a.file === file && a.table === table && a.column === column)?.why;

describe("REQ-116/I8 §1767: no production INSERT silently takes a scalar column DEFAULT", () => {
  const root = repoRoot();
  const migrations = execSync("cat db/tenant/migrations/*.sql db/control/migrations/*.sql", {
    cwd: root,
    encoding: "utf8",
  });
  const defaulted = scalarDefaultedColumns(migrations);

  it("the migration corpus is non-empty and carries the column §1766 was about (floor on the INPUT)", () => {
    // Without this, a glob that matched nothing would report a clean sweep — the failure mode this repo has
    // already paid for more than once. Assert the corpus, not just the findings.
    expect(defaulted.length, "no scalar-defaulted columns parsed — the migration glob or the parser broke").toBeGreaterThan(5);
    expect(defaulted.some((d) => d.table === "documents" && d.column === "created_ts")).toBe(true);
    // …and that the collection filter is actually filtering, rather than the parser finding nothing.
    expect(defaulted.some((d) => d.column === "party_refs"), "party_refs DEFAULT '[]' is a collection — it must be filtered out").toBe(false);
  });

  it("every INSERT either names each scalar-defaulted column or is allowlisted with a reason", () => {
    const grep = execSync(
      "git grep -n -E 'INSERT( OR (IGNORE|ABORT|FAIL))? INTO ' -- " +
        "'packages/**/*.ts' 'workers/**/*.ts' 'tools/**/*.ts' " +
        // `tools/checks/**` is EXCLUDED because those files QUOTE SQL rather than execute it. KEPT after
        // §1774 generalised the rule to "no `.prepare(`, no execution", which subsumes it — a gate that
        // both quotes SQL and holds a D1 handle would otherwise be judged on its detection patterns. The
        // append-chokepoint scanner carries `INSERT INTO events` inside a detection pattern. Scanning a
        // scanner is the classic semantic false positive, and it has a permanent floor: any gate that reads
        // SQL will contain SQL. The exclusion is by DIRECTORY, which is exactly the set that never holds a
        // D1 handle — verified: nothing under tools/checks imports a database binding.
        "':(exclude)tools/checks/**' ':(exclude)**/test/**' ':(exclude)**/*.test.ts'",
      { cwd: root, encoding: "utf8" },
    );
    const problems: string[] = [];
    for (const line of grep.split("\n").filter(Boolean)) {
      const at = line.indexOf(":");
      const file = line.slice(0, at);
      const stmt = line.slice(line.indexOf(":", at + 1) + 1);
      const table = /INSERT(?: OR \w+)? INTO (\w+)/.exec(stmt)?.[1];
      if (table === undefined) continue;
      // A FILE THAT CANNOT PREPARE A STATEMENT CANNOT EXECUTE ONE (§1774). The first version of this gate
      // excluded `tools/checks/**` by directory, on the true-but-narrow premise that scanners quote SQL. The
      // class is larger than that directory: `tools/acceptance/demos.ts` names an INSERT INTO the pairings
      // table in a PROSE field explaining that nothing performs it, and this gate read the sentence as the
      // deed. The discriminator is not where the file lives but whether it can run SQL at all — no
      // `.prepare(`, no execution, so INSERT-shaped text in it is prose. Checked per FILE, not per line,
      // because the statement and its prepare are routinely far apart (the Collector hoists its SQL to
      // module scope).
      const body = readFileSync(`${root}/${file}`, "utf8");
      if (!body.includes(".prepare(")) continue;
      const wanted = defaulted.filter((d) => d.table === table);
      if (wanted.length === 0) continue;
      const cols = insertColumns(readFileSync(`${root}/${file}`, "utf8"), stmt);
      if (cols === undefined) {
        problems.push(`${file}: cannot resolve the column list of an INSERT INTO ${table} — an unreadable list is indistinguishable from an omission`);
        continue;
      }
      for (const d of wanted) {
        if (cols.includes(d.column)) continue;
        if (allowed(file, table, d.column) !== undefined) continue;
        problems.push(
          `${file}: INSERT INTO ${table} omits \`${d.column}\` (${d.clause}). The row will take that DEFAULT. ` +
            "Name the column, or add an ALLOWED entry saying why the default is right FOR EVERY READER of it — " +
            "§1766's `created_ts DEFAULT 0` was valid for the column and meant \"delete me\" to the sweep.",
        );
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("every allowlist row still describes a real omission (a stale exemption is deleted, not kept)", () => {
    for (const a of ALLOWED) {
      const src = readFileSync(`${root}/${a.file}`, "utf8");
      const stmt = new RegExp(`INSERT(?: OR \\w+)? INTO ${a.table} \\([^)]*\\)`).exec(src)?.[0];
      expect(stmt, `${a.file} no longer INSERTs INTO ${a.table} — delete this allowlist row`).toBeDefined();
      expect(
        insertColumns(src, stmt!)?.includes(a.column),
        `${a.file} now NAMES \`${a.column}\` in its INSERT INTO ${a.table}. Good — delete this allowlist row, ` +
          "because an exemption that no longer exempts anything is a claim nobody re-checks.",
      ).toBe(false);
    }
  });
});
