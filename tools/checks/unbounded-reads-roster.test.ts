import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// REQ-197/010 §794 — THE UNBOUNDED-READ HOLD, KEPT HONEST.
//
// `docs/ops/GO-LIVE-CHECKLIST.md` carries a filed, deliberately-unfixed hold: *"Unbounded list reads — 7
// sites, no LIMIT and no cursor"* (audit §183, re-verified §470). Every row a tenant has ever accumulated is
// loaded into one 128 MB Worker response. The decision to file rather than fix is the owner's and stands;
// what did NOT exist was anything keeping the record true.
//
// §470 re-verified BY HAND. A hand-verified hold is exactly the kind whose verdict dies silently: the sites
// can be fixed (and the doc then over-states the risk), or — worse — "fixed" with a bare `LIMIT`, which
// TRUNCATES SILENTLY and is the one remedy this repo forbids (the Migrator no-silent-drops rule; the
// checklist says so explicitly, and REQ-197/010 already established keyset cursors as the correct shape).
//
// This gate asserts the roster BOTH WAYS (§745):
//   · every listed site is STILL unbounded → the checklist's count is not over-stating a solved problem;
//   · a site that GAINS a bound fails → whoever fixed it updates the doc, and the reviewer gets to check
//     that the bound is a CURSOR and not a silent truncation.
//
// It deliberately does NOT try to discover new unbounded reads. A general detector over this tree finds ~29
// candidates against the checklist's 7, because most are bounded by a single-entity `WHERE` (one shipment's
// legs, one stream's events) — a ratio that would make the gate noise. Discovery stays the audit's job; this
// gate's job is that the filed answer does not rot.

/** The filed sites: file + a distinctive fragment of the SQL statement itself. */
const ROSTER: ReadonlyArray<{ file: string; anchor: string; what: string }> = [
  { file: "workers/api/src/routes/invoices.ts", anchor: "INVOICE_COLS_TENANT", what: "tenant lens — every invoice, no WHERE at all (the worst)" },
  { file: "workers/api/src/routes/invoices.ts", anchor: "INVOICE_COLS_PARTY", what: "party lens — every invoice for a party" },
  { file: "workers/api/src/routes/watchtower.ts", anchor: "FROM anomalies", what: "status=all drops the WHERE" },
  { file: "workers/api/src/routes/dunning.ts", anchor: "drafted_by_agent", what: "the dunning draft queue" },
  { file: "workers/api/src/routes/export.ts", anchor: "DOC_EXPORT_COLS", what: "export paginates EVENTS but returns ALL documents" },
  { file: "workers/api/src/routes/export.ts", anchor: "tsa_receipt", what: "every anchor receipt" },
  { file: "packages/ledger/src/parity.ts", anchor: "FROM events WHERE kind IN", what: "every native+legacy event of the backing kinds, FULL PAYLOADS" },
  { file: "workers/agents/src/watchtower.ts", anchor: "quote.priced", what: "every anomalous quote ever, on the daily cron" },
];

/** The prepare() template containing `anchor`, or undefined. Brace-free: SQL lives in one template literal. */
function statementContaining(src: string, anchor: string): string | undefined {
  for (const m of src.matchAll(/prepare\(\s*(`[^`]*`|"(?:[^"\\]|\\.)*")/g)) {
    const sql = m[1]!;
    if (sql.includes(anchor)) return sql;
  }
  return undefined;
}

describe("REQ-197/010 §794: the filed unbounded-read hold still describes reality", () => {
  const root = repoRoot();

  it.each(ROSTER)("$file — $what is still unbounded", ({ file, anchor }) => {
    const sql = statementContaining(readFileSync(`${root}/${file}`, "utf8"), anchor);
    expect(
      sql,
      `the roster's anchor "${anchor}" no longer names a prepared statement in ${file}. Either the read moved ` +
        "or it was rewritten — re-verify it against docs/ops/GO-LIVE-CHECKLIST.md and update BOTH.",
    ).toBeDefined();
    expect(
      /\bLIMIT\b/i.test(sql!),
      `${file} (${anchor}) now carries a LIMIT. If that is a KEYSET CURSOR, good — drop this row from the ` +
        "roster and from the GO-LIVE-CHECKLIST, because the hold just shrank and the record must say so. If " +
        "it is a BARE LIMIT, it is the wrong fix: it truncates silently, which this repo forbids (REQ-197/010 " +
        "established the cursor shape for exactly this).",
    ).toBe(false);
  });

  it("the checklist still files this hold at the roster's size (doc and code agree)", () => {
    // The doc groups the two invoices sites into one row, so it reads "7 sites" for 8 statements. Asserting
    // the DOC still carries the hold at all is the part that matters: a doc that quietly dropped the row
    // while the reads stayed unbounded is the failure this pairs against.
    const doc = readFileSync(`${root}/docs/ops/GO-LIVE-CHECKLIST.md`, "utf8");
    expect(doc, "the GO-LIVE-CHECKLIST no longer files the unbounded-read hold, but the reads are still unbounded").toMatch(
      /Unbounded list reads/,
    );
    expect(ROSTER.length, "roster size changed — update the checklist row in the same commit").toBe(8);
  });
});
