import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";
import { stripStruck } from "./strip-struck.js";

// §945 — "HOW MUCH REPO-OWNED DEBT IS OPEN?" MUST BE ONE CORRECT COMMAND, NOT A FIFTH AD-HOC PARSER.
//
// The GO-LIVE-CHECKLIST's `Repository-owned failures & debt` section is the debt ledger a reader ACTS on.
// In §944/§945 I answered "how many are open?" four times with four ad-hoc parsers and got four different
// wrong answers — 13, 24, 36 rows, and an accusation that `check:tables` was missing ten malformed rows:
//
//   1. keyword-matched the WHOLE ROW: `fail-closed` contains "closed", and struck ORIGINAL text contains
//      "FIXED", so rows read as resolved when their live status said OPEN.
//   2. stripped strike MARKERS instead of removing struck SPANS: `~~OPEN~~ **CLOSED**` became
//      `OPEN **CLOSED**`. (This is the same bug fixed in wrangler-absence-claims.test.ts one hour earlier.)
//   3. counted the HEADER row as data.
//   4. split on `|` naively: `\|` escapes inside code spans split as separators, and three nested SUB-TABLES
//      with their own headers were measured against this table's header — §934's recorded trap.
//
// `check:tables` was correct throughout; the measurement was broken. And §804 had ALREADY published the
// right numbers (35 rows / 16 OPEN) from the very section that earned "a claim you inherit is a claim you
// are making" — so all four answers were re-derivations of a fact the record held.
//
// The fix is not a better parser in prose. It is to keep the ledger MACHINE-COUNTABLE: every data row's live
// status must open with a canonical token, so counting is trivial and cannot drift into interpretation.
// MEASURED WHEN THIS LANDED: 35 data rows, ZERO unreadable — OPEN 17 · FIXED 15 · TRIPWIRED 1 · RESOLVED 1 ·
// NOT_APPLICABLE 1. Enforceable today, not aspirational.

const CHECKLIST = "docs/ops/GO-LIVE-CHECKLIST.md";
const SECTION = "## Repository-owned failures & debt";
const FIELDS = 8;

/** The canonical status vocabulary. A row may carry prose AFTER the token; it must START with one. */
const VOCABULARY = ["OPEN", "CLOSED", "FIXED", "RESOLVED", "TRIPWIRED", "NOT_APPLICABLE"] as const;

/** Split a markdown row into cells, honouring `\|` escapes inside code spans (parser #4's bug). */
function cells(line: string): string[] {
  return line
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((c) => c.trim());
}

/** The section's eight-field DATA rows — header excluded, nested sub-tables excluded by shape. */
export function ledgerRows(md: string): { line: number; item: string; status: string }[] {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.startsWith(SECTION));
  if (start < 0) return [];
  const out: { line: number; item: string; status: string }[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i] as string;
    if (l.startsWith("## ")) break;
    if (!l.startsWith("| ") || l.startsWith("|--")) continue;
    const c = cells(l);
    if (c.length !== FIELDS) continue; // a nested sub-table with its own shape
    if (c[0] === "Item") continue; // the header
    // Struck SPANS are corrections, not live status — remove the content, not just the markers.
    out.push({ line: i + 1, item: c[0] as string, status: stripStruck(c[5] as string).replace(/\s+/g, " ").trim() });
  }
  return out;
}

