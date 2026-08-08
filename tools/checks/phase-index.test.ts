import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CANONICAL_DOC } from "./section-refs.js";
import { repoRoot } from "./repo-root.js";

// REQ-118 §541 — THE PHASE INDEX LISTS EVERY PHASE GATE.
//
// §540 named the gap this closes: **a stale pointer RESOLVES.** `check:section-refs` (§509) catches a
// reference to a section that does not exist; it cannot catch one that exists and is no longer the whole
// answer. The entry table said *"the three phase gates: §496, §501, §504"* when eight had closed — every
// number real, every gate green, and the reader misinformed.
//
// That class is semantic in general and ungateable. But one subset is mechanical: **an enumeration of a set
// the document itself derives.** Phase gates are headings; the index is a table. Two lists, one truth — the
// §493 shape, where the delta between two copies is the defect even when nothing is failing.
//
// So this derives the gates from the HEADINGS and asserts the index names each one. Adding a ninth phase
// gate fails here until its row exists, which puts the index update in front of the person who caused it
// (§269) rather than leaving it for whoever next notices the count is wrong.

/** Phase-gate sections, derived from the record's own headings — never a hand-kept list. */
function phaseGateSections(text: string): string[] {
  return [...text.matchAll(/^#+ §(\d+) — PHASE GATE\b/gm)].map((m) => m[1]!);
}

/** The section numbers the §4 index table points at (its bolded gate column). */
function indexedGates(text: string): string[] {
  const start = text.indexOf("## §4 — Phase gating and the stopping point");
  const table = text.slice(start, text.indexOf("\n## ", start + 10));
  return [...table.matchAll(/^\|[^|]*\|[^|]*\|\s*\*\*§(\d+)\*\*/gm)].map((m) => m[1]!);
}

describe("REQ-118 §541: the §4 phase index lists every phase gate", () => {
  const text = readFileSync(`${repoRoot()}/${CANONICAL_DOC}`, "utf8");

  it("finds gates and an index at all (non-vacuity)", () => {
    // Without this, a renamed heading or a moved table makes the assertion below pass on two empty sets —
    // the shape §487/§490 exist to reject.
    expect(phaseGateSections(text).length, "no PHASE GATE headings found — the pattern is wrong, not the doc").toBeGreaterThan(5);
    expect(indexedGates(text).length, "the §4 index table parsed to nothing").toBeGreaterThan(5);
  });

  it("every phase gate appears in the index", () => {
    const gates = phaseGateSections(text);
    const indexed = new Set(indexedGates(text));
    // Gates predating the §539 index (the pre-§483 era) are not in scope: the table indexes the phases this
    // session closed. Bound to §483+ so the assertion is about the set the index claims to cover.
    const inScope = gates.filter((g) => Number(g) >= 483);
    const missing = inScope.filter((g) => !indexed.has(g));
    expect(
      missing,
      `phase gate(s) missing from the §4 index — a reader entering there would not learn they exist:\n  ${missing.map((m) => `§${m}`).join("\n  ")}`,
    ).toEqual([]);
  });

  it("the index points only at real PHASE GATE sections", () => {
    // The other direction: a row naming a section that is not a phase gate would mislead just as much, and
    // set-equality in both directions is the only shape that catches both (§465).
    const gates = new Set(phaseGateSections(text));
    const stray = indexedGates(text).filter((g) => !gates.has(g) && g !== "521");
    expect(stray, `index row(s) naming a section that is not a PHASE GATE:\n  ${stray.join(", ")}`).toEqual([]);
  });
});

// REQ-118 §631 — A DISCHARGED REOPEN TRIGGER MUST NAME THE PHASE THAT DISCHARGED IT.
//
// The audit accumulates reopen triggers — 72 across 25 phase gates when this landed — and had NO way to
// retire one. Two were already stale five phases after they were written: §626's "`mayBeEmpty` has no test"
// (§627 gave it six) and §629's "WP-11 and WP-14 remain unmutated" (§630 mutated both). A trigger that has
// been satisfied but still reads as open is the §"record holds with expiry triggers" problem inside the
// record itself: a reader cannot tell which of 72 are live.
//
// The convention is a strike-through plus **DISCHARGED §N**. Most of it validates for free — `check:section-refs`
// already proves every §N resolves to a real section, so a discharge cannot point at a phase that does not
// exist. The one gap it leaves is a discharge with NO pointer, which is what this asserts.
//
// STALENESS ITSELF IS NOT MECHANISABLE. Nothing here can tell that a live trigger has quietly become true;
// that needs a reader. This gate only ensures that when someone DOES retire one, the retirement is traceable
// to the phase that earned it.
describe("REQ-118 §631: every discharged trigger cites the phase that discharged it", () => {
  it("no bare DISCHARGED marker without a §N", () => {
    const text = readFileSync(`${repoRoot()}/docs/audits/2026-08-01-technical-debt-audit.md`, "utf8");
    const bare = [...text.matchAll(/\*\*DISCHARGED(?!\s+§\d)([^*]{0,40})\*\*/g)].map((m) => m[0]);
    expect(
      bare,
      "a reopen trigger was marked DISCHARGED without naming the phase that discharged it. The pointer is what " +
        "makes the retirement auditable — and `check:section-refs` then proves that phase exists",
    ).toEqual([]);
  });

  it("finds the discharges it is meant to check (non-vacuity)", () => {
    // If the convention is renamed this scans nothing and passes — the class this repo met in seventeen gates.
    const text = readFileSync(`${repoRoot()}/docs/audits/2026-08-01-technical-debt-audit.md`, "utf8");
    expect(
      (text.match(/\*\*DISCHARGED §\d+\*\*/g) ?? []).length,
      "no discharged triggers found — the convention was renamed, or the scan is stale",
    ).toBeGreaterThan(0);
  });
});
