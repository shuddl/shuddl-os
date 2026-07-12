// REQ-065: geofence auto-arrive/depart math, resolved to ±accuracy.
//
// The one guard this module exists for: a GPS reading that sits near a fence boundary — within its
// OWN reported accuracy of the line — is not trustworthy enough to fire an AUTOMATIC arrive/depart
// stamp. We flag it AMBIGUOUS so the caller prompts the driver instead of silently auto-firing.
// That is what stops a false auto-delivery just outside the fence (this feeds REQ-046: a delivery
// completes only with a geofence). The gate that consumes this — requiring `inside && !ambiguous`
// or a logged override — lives at the delivery gate, NOT here. This module is pure math.
//
// PURE / DETERMINISTIC: no D1, no R2, no Date, no random, no LLM (REQ-024). Given the same inputs it
// always returns the same result, so it is a safe primitive for both the server gate and the PWA.
import type { GeoStamp } from "@shuddl/contracts"; // { lat_e6: number; lon_e6: number; accuracy_m?: number }

/**
 * A geofence: a circle of radius `radius_m` metres centred on (`lat_e6`, `lon_e6`), where the
 * coordinates are integer microdegrees (degrees × 1_000_000, so 39.7392° = 39_739_200).
 */
export interface Fence {
  lat_e6: number;
  lon_e6: number;
  radius_m: number;
}

/**
 * The outcome of testing a GPS reading against a fence.
 * - `distance_m`: great-circle distance from the point to the fence CENTRE, rounded to whole metres.
 * - `inside`: `distance_m <= radius_m`.
 * - `ambiguous`: the reading sits within its own ±`accuracy_m` of the boundary, so it is too
 *   uncertain to drive an AUTOMATIC stamp (REQ-065). `inside` and `ambiguous` are independent: a
 *   reading can be inside-but-ambiguous (just within the fence) or outside-but-ambiguous (just
 *   outside). The caller decides — a clean auto-stamp needs `inside && !ambiguous`.
 */
export interface FenceResult {
  inside: boolean;
  distance_m: number;
  ambiguous: boolean;
}

// Earth radius for the great-circle (haversine) distance. A single mean radius is the standard
// spherical-earth approximation; over the metre-to-kilometre scale of a dock geofence its error is
// far below the GPS accuracy that already drives the ambiguity band, so it is not the weak link.
const EARTH_RADIUS_M = 6_371_000;
const DEG_PER_E6 = 1e-6;
const RAD_PER_DEG = Math.PI / 180;

function e6ToRad(e6: number): number {
  return e6 * DEG_PER_E6 * RAD_PER_DEG;
}

function assertIntCoord(value: number, name: string, maxAbs_e6: number): void {
  // Number.isInteger is false for NaN and ±Infinity, so this also rejects non-finite coordinates.
  if (!Number.isInteger(value)) {
    throw new Error(`insideFence: ${name} must be a finite integer microdegree value, got ${value}`);
  }
  // Range-check: a latitude past ±90° or a longitude past ±180° is not a point on Earth. Without
  // this an out-of-range coordinate (e.g. lat_e6 = 200_000_000) silently produces a meaningless
  // haversine distance instead of throwing — a malformed input must fail loudly, not compute noise.
  if (Math.abs(value) > maxAbs_e6) {
    throw new Error(`insideFence: ${name} out of range: |${value}| > ${maxAbs_e6} microdegrees`);
  }
}

const MAX_LAT_E6 = 90_000_000;
const MAX_LON_E6 = 180_000_000;

