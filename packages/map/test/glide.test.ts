import { describe, expect, it } from "vitest";
import type { FleetCollection, FleetFeature } from "../src/entities.js";
import { animateToward } from "../src/glide.js";

// The glide loop's ONLY job on a clustered source is to decide whether a setData is warranted.
// MapLibre's `_applyDiffToSource` short-circuits for `cluster: true`, so every setData reloads and
// re-parses EVERY tile of the source. Measured in ?perf mode: 177 pushes over 8s with a max
// |Δcoordinate| across all 1,000 features of exactly 0, and byte-identical frames. So the contract
// under test is: report movement honestly, and converge (snap) instead of easing forever.

const fc = (coords: [number, number][]) => ({
  type: "FeatureCollection" as const,
  features: coords.map((c, i) => ({
    type: "Feature" as const,
    id: `s${i}`,
    geometry: { type: "Point" as const, coordinates: [...c] as [number, number] },
    properties: { id: `s${i}`, statusStr: "healthy" },
  })),
});

describe("animateToward reports whether it moved anything", () => {
  it("returns false when every feature is already at its target", () => {
    const f = fc([[-98, 39]]);
    const targets = new Map([["s0", [-98, 39] as [number, number]]]);
    expect(animateToward(f as never, targets)).toBe(false);
  });

  it("returns true while a feature is still converging, and false once it arrives", () => {
    const f = fc([[-98, 39]]);
    const targets = new Map([["s0", [-90, 39] as [number, number]]]);
    expect(animateToward(f as never, targets)).toBe(true);
    for (let i = 0; i < 500; i += 1) animateToward(f as never, targets);
    expect(animateToward(f as never, targets)).toBe(false);
  });

  it("snaps to the target rather than approaching it forever", () => {
    const f = fc([[-98, 39]]);
    const targets = new Map([["s0", [-90, 39] as [number, number]]]);
    for (let i = 0; i < 500; i += 1) animateToward(f as never, targets);
    expect(f.features[0]!.geometry.coordinates[0]).toBeCloseTo(-90, 6);
  });

  it("reports movement for ANY feature, not just the first", () => {
    const f = fc([
      [-98, 39],
      [-97, 38],
    ]);
    const targets = new Map<string, [number, number]>([
      ["s0", [-98, 39]], // already home
      ["s1", [-90, 38]], // still travelling
    ]);
    expect(animateToward(f as never, targets)).toBe(true);
  });

  it("a feature with no target is left alone and does not claim movement", () => {
    const f = fc([[-98, 39]]);
    expect(animateToward(f as never, new Map())).toBe(false);
    expect(f.features[0]!.geometry.coordinates).toEqual([-98, 39]);
  });
});

// keep-map-instrument-truthful: rendered bearing == ledger heading. These two are the H-2 north-snap
// locks from the 2026-07-15 audit, reconciled at WP-16 (REQ-208). They moved here with the glide loop
// that owns the derivation; the great-circle trig itself stays proven in bearing.test.ts. Reporting
// movement (above) must never cost the heading law (here).

function feat(id: string, lng: number, lat: number, bearing: number): FleetFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "Point", coordinates: [lng, lat] },
    properties: {
      id,
      kind: "truck",
      bearing,
      label: "L",
      shipment_id: id,
      statusStr: "healthy",
      statusNum: 0,
      chip: "",
    },
  };
}

describe("animateToward — hold the ledger heading at rest, only re-derive from real movement (H-2/REQ-208)", () => {
  it("RED→GREEN: a STATIC entity (target == current) keeps its ledger bearing, never snaps to 0/north", () => {
    const f = feat("shp-1", 0, 60, 123); // ledger says it faces 123°, and it is parked
    const fleet: FleetCollection = { type: "FeatureCollection", features: [f] };
    const targets = new Map<string, [number, number]>([["shp-1", [0, 60]]]);
    expect(animateToward(fleet, targets)).toBe(false); // and it reports no movement
    expect(f.properties.bearing).toBe(123); // held — NOT clobbered to 0 (due-north)
  });

  it("a MOVING entity re-derives its heading from the glide delta (great-circle)", () => {
    const f = feat("shp-2", 0, 60, 0);
    const fleet: FleetCollection = { type: "FeatureCollection", features: [f] };
    const targets = new Map<string, [number, number]>([["shp-2", [0.02, 60.01]]]);
    expect(animateToward(fleet, targets)).toBe(true);
    expect(f.properties.bearing).toBeCloseTo(45, 0);
  });

  it("a mark that SNAPS home on the final frame does not re-derive a heading from the crumb", () => {
    // The snap lands exactly on the target from a sub-BEARING_EPS residual. Deriving a heading from
    // that crumb is the same north-snap H-2 closed, just one frame later.
    const f = feat("shp-3", 0, 60, 123);
    const fleet: FleetCollection = { type: "FeatureCollection", features: [f] };
    const targets = new Map<string, [number, number]>([["shp-3", [1e-9, 60]]]);
    expect(animateToward(fleet, targets)).toBe(true); // it did move (it landed)
    expect(f.geometry.coordinates).toEqual([1e-9, 60]); // exactly home
    expect(f.properties.bearing).toBe(123); // ledger heading intact
  });
});
