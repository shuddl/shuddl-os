// REQ-166 — COARSE, SERVER-SIDE geo → operating-state (USPS 2-letter) derivation for the
// consent-before-GPS gate. PURE / DETERMINISTIC (no D1, no Date, no random, no LLM — REQ-024), so it
// is unit-testable and reusable by both the sequencer (stop.arrived) and Task 14's positions bypass
// route (position.updated).
//
// PROVENANCE, honestly stated: the device supplies RAW GPS microdegrees (a physical measurement) and
// the SERVER derives the jurisdiction from those coordinates here, so the operating state is NOT a
// client-supplied jurisdiction CLAIM. That is a meaningful property (a driver cannot simply assert "I'm
// in CA"), but it is NOT a correctness guarantee: this is a COARSE bounding-box STUB, not a boundary.
// A precise point-in-polygon reverse-geocode against admin boundaries (self-hosted Protomaps admin
// polygons, doc 14) is the WP-08 refinement; booking provisions the real per-stop jurisdiction then.
// And whether any acknowledgment is LEGALLY sufficient for a given state is [CONFIRM] (owner=counsel,
// doc 13 §05) — this module only decides which state to compare a ConsentAck against, not legality.
//
// FAIL-CLOSED on both no-match AND ambiguity: state boxes are loose and can overlap (e.g. the OR/WA
// border straddling the Columbia). A coordinate inside NO box, OR inside MORE THAN ONE, returns the
// sentinel "XX" — which is not a USPS code, so no ConsentAck.operating_state can equal it and the
// consent gate blocks (the driver re-acknowledges for the correct state). Returning a confident
// first-match on an overlap would be a fail-OPEN on the legal gate (a WA stamp judged against OR
// consent), so ambiguity MUST resolve to "XX", never to a neighbor. The gate compares by EXACT
// uppercase equality, so every code here is the canonical 2-letter USPS form ("CA" ≠ "ca").
import type { GeoStamp } from "@shuddl/contracts";

const DEG_PER_E6 = 1e-6;

// A coarse lat/lon bounding box → USPS code. Boxes are intentionally loose (this is a stub, not a
// cartographic boundary); where two boxes overlap, a point inside both derives to "XX" (fail-closed).
interface StateBox {
  code: string;
  lat: [number, number]; // [min, max] degrees
  lon: [number, number]; // [min, max] degrees
}
// OR/WA deliberately overlap in lat [45.6, 46.0] around the Columbia: Portland (45.52) is OR-only,
// Seattle (47.6) is WA-only, and a Vancouver-WA point (~45.64) lands in BOTH → "XX" (fail-closed),
// rather than being confidently mis-derived to a single neighbor.
const STATE_BOXES: readonly StateBox[] = [
  { code: "CA", lat: [32.5, 41.99], lon: [-124.5, -114.1] },
  { code: "OR", lat: [42.0, 46.0], lon: [-124.6, -116.4] },
  { code: "WA", lat: [45.6, 49.0], lon: [-124.8, -116.9] },
  { code: "TX", lat: [25.8, 36.5], lon: [-106.7, -93.5] },
  { code: "NY", lat: [40.4, 45.1], lon: [-79.8, -71.8] },
];

/** The fail-closed sentinel: not a USPS code, so no ConsentAck can match it (blocks, never passes). */
export const UNKNOWN_JURISDICTION = "XX";

/**
 * Coarse server-side jurisdiction of a GPS stamp, as a canonical uppercase 2-letter USPS code, or
 * "XX" when the coordinate falls outside every known box OR inside more than one (ambiguous). Both the
 * no-match and the ambiguous case fail closed — the consent gate then blocks rather than comparing
 * against a possibly-wrong neighbor state.
 */
export function deriveOperatingState(geo: GeoStamp): string {
  const lat = geo.lat_e6 * DEG_PER_E6;
  const lon = geo.lon_e6 * DEG_PER_E6;
  let match: string | null = null;
  for (const b of STATE_BOXES) {
    if (lat >= b.lat[0] && lat <= b.lat[1] && lon >= b.lon[0] && lon <= b.lon[1]) {
      if (match !== null && match !== b.code) return UNKNOWN_JURISDICTION; // inside >1 box → ambiguous → fail-closed
      match = b.code;
    }
  }
  return match ?? UNKNOWN_JURISDICTION;
}
