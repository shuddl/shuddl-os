// REQ-166 — SERVER-SIDE geo → operating-state (USPS 2-letter) derivation for the consent-before-GPS
// gate. PURE / DETERMINISTIC (no D1, no Date, no random, no LLM, no network — REQ-024), so it is
// unit-testable and reusable by both the sequencer (stop.arrived) and the positions bypass route
// (position.updated).
//
// WHAT CHANGED (V1 remediation Task 13). The coarse five-box STUB is gone. Jurisdiction is now resolved
// by exact point-in-polygon against a version/hash-pinned admin-boundary ARTIFACT (see polygon-source.ts
// for the algorithm and the fail-closed loader). The boxes were fail-OPEN on coastal/border cases — a
// Pacific-ocean point 35 km off Big Sur (36.2, -122.3) and a Reno-NV point (39.5, -119.8) both derived
// to a confident "CA", which would let a WA/NV/ocean stamp be judged against a CA consent. Point-in-
// polygon over a real coastline resolves both to "XX" (fail-closed), so the consent gate blocks.
//
// PROVENANCE, honestly stated: the device supplies RAW GPS microdegrees (a physical measurement) and the
// SERVER derives the jurisdiction from those coordinates here, so the operating state is NOT a client-
// supplied jurisdiction CLAIM (a driver cannot simply assert "I'm in CA"). Whether any acknowledgment is
// LEGALLY sufficient for a given state is [CONFIRM] (owner=counsel, doc 13 §05) — this module only
// decides which state to compare a ConsentAck against, not legality.
//
// THE ACTIVE ARTIFACT IS SYNTHETIC (and says so). The embedded {@link SYNTHETIC_US_STATES} set is a
// coarse, in-repo, 5-state stand-in — enough to run the resolver and prove the algorithm — NOT a
// licensed cartographic dataset. It is byte-bound to the hash-pinned fixture
// (fixtures/jurisdiction/us-states.synthetic.json) by jurisdiction.test.ts, and pinned in
// fixtures/jurisdiction/manifest.json. The production-grade, cartographically-accurate,
// all-states+territories LICENSED admin-boundary dataset is a BLOCKED external HOLD (approved fixture
// process + license; see docs/ops/GO-LIVE-CHECKLIST.md). Until it is vendored, any coordinate outside
// the synthetic coverage derives to "XX" (fail-closed), which correctly blocks GPS consent for
// unsupported jurisdictions — the safe direction (REQ-166).
//
// FAIL-CLOSED on everything: unloadable/malformed artifact, out-of-range coordinate, a point on a state
// line, a point outside all coverage, and a point inside more than one state all return the sentinel
// "XX" — which is not a USPS code, so no ConsentAck.operating_state can equal it and the consent gate
// blocks (the driver re-acknowledges for the correct state). The gate compares by EXACT uppercase
// equality, so every code here is the canonical 2-letter USPS form ("CA" ≠ "ca").
import type { GeoStamp } from "@shuddl/contracts";
import {
  buildFromRaw,
  resolveStateE6,
  FAIL_CLOSED_STATE,
  type JurisdictionArtifact,
  type PolygonSource,
} from "./polygon-source.js";

/** The fail-closed sentinel: not a USPS code, so no ConsentAck can match it (blocks, never passes). */
export const UNKNOWN_JURISDICTION = FAIL_CLOSED_STATE;

/**
 * The ACTIVE jurisdiction artifact. SYNTHETIC / coarse / 5-state — a test-and-dev stand-in that proves
 * the point-in-polygon resolver, NOT a licensed or survey-accurate boundary set. Coordinates are
 * GeoJSON [lon, lat] decimal degrees. This literal is byte-bound to the hash-pinned fixture
 * `fixtures/jurisdiction/us-states.synthetic.json` (jurisdiction.test.ts asserts the deep-equality AND
 * the manifest sha256), so it cannot silently drift from the pinned artifact. Swapping in the LICENSED
 * dataset (the go-live HOLD) means pointing this at the vendored, hash-verified artifact and re-running
 * the jurisdiction/consent/position suites.
 */
export const SYNTHETIC_US_STATES: JurisdictionArtifact = {
  schema: "shuddl.jurisdiction.v1",
  version: "synthetic-2026-07-24",
  provenance:
    "SYNTHETIC — hand-authored COARSE state outlines generated in-repo for the SHUDDL point-in-polygon jurisdiction resolver and its hash-mismatch fail-closed proof. NOT survey-accurate; NOT a licensed cartographic product; covers 5 states only. The production licensed US admin-boundary dataset is a BLOCKED external HOLD (fixtures/jurisdiction/manifest.json, us-admin-boundaries-licensed). Any coordinate outside this coverage derives to XX (fail-closed).",
  coverage: ["CA", "OR", "WA", "TX", "NY"],
  border_policy:
    "A point strictly interior to exactly one state resolves to that USPS code; a point exterior to all, on any boundary edge, or interior to more than one state resolves to XX (fail-closed). Boundary precedes interior.",
  states: [
    {
      code: "CA",
      polygons: [
        [
          [-124.3, 42.0],
          [-122.5, 37.8],
          [-121.8, 36.0],
          [-117.1, 32.5],
          [-114.6, 32.7],
          [-114.1, 35.0],
          [-120.0, 39.0],
          [-120.0, 42.0],
          [-124.3, 42.0],
        ],
      ],
    },
    {
      code: "OR",
      polygons: [
        [
          [-124.0, 45.6],
          [-116.5, 45.6],
          [-116.5, 42.0],
          [-124.4, 42.0],
          [-124.0, 45.6],
        ],
      ],
    },
    {
      code: "WA",
      polygons: [
        [
          [-124.8, 49.0],
          [-116.9, 49.0],
          [-116.9, 45.6],
          [-124.0, 45.6],
          [-124.8, 49.0],
        ],
      ],
    },
    {
      code: "TX",
      polygons: [
        [
          [-106.5, 31.8],
          [-103.0, 36.5],
          [-94.5, 33.6],
          [-93.5, 29.8],
          [-97.5, 25.9],
          [-104.9, 29.3],
          [-106.5, 31.8],
        ],
      ],
    },
    {
      code: "NY",
      polygons: [
        [
          [-74.3, 40.48],
          [-74.7, 41.4],
          [-79.76, 42.1],
          [-79.2, 43.3],
          [-76.1, 43.6],
          [-73.3, 45.0],
          [-73.3, 40.9],
          [-73.4, 40.5],
          [-74.3, 40.48],
        ],
      ],
    },
  ],
};

// Build the active polygon source ONCE (memoized). buildFromRaw is FAIL-CLOSED: any parse/coverage
// failure yields null, and deriveOperatingState then returns "XX" for every point — an unloadable
// jurisdiction artifact blocks all GPS consent rather than guessing.
let activeSource: PolygonSource | null | undefined;
function getActiveSource(): PolygonSource | null {
  if (activeSource === undefined) activeSource = buildFromRaw(SYNTHETIC_US_STATES);
  return activeSource;
}

/**
 * Server-side jurisdiction of a GPS stamp, as a canonical uppercase 2-letter USPS code, or "XX" when the
 * coordinate is malformed, outside all coverage, on a state line, or inside more than one state. Every
 * one of those fails closed — the consent gate then blocks rather than comparing against a possibly-
 * wrong neighbour state.
 */
export function deriveOperatingState(geo: GeoStamp): string {
  const source = getActiveSource();
  if (!source) return UNKNOWN_JURISDICTION;
  return resolveStateE6(source, geo.lat_e6, geo.lon_e6);
}
