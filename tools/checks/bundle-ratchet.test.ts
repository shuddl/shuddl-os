import { describe, expect, it } from "vitest";
import { BASELINE_GZIP, HEADROOM, checkBundleRatchet, readBundles } from "./bundle-ratchet.js";
import type { BundleReading } from "./bundle-ratchet.js";

// REQ-079 (audit §481/§483). The ratchet itself was shipped WITHOUT a test — the only tool in
// `tools/checks/` without one, which the §483 sweep found by listing the directory rather than by reasoning
// about it. Its behaviour was characterised once, at a terminal, by a throwaway probe. That proves the gate
// worked on 2026-08-06 and nothing about tomorrow: a ratchet whose comparison silently inverted, or whose
// non-vacuity guard stopped firing, would keep reporting `bundle-ratchet OK` forever.
//
// §482's rule was "adding a check is two edits" — one makes it correct, one makes it RUN. This file is the
// third: one makes it PINNED. All three are needed, and the first two are the ones that feel finished.

/** A full set of readings at `f(baseline)` — the shape `readBundles` returns, for every declared app. */
function readingsAt(f: (baseline: number) => number): BundleReading[] {
  return Object.entries(BASELINE_GZIP).map(([app, baseline]) => ({
    app,
    baseline,
    ceiling: Math.round(baseline * HEADROOM),
    gzip: f(baseline),
  }));
}

const ceilingOf = (baseline: number) => Math.round(baseline * HEADROOM);

describe("REQ-079: the shipped JS may not grow silently", () => {
  it("the real build is within its ceilings — or is not built, which is also a failure", () => {
    // The live assertion. In CI the build step precedes `verify:merge` (ci.yml), so readings exist; run
    // locally without `pnpm -r build` this reports the non-vacuity violations instead, by design.
    const readings = readBundles();
    if (readings.length === 0) {
      expect(checkBundleRatchet(readings), "an unbuilt tree must FAIL, never pass quietly").not.toEqual([]);
      return;
    }
    expect(checkBundleRatchet(readings)).toEqual([]);
  });

  // THE BOUNDARY, PINNED AT BOTH SIDES. A single "+20% fails" case cannot distinguish `>` from `>=` from a
  // comparison against the wrong field; landing a probe ON the boundary and one byte past it can (§-the
  // probe-on-the-boundary trap). `gzip > ceiling`, so AT the ceiling is legal and ceiling+1 is not.
  it.each([
    ["exactly the baseline", (n: number) => n, 0],
    ["AT the ceiling — legal", ceilingOf, 0],
    ["one byte OVER the ceiling — the whole point", (n: number) => ceilingOf(n) + 1, 3],
    ["a 20% regression", (n: number) => Math.round(n * 1.2), 3],
  ])("%s → %s violations", (_label, size, expected) => {
    expect(checkBundleRatchet(readingsAt(size as (n: number) => number))).toHaveLength(expected as number);
  });

  it("a SHRINKING bundle is allowed — this is a ratchet, not a band", () => {
    // The property that makes it a ratchet: the number may fall freely and may not rise. A test asserting a
    // tolerance band in both directions would fail every genuine optimisation, and the next person would
    // raise the baseline to make it pass — turning the ratchet backwards.
    expect(checkBundleRatchet(readingsAt((n) => Math.round(n * 0.7)))).toEqual([]);
  });

  it("a MISSING app is a violation, per app, and names the fix", () => {
    // NON-VACUITY (§466's error, corrected). §466 wrote its own non-vacuity guard as an AGGREGATE count,
    // which a large unrelated bucket kept above the floor — shape 4 written while closing shape-4 errors.
    // This one is per-place (shape 2): each declared app is checked by NAME, so dropping any single app
    // from the build fires exactly one violation and the count cannot be propped up by the others.
    const apps = Object.keys(BASELINE_GZIP);
    expect(apps.length, "a per-place guard over a 1-element set is indistinguishable from an existence test").toBeGreaterThan(1);

    for (const missing of apps) {
      const partial = readingsAt((n) => n).filter((r) => r.app !== missing);
      const violations = checkBundleRatchet(partial);
      expect(violations, `dropping ${missing} must fire exactly one violation`).toHaveLength(1);
      expect(violations[0]).toContain(`apps/${missing}`);
      expect(violations[0], "the message must state the COMMAND, not the criteria (§445)").toContain("pnpm -r build");
    }

    // And the total-vacuity case: nothing built at all is the loudest failure, not the quietest.
    expect(checkBundleRatchet([])).toHaveLength(apps.length);
  });

  it("readBundles over a tree with no dist returns nothing rather than throwing", () => {
    // `readBundles` is deliberately silent about absence (`continue`) and the CALLER decides whether that is
    // a failure. That split is only safe while every caller actually asks: this pins the read half so the
    // decision half above stays the single place absence is judged.
    expect(readBundles("/nonexistent-tree-for-the-ratchet-test")).toEqual([]);
  });

  it("HEADROOM absorbs patch noise without hiding a regression", () => {
    // Pinned by VALUE: widening the headroom is how a ratchet gets defeated without anyone editing a
    // baseline. 5% is ~19 kB on the two map surfaces — a minifier bump, not a new dependency.
    expect(HEADROOM).toBe(1.05);
    expect(Object.keys(BASELINE_GZIP).sort()).toEqual(["command", "driver", "portal"]);
  });
});
