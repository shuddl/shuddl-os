import { describe, expect, it } from "vitest";
import { pulseWidths } from "../src/pulse.js";

// Why this file insists on plain numbers: MapLibre's ProgramConfiguration decides how to bind a paint
// value by the KIND of the expression. A `source`-kind expression (anything reading ["get", …] or
// ["feature-state", …]) binds through a SourceExpressionBinder — a per-feature vertex attribute array
// that is repopulated and re-uploaded for EVERY feature each time the value changes. At 1,000 entities
// and ~100 changes/second that is two 1,000-element buffer uploads per frame to draw a picture whose
// only difference is a stroke width. A CONSTANT binds to a GL uniform and costs nothing per feature.
//
// So the pulse must be scalar, and the STATE distinction must live in the layer split (filters on the
// static `statusStr` property) rather than inside the animated paint value.

describe("pulse widths are constants, never per-feature expressions", () => {
  it("returns plain numbers so MapLibre binds a uniform, not a vertex attribute", () => {
    const w = pulseWidths(0);
    expect(typeof w.exception).toBe("number");
    expect(typeof w.atRisk).toBe("number");
    expect(Number.isFinite(w.exception)).toBe(true);
    expect(Number.isFinite(w.atRisk)).toBe(true);
  });

  it("throbs the exception on a 1.6s period and breathes at-risk on 3s", () => {
    // Both ride `0.5 + 0.5*sin`, so each starts mid-swing and PEAKS a quarter-period in. (The widths
    // are the shipped ones; this test describes the animation that exists rather than re-timing it.)
    expect(pulseWidths(400).exception).toBeCloseTo(6, 5); // peak, quarter of 1.6s
    expect(pulseWidths(1200).exception).toBeCloseTo(2, 5); // trough, three quarters
    expect(pulseWidths(750).atRisk).toBeCloseTo(2.5, 5); // peak, quarter of 3s
    expect(pulseWidths(2250).atRisk).toBeCloseTo(1, 5); // trough, three quarters
  });

  it("is periodic — 1.6s for the throb, 3s for the breath", () => {
    for (const ts of [0, 137, 400, 900]) {
      expect(pulseWidths(ts + 1600).exception).toBeCloseTo(pulseWidths(ts).exception, 9);
      expect(pulseWidths(ts + 3000).atRisk).toBeCloseTo(pulseWidths(ts).atRisk, 9);
    }
  });

  it("throbs the exception harder and faster than at-risk breathes", () => {
    const swing = (of: "exception" | "atRisk", period: number): number => {
      const vs = Array.from({ length: 200 }, (_, i) => pulseWidths((i * period) / 200)[of]);
      return Math.max(...vs) - Math.min(...vs);
    };
    expect(swing("exception", 1600)).toBeGreaterThan(swing("atRisk", 3000));
    expect(pulseWidths(400).exception).toBeGreaterThan(pulseWidths(750).atRisk);
  });

  it("keeps the exact widths the data-driven pulse used to paint (no visual re-baselining)", () => {
    // The old expression painted `2 + 4*urgent` for exception and `1 + 1.5*calm` for at-risk off the
    // same two sines. Same inputs must still give the same widths, or this is a design change wearing
    // a performance change's clothes.
    for (const ts of [0, 137, 400, 800, 1600, 2500, 3000, 5000]) {
      const urgent = 0.5 + 0.5 * Math.sin((ts / 1600) * 2 * Math.PI);
      const calm = 0.5 + 0.5 * Math.sin((ts / 3000) * 2 * Math.PI);
      expect(pulseWidths(ts).exception).toBeCloseTo(2 + 4 * urgent, 12);
      expect(pulseWidths(ts).atRisk).toBeCloseTo(1 + 1.5 * calm, 12);
    }
  });

  it("never drops below the static 1px stroke the calm marks keep", () => {
    for (let ts = 0; ts <= 6000; ts += 17) {
      expect(pulseWidths(ts).exception).toBeGreaterThanOrEqual(2);
      expect(pulseWidths(ts).atRisk).toBeGreaterThanOrEqual(1);
    }
  });
});
