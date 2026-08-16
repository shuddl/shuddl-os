import { describe, expect, it } from "vitest";
import { collectCitations, buildRepoIndex, resolveCandidates } from "./citation-links.js";
import { repoRoot } from "./repo-root.js";

// §1674 (REQ-118/119) — AN ANCHOR MUST BE ABLE TO ANCHOR.
//
// `path:line@symbol` is checked by looking for `symbol` within ±2 lines of the cited line. That makes the
// anchor's WORTH a property of how rare the symbol is in the target file. `@UNRESOLVED_VISIBILITY` (3
// occurrences) genuinely pins a location. `@b` (119 occurrences in its target) pins nothing at all: the
// citation could point at any of 119 lines and stay green, so the "content-anchored" label is decoration.
//
// FOUND BY: two citations rotted SILENTLY this session while `check:citations` stayed green, both because the
// ±2 window happened to contain the symbol in prose rather than in the code the citation meant (§1673 measured
// the population: 44 of 467 anchors rest on a comment). This gate closes the STRUCTURAL half of that class.
//
// WHAT IT DOES NOT REACH, stated so the next reader does not over-trust it: of the two real false-greens, this
// metric catches ONE. `@geo` (22 occurrences) it flags. `@UNRESOLVED_VISIBILITY` (3) it does not — that anchor
// is good, and it failed only because a comment 13 lines from the code names the symbol. Distinguishing THAT
// case needs to know whether the citation meant the prose or the code, which is English (§1673 declined a gate
// on exactly that boundary, and the decision stands).
//
// A RATCHET, not a floor: the count may FALL and never grow. Fixing one is usually a one-word edit — anchor
// the enclosing function instead of the noun (`@geo` → `@deliveryFence` was this phase's).

/** Above this many occurrences in the target file, an anchor no longer discriminates between locations. */
const WEAK_AT = 20;

/**
 * FROZEN at §1674: 17 anchors are weaker than WEAK_AT. Measured AFTER strengthening `@geo` → `@deliveryFence`
 * (22 → 3), which is why this is 17 and the §1674 measurement records 18.
 */
const FROZEN_WEAK = 17;

/** PURE: how many lines of `text` contain `symbol` — i.e. how many distinct ±2 windows the anchor admits. */
export function occurrences(lines: readonly string[], symbol: string): number {
  let n = 0;
  for (const l of lines) if (l.includes(symbol)) n += 1;
  return n;
}

interface Weak {
  readonly n: number;
  readonly where: string;
}

function weakAnchors(root: string): Weak[] {
  const index = buildRepoIndex(root);
  const out: Weak[] = [];
  for (const c of collectCitations(root)) {
    if (c.symbol === undefined) continue;
    const path = resolveCandidates(c.path, c.citingFile, index.paths).find((p) => index.lines(p) !== null);
    if (path === undefined) continue;
    const n = occurrences(index.lines(path) as readonly string[], c.symbol);
    if (n > WEAK_AT) out.push({ n, where: `${c.citingFile}:${c.citingLine} → ${path}:${c.spec}@${c.symbol} (${n}×)` });
  }
  return out.sort((a, b) => b.n - a.n);
}

describe("§1674 REQ-118: a content anchor must actually discriminate a location", () => {
  const root = repoRoot();

  it("counts occurrences, not citations (positive control)", () => {
    // A broken counter returning 0 would report every anchor strong and this gate would pass forever — the
    // §1387 failure mode where green means "found none".
    expect(occurrences(["const geo = 1;", "// geo again", "unrelated"], "geo")).toBe(2);
    expect(occurrences(["nothing here"], "geo")).toBe(0);
  });

  it("reads a real corpus (non-vacuity — zero citations means zero weak anchors)", () => {
    // LIVE at §1674: 472 anchored citations. Floored far below (§1650: a tripwire for a broken scan, not a
    // number anyone maintains).
    const anchored = collectCitations(root).filter((c) => c.symbol !== undefined).length;
    expect(anchored, "almost no anchored citations parsed — the extractor broke, not the record").toBeGreaterThan(200);
  });

  it("no NEW weak anchor is added", () => {
    const weak = weakAnchors(root);
    expect(
      weak.length,
      `${weak.length} citation anchors occur more than ${WEAK_AT}× in their target file, frozen at ` +
        `${FROZEN_WEAK} by §1674. Such an anchor admits that many distinct ±2 windows, so the citation can ` +
        "drift anywhere in the file and `check:citations` stays green — it is labelled content-anchored while " +
        "anchoring nothing. Fix: anchor the ENCLOSING FUNCTION or a distinctive identifier instead of a common " +
        "noun (this phase's was `@geo` 22× → `@deliveryFence` 3×). If you REMOVED one, lower this number — it " +
        "may fall, never grow:\n  " + weak.map((w) => w.where).join("\n  "),
    ).toBeLessThanOrEqual(FROZEN_WEAK);
  });
});
