import { describe, expect, it } from "vitest";
import { ownerOf, owners, recall, splitTerms, type Hit } from "./recall.js";

// §1068 — the value of `recall` is entirely in ATTRIBUTION: a raw grep already finds the lines, and finding
// lines is what failed three times. So the tests pin the owner-resolution, not the matching.

const audit = [
  "## §798 — PHASE GATE: every fail-closed PORT",
  "some prose about NotConfiguredMigrator",
  "",
  "## §1000 — PHASE GATE: something later",
  "another mention of NotConfiguredMigrator",
];

describe("§1068: recall attributes a mention to the verdict that owns it", () => {
  it("maps a line to the NEAREST PRECEDING section, not the first or the last", () => {
    // The whole point. A grep says "line 5"; this says "§1000 decided it", which is the actionable half.
    expect(ownerOf(audit, 1, "docs/audits/x.md")).toContain("§798");
    expect(ownerOf(audit, 4, "docs/audits/x.md")).toContain("§1000");
  });

  it("attributes a checklist hit to its ROW, not to a section", () => {
    // The checklist has no `## §N` headings; its unit of decision is the row, and cell 0 is what the row is
    // ABOUT (§993's column rule — cells 2+ are narrative, where a passing mention proves nothing).
    const rows = ["| **The workspace runs TWO vitest majors** | Low | Repo | … |"];
    expect(ownerOf(rows, 0, "docs/ops/GO-LIVE-CHECKLIST.md")).toBe("row: The workspace runs TWO vitest majors");
  });

  it("says so rather than guessing when nothing owns the line", () => {
    expect(ownerOf(["a line before any heading"], 0, "docs/audits/x.md")).toBe("(no owning section)");
  });

  it("dedupes owners in first-appearance order (N mentions ≠ N verdicts)", () => {
    const hits = [
      { source: "a", line: 1, owner: "§798 — x", text: "" },
      { source: "a", line: 2, owner: "§798 — x", text: "" },
      { source: "a", line: 9, owner: "§1000 — y", text: "" },
    ] satisfies Hit[];
    expect(owners(hits)).toEqual(["§798 — x", "§1000 — y"]);
  });

  it("finds the REAL prior verdict this tool was written for (non-vacuity, against the live record)", () => {
    // A unit test over a fixture proves the parser; this proves the tool answers the question that cost §1067
    // a phase. If the audit is renamed or the heading reworded, this fails rather than silently returning [].
    const found = owners(recall("NotConfiguredMigrator"));
    expect(found.length, "no owning verdict found for a term the record demonstrably decided").toBeGreaterThanOrEqual(1);
    expect(found.join(" | "), "§798's verdict is no longer discoverable by the tool written to find it").toContain("§798");
  });

  it("reports a genuinely new term as new, so 'nothing found' is a usable answer", () => {
    expect(recall("zzz-no-such-term-in-any-record-zzz")).toEqual([]);
  });
});

// §1195 — THE FAILURE THIS TOOL HAD: a multi-word question answered as NOVELTY.
//
// `recall()` is a literal `includes` and the CLI joins all argv into one string. For its advertised usage (a
// single symbol) that is right; for the way it is actually used — a question in words — a phrase that nobody
// wrote verbatim produced "It is genuinely new — trace the code". Measured at §1195: four such verdicts in one
// session, at least one demonstrably covered elsewhere. These pin the CONDITION the fix keys on, so a
// regression that restores the old behaviour has to falsify a fact about the live record.
describe("§1195: a phrase miss is not novelty", () => {
  it("splitTerms yields the searchable terms, deduped, dropping noise shorter than 3 chars", () => {
    expect(splitTerms("drain order stranding a to")).toEqual(["drain", "order", "stranding"]);
    expect(splitTerms("drain drain order")).toEqual(["drain", "order"]);
    expect(splitTerms("NotConfiguredMigrator"), "a single symbol stays a single term").toEqual(["NotConfiguredMigrator"]);
  });

  // ASSEMBLED, never written as a literal. The first draft hardcoded the phrase and went RED the moment §1195
  // quoted it in the audit — a record describing an absent string makes it present, which is the same collision
  // §1187 met with a backticked symbol and §1188 with a section number. The premise assertion caught it, which
  // is exactly why it is asserted rather than assumed. Joining the terms here means no file anywhere contains
  // the phrase, so the premise cannot be falsified by writing ABOUT it.
  const ABSENT_PHRASE = ["drain", "order", "stranding"].join(" ");

  it("the exact multi-word PHRASE is absent from the live record", () => {
    expect(recall(ABSENT_PHRASE), "premise: nobody wrote this sentence").toHaveLength(0);
  });

  it("…while its TERMS are in the record — which is why the phrase miss must not claim novelty", () => {
    const covered = splitTerms(ABSENT_PHRASE).filter((t) => recall(t).length > 0);
    expect(
      covered,
      "a phrase whose terms are all absent would be genuinely new; these are not, and the CLI must say so",
    ).not.toHaveLength(0);
  });

  it("a single-term query still answers directly — the fix does not change the advertised usage", () => {
    expect(recall("drain-order").length, "the hyphenated symbol is a real prior verdict").toBeGreaterThan(0);
  });
});
