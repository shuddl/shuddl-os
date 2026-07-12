import { describe, expect, it } from "vitest";
import type { GeoStamp } from "@shuddl/contracts";
import { insideFence, type Fence } from "../src/geo/fence.js";

// REQ-065: geofence auto-arrive/depart math to ±accuracy. A reading whose own accuracy overlaps
// the fence boundary is AMBIGUOUS — the auto-stamp must NOT fire, the driver is prompted instead.
// (Feeds REQ-046: delivery completes only with a geofence.)
//
// KNOWN-ANSWER distances are hand-computed. Two facts make them exact enough to assert to ±1 m:
//   1. A PURE-LATITUDE offset is exact: d = R·Δφ (the haversine's a = sin²(Δφ/2), c = Δφ).
//      1° of latitude = R·(π/180) = 6_371_000 × 0.0174532925 = 111_194.93 m.
//   2. A PURE-LONGITUDE offset AT THE EQUATOR is likewise exact: d = R·Δλ. Off the equator it
//      scales by cos(lat), so the same Δλ at 60° (cos = 0.5) is HALF the equator distance.
// R = 6_371_000 m throughout.
const R = 6_371_000;
const RAD_PER_DEG = Math.PI / 180;

/** Pure-latitude / equatorial-longitude great-circle metres for a microdegree delta (exact). */
function arcMetres(delta_e6: number): number {
  return R * (delta_e6 * 1e-6) * RAD_PER_DEG;
}

function pt(lat_e6: number, lon_e6: number, accuracy_m?: number): GeoStamp {
  return accuracy_m === undefined ? { lat_e6, lon_e6 } : { lat_e6, lon_e6, accuracy_m };
}

