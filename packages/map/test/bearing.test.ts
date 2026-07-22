import { describe, it, expect } from "vitest";
import type { FleetCollection, FleetFeature } from "../src/entities.js";
import { bearingTo, animateToward } from "../src/bearing.js";

// keep-map-instrument-truthful: rendered bearing == ledger heading. Two heading bugs from the
// 2026-07-15 audit (H-2 north-snap, L-6 planar skew), reconciled at WP-16 (REQ-208). Vectors from
// .claude/skills/keep-map-instrument-truthful/reference/geodesic-bearing-vectors.md.

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

describe("animateToward — hold the ledger heading at rest, only re-derive from real movement (H-2/REQ-208)", () => {
  it("RED→GREEN: a STATIC entity (target == current) keeps its ledger bearing, never snaps to 0/north", () => {
    const f = feat("shp-1", 0, 60, 123); // ledger says it faces 123°, and it is parked
    const fleet: FleetCollection = { type: "FeatureCollection", features: [f] };
    const targets = new Map<string, [number, number]>([["shp-1", [0, 60]]]);
    animateToward(fleet, targets);
    expect(f.properties.bearing).toBe(123); // held — NOT clobbered to 0 (due-north)
  });

  it("a MOVING entity re-derives its heading from the glide delta (great-circle)", () => {
    const f = feat("shp-2", 0, 60, 0);
    const fleet: FleetCollection = { type: "FeatureCollection", features: [f] };
    const targets = new Map<string, [number, number]>([["shp-2", [0.02, 60.01]]]);
    animateToward(fleet, targets);
    expect(f.properties.bearing).toBeCloseTo(45, 0);
  });
});
