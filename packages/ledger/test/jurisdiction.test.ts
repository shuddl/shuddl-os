import { describe, expect, it } from "vitest";
import { deriveOperatingState, UNKNOWN_JURISDICTION } from "../src/geo/jurisdiction.js";

// REQ-166 — the COARSE server-side geo→operating-state stub. The load-bearing property is FAIL-CLOSED:
// a coordinate outside every box OR inside more than one (an overlap, e.g. the OR/WA Columbia border)
// derives to "XX", so the consent gate blocks rather than judging a stamp against the WRONG state.
// A precise point-in-polygon reverse-geocode is the WP-08 refinement — these boxes are a stub.
const geo = (lat: number, lon: number): { lat_e6: number; lon_e6: number } => ({
  lat_e6: Math.round(lat * 1e6),
  lon_e6: Math.round(lon * 1e6),
});

describe("deriveOperatingState: unambiguous points resolve to their USPS code", () => {
  it.each([
    ["Bay Area CA", 37.421, -122.084, "CA"],
    ["Seattle WA", 47.6062, -122.3321, "WA"],
    ["Portland OR", 45.5152, -122.6789, "OR"],
    ["Dallas TX", 32.7767, -96.797, "TX"],
    ["NYC NY", 40.7128, -74.006, "NY"],
  ])("%s → %s", (_label, lat, lon, code) => {
    expect(deriveOperatingState(geo(lat, lon))).toBe(code);
  });
});

describe("deriveOperatingState: FAIL-CLOSED on ambiguity and no-match (REQ-166)", () => {
  it("a Vancouver-WA point on the OR/WA border is inside BOTH boxes → 'XX' (never a confident 'OR')", () => {
    // ~45.6387,-122.6615: OR (lat ≤ 46.0) AND WA (lat ≥ 45.6) both contain it → ambiguous → fail-closed.
    expect(deriveOperatingState(geo(45.6387, -122.6615))).toBe(UNKNOWN_JURISDICTION);
    expect(deriveOperatingState(geo(45.6387, -122.6615))).not.toBe("OR");
  });
  it("Boise ID is inside NO box → 'XX'", () => {
    expect(deriveOperatingState(geo(43.615, -116.2023))).toBe(UNKNOWN_JURISDICTION);
  });
  it("mid-Pacific is inside NO box → 'XX'", () => {
    expect(deriveOperatingState(geo(30.0, -150.0))).toBe(UNKNOWN_JURISDICTION);
  });
  it("Portland stays OR and Seattle stays WA — the overlap does not swallow the interiors", () => {
    expect(deriveOperatingState(geo(45.5152, -122.6789))).toBe("OR"); // south of the WA box (lat < 45.6)
    expect(deriveOperatingState(geo(47.6062, -122.3321))).toBe("WA"); // north of the OR box (lat > 46.0)
  });
});