describe("REQ-065 geofence: haversine distance + ±accuracy ambiguity band", () => {
  it("point AT the centre → distance 0, inside; ambiguous only when radius ≤ accuracy", () => {
    const centre = { lat_e6: 40_000_000, lon_e6: 0, radius_m: 200 };
    const here = pt(40_000_000, 0, 10);
    expect(insideFence(here, centre)).toEqual({ inside: true, distance_m: 0, ambiguous: false });

    // radius 5 m, accuracy 10 m: |0 − 5| = 5 ≤ 10 → the whole fence sits inside the error disk.
    const tiny: Fence = { lat_e6: 40_000_000, lon_e6: 0, radius_m: 5 };
    expect(insideFence(pt(40_000_000, 0, 10), tiny)).toEqual({ inside: true, distance_m: 0, ambiguous: true });
  });

  it("clearly inside (≈50 m, radius 200, accuracy 10) → inside, not ambiguous", () => {
    // +450 µ° of latitude = 6_371_000 × 0.000450 × π/180 = 50.04 m → 50.
    expect(arcMetres(450)).toBeCloseTo(50.04, 1);
    const r = insideFence(pt(40_000_450, 0, 10), { lat_e6: 40_000_000, lon_e6: 0, radius_m: 200 });
    expect(r.distance_m).toBe(50);
    expect(r).toEqual({ inside: true, distance_m: 50, ambiguous: false });
  });

  it("clearly outside (≈500 m, radius 200, accuracy 10) → not inside, not ambiguous", () => {
    // +4500 µ° of latitude = 500.37 m → 500. |500 − 200| = 300 > 10.
    expect(arcMetres(4500)).toBeCloseTo(500.37, 1);
    const r = insideFence(pt(40_004_500, 0, 10), { lat_e6: 40_000_000, lon_e6: 0, radius_m: 200 });
    expect(r).toEqual({ inside: false, distance_m: 500, ambiguous: false });
  });

  it("INSIDE but within the boundary band (≈197 m, radius 200, accuracy 10) → inside AND ambiguous", () => {
    // +1770 µ° of latitude = 196.82 m → 197. The reading is inside the fence (197 ≤ 200) but its
    // own 10 m accuracy still overlaps the boundary: |197 − 200| = 3 ≤ 10. This is exactly the case
    // the delivery gate's `inside && !ambiguous` must reject — inside is NOT enough for a clean auto.
    expect(arcMetres(1770)).toBeCloseTo(196.82, 1);
    const r = insideFence(pt(40_001_770, 0, 10), { lat_e6: 40_000_000, lon_e6: 0, radius_m: 200 });
    expect(r.distance_m).toBe(197);
    expect(r.inside).toBe(true);
    expect(r.ambiguous).toBe(true);
  });

  it("near the boundary within accuracy (≈205 m, radius 200, accuracy 10) → AMBIGUOUS, no auto-stamp", () => {
    // +1844 µ° of latitude = 205.04 m → 205. Reading is JUST outside (205 > 200) but its own 10 m
    // accuracy reaches back across the fence: |205 − 200| = 5 ≤ 10. Auto-arrive must NOT fire.
    expect(arcMetres(1844)).toBeCloseTo(205.04, 1);
    const r = insideFence(pt(40_001_844, 0, 10), { lat_e6: 40_000_000, lon_e6: 0, radius_m: 200 });
    expect(r.distance_m).toBe(205);
    expect(r.inside).toBe(false);
    expect(r.ambiguous).toBe(true);
  });

  it("exactly on the boundary with NO accuracy → band is 0, ambiguous only on the line", () => {
    // +1799 µ° = 200.04 m → 200. accuracy absent ⇒ band 0 ⇒ |200 − 200| = 0 ≤ 0 → ambiguous.
    // (A real GPS reading always carries accuracy_m; a bare point is treated as infinitely precise.)
    const r = insideFence(pt(40_001_799, 0), { lat_e6: 40_000_000, lon_e6: 0, radius_m: 200 });
    expect(r).toEqual({ inside: true, distance_m: 200, ambiguous: true });
  });

  describe("known-answer great-circle distances (±1 m)", () => {
    it("1° of latitude = 111_195 m (pure latitude is exact: d = R·Δφ)", () => {
      const r = insideFence(pt(41_000_000, 0), { lat_e6: 40_000_000, lon_e6: 0, radius_m: 50 });
      expect(Math.abs(r.distance_m - 111_195)).toBeLessThanOrEqual(1);
      expect(r.distance_m).toBe(111_195);
      expect(r.inside).toBe(false);
    });

    it("longitude scales by cos(lat): 0.01° lon at 60° is half of 0.01° lon at the equator", () => {
      // Equator: pure-longitude is exact, d = R·Δλ = 6_371_000 × 0.01 × π/180 = 1111.95 m → 1112.
      const equator = insideFence(pt(0, 10_000), { lat_e6: 0, lon_e6: 0, radius_m: 50 });
      expect(Math.abs(equator.distance_m - 1112)).toBeLessThanOrEqual(1);
      expect(equator.distance_m).toBe(1112);

      // At 60° latitude cos = 0.5, so the same 0.01° of longitude covers half the ground: ≈556 m.
      const lat60 = insideFence(pt(60_000_000, 10_000), { lat_e6: 60_000_000, lon_e6: 0, radius_m: 50 });
      expect(Math.abs(lat60.distance_m - 556)).toBeLessThanOrEqual(1);
      expect(lat60.distance_m).toBe(556);
      // Cross-check the cos(lat) halving explicitly.
      expect(lat60.distance_m * 2).toBe(equator.distance_m);
    });
  });

  describe("malformed input throws (a bad fence/accuracy is a config error, not a silent pass)", () => {
    const centre = { lat_e6: 40_000_000, lon_e6: 0 };
    it("radius_m = 0 throws", () => {
      expect(() => insideFence(pt(40_000_000, 0, 10), { ...centre, radius_m: 0 })).toThrow(/radius_m/);
    });
    it("radius_m < 0 throws", () => {
      expect(() => insideFence(pt(40_000_000, 0, 10), { ...centre, radius_m: -1 })).toThrow(/radius_m/);
    });
    it("non-finite radius_m throws", () => {
      expect(() => insideFence(pt(40_000_000, 0, 10), { ...centre, radius_m: Infinity })).toThrow(/radius_m/);
    });
    it("negative accuracy_m throws", () => {
      expect(() => insideFence(pt(40_000_000, 0, -1), { ...centre, radius_m: 200 })).toThrow(/accuracy_m/);
    });
    it("non-finite accuracy_m throws", () => {
      expect(() => insideFence(pt(40_000_000, 0, Infinity), { ...centre, radius_m: 200 })).toThrow(/accuracy_m/);
      expect(() => insideFence(pt(40_000_000, 0, Number.NaN), { ...centre, radius_m: 200 })).toThrow(/accuracy_m/);
    });
    it("non-integer coordinate throws", () => {
      expect(() => insideFence(pt(40_000_000.5, 0, 10), { ...centre, radius_m: 200 })).toThrow(/lat_e6/);
      expect(() => insideFence(pt(40_000_000, Number.NaN, 10), { ...centre, radius_m: 200 })).toThrow(/lon_e6/);
    });
    it("out-of-range coordinate throws (latitude past ±90°, longitude past ±180°)", () => {
      // 91° latitude and 181° longitude are not points on Earth — must fail loudly, not compute noise.
      expect(() => insideFence(pt(91_000_000, 0, 10), { ...centre, radius_m: 200 })).toThrow(/lat_e6/);
      expect(() => insideFence(pt(40_000_000, 181_000_000, 10), { ...centre, radius_m: 200 })).toThrow(/lon_e6/);
    });
  });
});
