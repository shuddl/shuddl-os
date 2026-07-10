import { describe, it, expect } from "vitest";
import { generalizePosition } from "../src/generalize.js";

// REQ-074 mirrors the WP-02 redaction: a party/consignee never sees an exact position until the
// shipment is out for delivery — the server sends ~city-coarse coords (1 decimal ≈ 11km) up to OFD,
// exact after. This is the client-side generalizer used against the synthetic source.

describe("generalizePosition (REQ-074)", () => {
  it("coarsens lng/lat to ~city (1 decimal) before out-for-delivery", () => {
    const f = { geometry: { coordinates: [-97.7431, 30.2672] }, properties: {} };
    expect(generalizePosition(f, false).geometry.coordinates).toEqual([-97.7, 30.3]);
  });

  it("returns the exact position once out-for-delivery", () => {
    const f = { geometry: { coordinates: [-97.7431, 30.2672] }, properties: {} };
    expect(generalizePosition(f, true).geometry.coordinates).toEqual([-97.7431, 30.2672]);
  });

  it("never mutates the input feature (returns a fresh geometry)", () => {
    const f = { geometry: { coordinates: [-97.7431, 30.2672] }, properties: {} };
    const out = generalizePosition(f, false);
    expect(f.geometry.coordinates).toEqual([-97.7431, 30.2672]);
    expect(out).not.toBe(f);
  });
});
