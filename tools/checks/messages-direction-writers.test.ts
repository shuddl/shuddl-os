import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// REQ-100/095/032 §1765 — THE `messages.direction` COLUMN INVARIANT, WHICH NOTHING ENFORCED.
//
// `packages/ledger/src/projection/messages.ts` states the guarantee outright:
//
//   > `direction` ('in'|'out') is unconstrained at the DB … The guard is instead the TypeScript
//   > `MessageDirection` union below PLUS this projection being the SOLE writer of the column, so only
//   > 'in'/'out' can ever be inserted.
//
// **The sole-writer half is false.** Three production statements write the column — the projection, the
// Collector's dunning draft, and the Concierge's draft insert — and the two agent sites are raw SQL binds
// that the TypeScript union does not reach. So the stated mechanism did not hold, and nothing else did:
// the same DDL line gives `channel` a `CHECK (channel IN (…))` and gives `direction` none. The constraint
// discipline stopped one column short, on the same line of the same table.
//
// WHY A WRONG VALUE IS SILENT RATHER THAN LOUD — four readers branch on the literal:
//   · `sla-sweep.ts` OVERDUE_SQL          `WHERE m.direction = 'in'`   — a mis-directed inbound loses its SLA
//   · `concierge.ts` sla_due_ts UPDATE    `AND direction = 'in'`       — …and never gets one assigned
//   · `dunning.ts` (two reads)            `AND direction = 'out'`      — a draft vanishes from the queue
// Nothing throws. The row exists, reads fine, and is invisible to exactly the sweep that owed it work.
//
// THE SHAPE OF THIS GATE (the runner/roster split this repo already uses for unbounded reads): the roster
// pins the VALUES at the known sites; a separate discovery assertion fails when a FOURTH writer appears, so
// a new one cannot inherit the guarantee without a reviewer looking at it.
//
// A `CHECK (direction IN ('in','out'))` would make this file unnecessary. That is a table recreate (SQLite
// cannot ALTER-ADD a CHECK) on a mutable read-model, which is legal but is a schema change rather than a
// test; the last assertion here fails if one is ever added, so whoever does it deletes this gate instead of
// leaving two mechanisms for one rule.

/** Every production statement that writes `messages.direction`, with the value it writes. */
const ROSTER: ReadonlyArray<{ file: string; anchor: string; bindAnchor: string; writes: string; what: string }> = [
  {
    file: "packages/ledger/src/projection/messages.ts",
    anchor: "INSERT OR IGNORE INTO messages",
    bindAnchor: "",
    writes: "typed",
    what: "the projection — value comes from the MessageDirection union, so TypeScript is the guard here",
  },
  {
    file: "workers/agents/src/collector.ts",
    anchor: "INSERT OR IGNORE INTO messages",
    // The SQL is a HOISTED constant, so the next `.bind(` after the statement text belongs to a DIFFERENT
    // prepare (the overdue-invoice scan). Anchor on the call site instead — the first version of this gate
    // read that other bind list and reported the Collector malformed. See topLevelArgs' note.
    bindAnchor: "prepare(RECORD_DRAFT_SQL)",
    writes: "out",
    what: "the Collector's dunning draft — a raw bind the union never sees",
  },
  {
    file: "workers/agents/src/concierge.ts",
    anchor: "INSERT OR IGNORE INTO messages",
    bindAnchor: "INSERT OR IGNORE INTO messages",
    writes: "out",
    what: "the Concierge's draft insert — a raw bind the union never sees",
  },
];

const DIRECTIONS = ["in", "out"] as const;

/** The `.bind(...)` argument list that follows `anchor` in `src`, or undefined. */
function bindArgsAfter(src: string, anchor: string): string | undefined {
  const at = src.indexOf(anchor);
  if (at < 0) return undefined;
  const bindAt = src.indexOf(".bind(", at);
  if (bindAt < 0) return undefined;
  // Balanced-paren scan from the opening bracket — bind lists contain nested calls and template literals.
  let depth = 0;
  for (let i = bindAt + ".bind".length; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return src.slice(bindAt + ".bind(".length, i);
    }
  }
  return undefined;
}

/**
 * Split a bind list on its TOP-LEVEL commas. A naive `split(",")` is wrong here and fails toward the
 * alarming answer: `dunningDraftId(inv.id, bucket)` is one argument containing a comma, so the naive split
 * slides every later argument left and reads the WRONG column — which is how the first version of this gate
 * reported the Collector as malformed. Tracks paren/bracket depth and quotes, and drops `//` line comments
 * (the real bind lists annotate their NULL columns).
 */