/**
 * Great-circle (haversine) distance from a GPS `point` to a `fence` centre, then the
 * inside / ambiguous decision for an AUTO geofence stamp (REQ-065).
 *
 * FLOAT NOTE — deliberate, not an oversight: money in this ledger is integer cents and never a
 * float, but a *distance* is a physical measurement, not money. The haversine needs real
 * trigonometry, so the intermediate metre distance is a float; that is correct here. What we
 * RETURN and compare against the radius is ROUNDED to a whole metre — sub-metre GPS jitter is noise,
 * and whole metres are the unit a fence radius is configured in. The rounded integer is the only
 * value that escapes this function.
 *
 * @throws if a coordinate is not a finite integer, if `radius_m` is not a finite positive number,
 *   or if `accuracy_m` is present but not a finite value ≥ 0. A fence with radius ≤ 0 is a config
 *   error, never a silent "nothing is inside".
 */
export function insideFence(point: GeoStamp, fence: Fence): FenceResult {
  assertIntCoord(point.lat_e6, "point.lat_e6", MAX_LAT_E6);
  assertIntCoord(point.lon_e6, "point.lon_e6", MAX_LON_E6);
  assertIntCoord(fence.lat_e6, "fence.lat_e6", MAX_LAT_E6);
  assertIntCoord(fence.lon_e6, "fence.lon_e6", MAX_LON_E6);
  if (!Number.isFinite(fence.radius_m) || fence.radius_m <= 0) {
    throw new Error(`insideFence: fence.radius_m must be a finite positive number, got ${fence.radius_m}`);
  }
  // Absent accuracy ⇒ band of 0: the point is treated as infinitely precise and is ambiguous ONLY
  // exactly on the boundary. A real GPS reading should always carry accuracy_m; a bare point is a
  // degenerate/test input, not the norm.
  //
  // REQ-018 (accuracy-radius half — BUILT): a GPS stamp carries its uncertainty RADIUS (GeoStamp.accuracy_m),
  // and THIS is the ± band that decides `ambiguous` — the disclosed GPS error is load-bearing here, not
  // cosmetic. The OTHER half of REQ-018 — detention/dwell math that discloses its own ± bounds — is a
  // money/dwell calc DEFERRED to a later WP (no detention engine exists yet); this module supplies the
  // accuracy radius that the future ± math will disclose.
  const accuracy = point.accuracy_m ?? 0;
  if (!Number.isFinite(accuracy) || accuracy < 0) {
    throw new Error(`insideFence: point.accuracy_m must be a finite value >= 0 when present, got ${point.accuracy_m}`);
  }

  // Haversine. lat/lon deltas use integer microdegree subtraction (exact) before converting to rad.
  const lat1 = e6ToRad(point.lat_e6);
  const lat2 = e6ToRad(fence.lat_e6);
  const dLat = e6ToRad(fence.lat_e6 - point.lat_e6);
  const dLon = e6ToRad(fence.lon_e6 - point.lon_e6);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const a = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance_m = Math.round(EARTH_RADIUS_M * c);

  const inside = distance_m <= fence.radius_m;
  // The ambiguity band: |distance − radius| ≤ accuracy. With accuracy 0 this is true only on the
  // exact boundary; with a real accuracy it widens to the reading's own uncertainty on both sides.
  //
  // DELIBERATE: both `inside` and `ambiguous` are computed from the already-ROUNDED integer
  // `distance_m`, NOT from the raw float. Do not "fix" this into a float compare. Two reasons:
  //   1. Reproducibility (ledger law): the three returned fields are mutually derivable — a consumer
  //      that keeps only `distance_m` and the `radius`/`accuracy` can recompute `inside`/`ambiguous`
  //      and get the identical answer. A hidden float compare would break that (a stored distance
  //      would disagree with a recomputed decision).
  //   2. Fail-safe at the boundary: the ≤0.5 m rounding of `distance_m` can only ever nudge a
  //      reading TOWARD the boundary line, i.e. toward `ambiguous`, never away from it. So the worst
  //      the rounding can do is prompt the driver on a reading that was a hair outside the band —
  //      never manufacture a spurious CLEAN auto-stamp. Prompting is the safe direction (REQ-065).
  const ambiguous = Math.abs(distance_m - fence.radius_m) <= accuracy;
  return { inside, distance_m, ambiguous };
}
