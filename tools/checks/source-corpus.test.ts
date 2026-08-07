import { describe, expect, it } from "vitest";
import { EXPECTED_EMPTY_GLOBS, SOURCE_SCAN_GLOBS, isTestPath, stripComments } from "./source-corpus.js";
import { scanSourceForForbiddenReplace, scanSourceForLegsReplace } from "./invariants.js";
import { findChokepointViolations } from "./append-chokepoint.js";

// REQ-030 / I3 (audit §493). TWO gates guard the append-only law over TypeScript source and they must see
// the SAME files: `append-chokepoint` (WHO may write `events`) and `invariants`' REPLACE scanner (HOW anyone
// may write it). They had separate hand-maintained glob lists, and the delta was a hole.
//
// MEASURED, not reasoned: `INSERT OR REPLACE INTO events` planted in `tools/seed/load.ts` — an ALLOWLISTED
// events writer — passed `check:invariants` (tools/ outside its globs), `check:chokepoint` (allowlisted as a
// writer) and `lint`. Nothing in the build caught a REPLACE on the events table. The allowlist answers *who
// may write*; it was being read as an exemption from *how*, purely because the second gate never looked
// there.
//
// §120 had already caught this delta once, in the other direction (the REPLACE scanner missing `apps/`).
// Two hand-maintained copies of one corpus drift; that is what `.claude/skills/share-lint-matchers-with-
// parity-tests` exists to prevent, and these are its parity tests.

describe("REQ-030/I3 §493: one corpus, shared by both source gates", () => {
  it("covers every tree × extension cell — set equality, not a spot check", () => {
    // Set-equality in BOTH directions (§465's strongest shape). A `toContain` on `tools/**/*.ts` would pass
    // while some other cell went missing, which is exactly how the hole opened: nobody was comparing lists.
    expect(new Set(SOURCE_SCAN_GLOBS)).toEqual(
      new Set([
        "workers/*/src/**/*.ts", "workers/*/src/**/*.tsx",
        "packages/*/src/**/*.ts", "packages/*/src/**/*.tsx",
        "apps/*/src/**/*.ts", "apps/*/src/**/*.tsx",
        "tools/**/*.ts", "tools/**/*.tsx",
      ]),
    );
  });

  it("the tools/ cell is present — this is the cell whose absence was the hole", () => {
    expect(SOURCE_SCAN_GLOBS).toContain("tools/**/*.ts");
  });

  it("the deliberately-empty globs are a SUBSET of the scanned set", () => {
    // An expected-empty entry naming a glob nobody scans would silence a non-vacuity rule for a pattern that
    // is not even in the corpus — an exemption with no subject (§-attribute-the-exemption).
    for (const g of EXPECTED_EMPTY_GLOBS) expect(SOURCE_SCAN_GLOBS).toContain(g);
  });
});

describe("REQ-030/I3 §493: the shared corpus predicates behave identically for both gates", () => {
  const FORBIDDEN = `const q = "INSERT OR REPLACE INTO events (id) VALUES ('x')";`;

  it("a REPLACE in a tools/ path is caught by the REPLACE scanner", () => {
    // The regression pin for the hole. Before §493 this file would not have been READ at all.
    expect(scanSourceForForbiddenReplace([{ path: "tools/seed/load.ts", text: FORBIDDEN }])).not.toHaveLength(0);
  });

  it("the same SQL inside a COMMENT is ignored — a rule must be describable in prose", () => {
    // `stripComments` moved into this module precisely because only ONE of the two gates had it. Its own
    // header named the victim: "the check flags its own header and invariants.ts's explanation of the same
    // rule". Widening the REPLACE scanner reproduced that immediately — it flagged THIS module's docs.
    const commented = `// INSERT OR REPLACE INTO events — prose describing the banned form\nconst ok = 1;`;
    expect(scanSourceForForbiddenReplace([{ path: "tools/x.ts", text: stripComments(commented) }])).toEqual([]);
    // …and stripping must not blind the scanner to real code on OTHER lines (line numbers preserved).
    expect(
      scanSourceForForbiddenReplace([{ path: "tools/x.ts", text: stripComments(`${commented}\n${FORBIDDEN}`) }]),
    ).not.toHaveLength(0);
  });

  it("test paths are excluded, and by the SAME predicate both gates use", () => {
    // The gates' own fixture files legitimately contain the forbidden SQL. Widening the corpus without this
    // exclusion made the scanner flag `append-chokepoint.test.ts` — the sibling gate's evidence.
    expect(isTestPath("tools/checks/append-chokepoint.test.ts")).toBe(true);
    expect(isTestPath("workers/api/test/helpers.ts")).toBe(true);
    expect(isTestPath("tools/seed/load.ts")).toBe(false);
    expect(isTestPath("packages/ledger/src/chain.ts")).toBe(false);
  });

  it("the legs REPLACE rule reads the same corpus — both scanners, one probe", () => {
    // The skill's rule: feed BOTH scanners the same corpus rather than tailoring strings to each.
    const legs = `const q = "INSERT OR REPLACE INTO legs (id) VALUES ('x')";`;
    expect(scanSourceForLegsReplace([{ path: "tools/seed/load.ts", text: legs }])).not.toHaveLength(0);
  });

  it("the REAL tree is clean under both gates — the shared corpus did not import a false positive", () => {
    // Non-vacuity for the pair: after widening, `check:invariants` flagged this very module's documentation
    // and the sibling gate's fixtures. Both are real files in the real tree, so this assertion is what
    // caught them.
    expect(findChokepointViolations()).toEqual([]);
  });
});