function topLevelArgs(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let buf = "";
  for (let i = 0; i < list.length; i++) {
    const c = list[i]!;
    const prev = list[i - 1];
    if (quote !== null) {
      buf += c;
      if (c === quote && prev !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      buf += c;
      continue;
    }
    if (c === "/" && list[i + 1] === "/") {
      while (i < list.length && list[i] !== "\n") i++;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) {
      out.push(buf.trim());
      buf = "";
      continue;
    }
    buf += c;
  }
  if (buf.trim() !== "") out.push(buf.trim());
  return out;
}

const quoted = (s: string | undefined): string | undefined => (s === undefined ? undefined : /^["'`](.*)["'`]$/.exec(s)?.[1]);

describe("REQ-100 §1765: every writer of messages.direction writes a member of the union", () => {
  const root = repoRoot();

  it.each(ROSTER.filter((r) => r.writes !== "typed"))("$file — $what", ({ file, anchor, bindAnchor, writes }) => {
    const src = readFileSync(`${root}/${file}`, "utf8");
    expect(src, `the statement "${anchor}" is gone from ${file} — re-verify this roster row`).toContain(anchor);
    const args = bindArgsAfter(src, bindAnchor);
    expect(
      args,
      `no .bind(...) follows "${bindAnchor}" in ${file} — the write moved or was rewritten; re-verify the value ` +
        "it puts in `direction` and update this roster in the same commit.",
    ).toBeDefined();
    // direction is the THIRD column in the shared INSERT column list (id, channel, direction, …), so the
    // third bind argument. Read it positionally rather than by name — the bind list has no names.
    const positional = topLevelArgs(args!);
    // POSITIVE CONTROL on the parser, not decoration: `channel` sits immediately before `direction` and has
    // a DB CHECK, so its legal values are known. If the split ever slides (a nested comma, a template
    // literal), this fails FIRST and names the parser — instead of the next assertion silently grading the
    // wrong column and reporting a defect that is really a mis-parse.
    expect(
      ["email", "sms", "voice", "portal", "note"],
      `${file}: the bind list parser is mis-aligned — argument 2 should be the \`channel\` literal but reads ` +
        `\`${positional[1]}\`. Fix topLevelArgs before trusting anything this test says about \`direction\`.`,
    ).toContain(quoted(positional[1]));
    const third = positional[2];
    expect(third, `${file}: the bind list after "${anchor}" has fewer than three arguments`).toBeDefined();
    const literal = quoted(third);
    expect(
      literal,
      `${file} binds a NON-LITERAL into messages.direction (\`${third}\`). The column has no DB CHECK and ` +
        "four readers branch on the literal value, so a computed direction must be proved to be 'in'|'out' " +
        "at its source — or give the column a CHECK and delete this gate.",
    ).toBeDefined();
    expect(
      DIRECTIONS as readonly string[],
      `${file} writes direction='${literal}', which is not 'in' or 'out'. sla-sweep and the concierge only ` +
        "assign SLAs to direction='in'; the dunning queue only lists direction='out'. A third value is a row " +
        "that reads fine and is invisible to the sweep that owed it work.",
    ).toContain(literal);
    expect(literal, `${file} was rostered as writing '${writes}'`).toBe(writes);
  });

  it("DISCOVERY: no FOURTH writer of the messages table has appeared", () => {
    // The roster pins what it knows; this is the half that notices a new one (the §822 lesson).
    // `git grep` searches TRACKED files only, which is the right scope — an untracked file does not ship —
    // but it means this assertion is blind until the new writer is `git add`ed. Verified by planting a probe:
    // it went unseen until staged, then failed by name (§1765).
    const out = execSync(
      "git grep -lE '(INSERT[^;]{0,40}INTO messages|UPDATE messages)' -- " +
        "'packages/**/*.ts' 'workers/**/*.ts' 'tools/**/*.ts' " +
        "':(exclude)**/test/**' ':(exclude)**/*.test.ts'",
      { cwd: root, encoding: "utf8" },
    );
    const files = out.split("\n").filter(Boolean).sort();
    // concierge.ts also carries the sla_due_ts UPDATE, which READS direction rather than writing it — it is
    // the same file, so the file set is what this compares.
    expect(
      files,
      "a new module writes the `messages` table. If it inserts a row, add it to the ROSTER above with the " +
        "direction it writes; if it only UPDATEs other columns, add it here with a note. Either way a reviewer " +
        "must see it, because `direction` has no DB CHECK.",
    ).toEqual([...new Set(ROSTER.map((r) => r.file))].sort());
  });

  it("the column still has NO CHECK — if one is added, delete this gate rather than keeping both", () => {
    const ddl = readFileSync(`${root}/db/tenant/migrations/0002_domain.sql`, "utf8");
    const table = /CREATE TABLE messages \(([\s\S]*?)\) STRICT;/.exec(ddl);
    expect(table, "the `messages` CREATE TABLE moved out of 0002_domain.sql — re-point this assertion").not.toBeNull();
    const body = table?.[1];
    expect(body, "the `messages` CREATE TABLE matched but captured no body — re-point this assertion").toBeDefined();
    // The sibling column on the same line HAS one, which is what makes the omission worth pinning.
    expect(body!).toMatch(/channel TEXT NOT NULL CHECK \(channel IN \(/);
    expect(
      /direction[^,]*CHECK/i.test(body!),
      "`messages.direction` now carries a DB CHECK — that is strictly better than this roster. Delete this " +
        "file and the SOLE-WRITER note in packages/ledger/src/projection/messages.ts in the same commit.",
    ).toBe(false);
  });
});
