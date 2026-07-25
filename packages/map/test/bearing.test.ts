import { describe, it, expect } from "vitest";
import { bearingTo } from "../src/bearing.js";

// keep-map-instrument-truthful: rendered bearing == ledger heading. Two heading bugs from the
// 2026-07-15 audit (H-2 north-snap, L-6 planar skew), reconciled at WP-16 (REQ-208). Vectors from
// .claude/skills/keep-map-instrument-truthful/reference/geodesic-bearing-vectors.md. The H-2
// north-snap lock moved to glide.test.ts with the glide loop that owns it.

describe("bearingTo — great-circle initial bearing (0=N clockwise), cos(lat)-correct (L-6/REQ-208)", () => {
  it("equatorial cardinals are exact (both formulas agree)", () => {
    expect(bearingTo(-98, 0, -98, 1)).toBeCloseTo(0, 1); // due N
    expect(bearingTo(-98, 0, -97, 0)).toBeCloseTo(90, 1); // due E
    expect(bearingTo(-98, 0, -99, 0)).toBeCloseTo(270, 1); // due W
  });

  it("RED→GREEN (vector 4): a true 45° NE course at 60°N is ~45°, NOT the planar 63.43° skew", () => {
    const b = bearingTo(0, 60, 0.02, 60.01);
    expect(b).toBeCloseTo(45, 0); // within 0.5°
    expect(Math.abs(b - 63.43)).toBeGreaterThan(1); // the buggy planar value is rejected
  });
});