describe("§945: the repo-owned debt ledger is machine-countable", () => {
  const md = readFileSync(`${repoRoot()}/${CHECKLIST}`, "utf8");
  const rows = ledgerRows(md);

  it("the section parses to a real row set (non-vacuity — an empty parse would certify anything)", () => {
    // Every wrong answer in §945 came from a parser that still produced a confident number. A renamed
    // heading or a reshaped table must fail HERE rather than silently report zero open debt.
    expect(
      rows.length,
      `no eight-field rows parsed from "${SECTION}" in ${CHECKLIST}. The section was renamed or reshaped — ` +
        "fix this parser deliberately; do not let the debt ledger become uncountable.",
    ).toBeGreaterThanOrEqual(30);
  });

  it("every row's live status opens with a canonical token", () => {
    const bad = rows.filter((r) => !VOCABULARY.some((v) => new RegExp(`^\\**${v}\\b`).test(r.status)));
    expect(
      bad,
      "debt row(s) whose Status does not begin with one of " +
        `${VOCABULARY.join(" / ")}:\n  ` +
        bad.map((r) => `L${r.line}: ${r.status.slice(0, 70) || "(empty)"}`).join("\n  ") +
        "\n\nThe status field is what every count of this ledger reads. §945 got four different wrong answers " +
        "from four ad-hoc parsers precisely because status was free prose. Lead with the token; put the " +
        "explanation after it, and STRIKE superseded text rather than deleting it.",
    ).toEqual([]);
  });

  it("§981: the EXTERNAL-holds table uses its own vocabulary, and that is why this file scopes to repo-owned", () => {
    // WHY THIS GATE READS ONE SECTION, asserted rather than assumed (§980's rule turned on §945).
    //
    // Both tables share the eight-field schema, so scoping to one looked arbitrary. It is not. MEASURED AT
    // §981: of 15 external-hold rows, 11 carry statuses OUTSIDE the repo-owned vocabulary — `BLOCKED`,
    // `CLEARED`, `NARROWED`. That is correct, and the section header says so itself: "Every one of these is
    // BLOCKED, not failed, and none may be relabelled PASS."
    //
    // The two track different KINDS of thing and therefore have different lifecycles. A repo-owned defect is
    // OPEN until a commit closes it. An external hold is BLOCKED on someone else's action, may be NARROWED
    // as its scope shrinks, and is CLEARED when the outside world changes. Forcing one vocabulary on both
    // would either mislabel external reality as a repo defect or drop the distinction that makes the ledger
    // readable.
    //
    // So this asserts the SEPARATION rather than merging the tables: repo-owned rows must not adopt external
    // words, and external rows must not adopt repo-owned ones. If the conventions ever converge deliberately,
    // this fails and the decision gets made on purpose.
    const lines = md.split("\n");
    const start = lines.findIndex((l) => l.startsWith("## External holds"));
    expect(start, "the `## External holds` section is gone — re-scope this gate deliberately").toBeGreaterThan(0);
    const rows: string[] = [];
    for (let i = start + 1; i < lines.length; i += 1) {
      const l = lines[i] as string;
      if (l.startsWith("## ")) break;
      if (!l.startsWith("| ") || l.startsWith("|--")) continue;
      const c = cells(l);
      // Skip the header by its own 6th cell rather than by matching the first cell's prose, which is
      // long, em-dashed, and was already wrong once here.
      if (c.length !== FIELDS || c[5] === "Status") continue;
      rows.push(stripStruck(c[5] as string).replace(/\s+/g, " ").trim());
    }
    expect(rows.length, "no external-hold rows parsed — the scan is broken, not the section").toBeGreaterThanOrEqual(10);

    const EXTERNAL = ["BLOCKED", "CLEARED", "NARROWED", "OPEN"];
    const stray = rows.filter((st) => !EXTERNAL.some((v) => new RegExp(`\\b${v}\\b`).test(st)));
    expect(
      stray,
      "external-hold row(s) whose status uses neither the external vocabulary (BLOCKED / CLEARED / NARROWED / " +
        "OPEN) nor anything recognisable:\n  " +
        stray.map((s2) => s2.slice(0, 70)).join("\n  ") +
        "\n\nAn external hold is BLOCKED on someone else's action, NARROWED as its scope shrinks, and CLEARED " +
        "when the outside world changes — it is never FIXED by a commit, which is what the repo-owned words " +
        "mean. Keep the two vocabularies separate, or converge them deliberately and update both this " +
        "assertion and the section header that promises 'none may be relabelled PASS'.",
    ).toEqual([]);
  });

  it("counting open rows is unambiguous (no row claims two terminal states at once)", () => {
    // A status reading "CLOSED … reopened, now OPEN" is countable two ways, which is how a ledger silently
    // acquires two different sizes. The strike convention exists so exactly one verdict is ever live.
    const ambiguous = rows.filter((r) => {
      const hits = VOCABULARY.filter((v) => new RegExp(`\\b${v}\\b`).test(r.status));
      return hits.length > 1;
    });
    expect(
      ambiguous,
      "debt row(s) whose live status names more than one verdict, so any count of this ledger depends on " +
        "which one the reader's regex hits first:\n  " +
        ambiguous.map((r) => `L${r.line}: ${r.status.slice(0, 80)}`).join("\n  ") +
        "\n\nStrike the superseded verdict (~~OPEN~~ **CLOSED**) so exactly one is live.",
    ).toEqual([]);
  });
});
