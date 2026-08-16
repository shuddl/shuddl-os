import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §1635 (REQ-118/119) — THE RECORD CANNOT SHRINK.
//
// This audit IS the deliverable of the assurance requirements: every verdict, every measured negative, every
// reopen trigger lives in it and nowhere else. Yet nothing floored its SIZE. Protection against a deleted
// section was entirely INCIDENTAL — `section-refs` reds only when something still POINTS at the deleted
// number, so a section nobody cites can be removed with every gate green.
//
// MEASURED at §1635: of **1619** sections, **6** are referenced only by their own heading — §106, §107, §108,
// §350, §413, §460 — and none is a stub (2.0–3.8 KB each: a routing-containment verdict, a gate-sentinel
// reconciliation, a positive-allowlist finding, a record⇄measurement reconciliation, a revocation-rule reader
// pin, and a closed mirror-asymmetry class). Deleting any of the six erases a measured finding silently.
//
// The other 1613 are held by cross-reference, which is real but accidental: it depends on someone having cited
// them, not on anyone deciding they should survive. `board-citation-ratchet`'s floor (>100 sections citing a
// board) does not help either — it would still pass after 1500 sections were removed.
//
// A WRINKLE WORTH KNOWING BEFORE YOU RE-MEASURE: naming those six above CHANGED the thing measured. They are
// no longer orphans — this header cites them, so `section-refs` now reds if any is deleted. Re-running the
// orphan count today therefore returns a SMALLER number than the one recorded here, and the difference is this
// comment, not a fix. The general property is untouched: the NEXT section nobody cites is deletable again,
// which is why the floor below is a count and not a list of names.
//
// WHY A FLOOR AND NOT A DIFF. Sections are append-only by construction: numbers only ever increase, and a
// retracted verdict is STRUCK IN PLACE (`strip-struck.test.ts` polices the strike form) rather than deleted —
// §1583 is the worked example. So "the count never falls" is exactly the invariant, and it needs no history.
// Same shape as `citation-ratchet`, for the same reason: a record that cannot be rewritten can still be
// prevented from getting smaller.

const AUDIT = "docs/audits/2026-08-01-technical-debt-audit.md";

/**
 * FROZEN at §1635 (2026-08-16): 1619 sections. This may only RISE. If you are lowering it, you are deleting
 * findings — strike them in place instead, which keeps the number and the provenance.
 */
const FLOOR = 1619;

/** PURE: every `## §N` heading in the record. Separate so a synthetic corpus can prove the matcher. */
export function sectionNumbers(text: string): number[] {
  return [...text.matchAll(/^## §(\d+) /gm)].map((m) => Number(m[1]));
}

describe("§1635 REQ-118: the audit record never loses a section", () => {
  const text = readFileSync(`${repoRoot()}/${AUDIT}`, "utf8");

  it("the matcher finds headings and ignores references (positive control)", () => {
    // Without this, a broken regex returning [] would red the floor below and read as a deleted record —
    // the alarming failure, not the silent one, but still the wrong diagnosis.
    const synthetic = ["## §1 — a heading", "prose citing §2 and §3 inline", "## §4 — another heading", "### §5 — not a section (h3)"].join("\n");
    expect(sectionNumbers(synthetic)).toEqual([1, 4]);
  });

  it("the section count never falls below the frozen floor", () => {
    const n = sectionNumbers(text).length;
    expect(
      n,
      `the audit record has ${n} sections but ${FLOOR} were recorded at §1635. A section was DELETED, and ` +
        "deletion is how a measured verdict disappears without any gate objecting — `section-refs` only reds " +
        "when something still points at the number, and 6 sections are cited by nothing at all. If a finding " +
        "was wrong, STRIKE IT IN PLACE (§1583) so the number and the provenance both survive. If you " +
        "deliberately restructured the record, raise the floor in the same commit and say why.",
    ).toBeGreaterThanOrEqual(FLOOR);
  });

  it("section numbers are unique — a duplicate heading silently overwrites a verdict in every reader", () => {
    const nums = sectionNumbers(text);
    const dupes = [...new Set(nums.filter((v, i) => nums.indexOf(v) !== i))];
    expect(dupes, `duplicate §N headings: ${dupes.join(", ")} — two sections answering to one number means every ` + "citation to it is ambiguous and one of the two is unreachable by reference").toEqual([]);
  });
});
