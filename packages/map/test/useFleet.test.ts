import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useFleet, type FleetItem, type Lens } from "../src/useFleet.js";

// useFleet is the scoped-subscription seam. Party scoping (REQ-074) is the load-bearing invariant:
// a party/consignee lens must only ever receive its own shipments — never the whole fleet filtered
// client-side. setState mirrors status into the properties (statusStr/chip) the chip layer reads.

function item(id: string, partyRefs: string[], extra: Partial<FleetItem> = {}): FleetItem {
  return {
    id,
    lng: -97.7,
    lat: 30.3,
    bearing: 0,
    kind: "truck",
    status: "healthy",
    label: `SHIPMENT ${id}`,
    shipment_id: id,
    party_refs: partyRefs,
    ...extra,
  };
}

describe("useFleet — party scoping (REQ-074)", () => {
  const source: FleetItem[] = [
    item("a1", ["party-A"]),
    item("a2", ["party-A", "party-B"]),
    item("b1", ["party-B"]),
    item("c1", ["party-C"]),
  ];

  it("a party lens receives ONLY shipments referencing that party — never the others", () => {
    const lens: Lens = { scope: "party", partyId: "party-A" };
    const { result } = renderHook(() => useFleet(lens, source));
    const ids = result.current.collection.features.map((f) => f.properties.id).sort();
    expect(ids).toEqual(["a1", "a2"]); // a2 co-references party-A; b1 + c1 excluded
  });

  it("a command lens receives the whole fleet", () => {
    const { result } = renderHook(() => useFleet({ scope: "command" }, source));
    expect(result.current.collection.features).toHaveLength(4);
  });

  it("a driver lens receives only that driver's assigned shipments", () => {
    const withDrivers: FleetItem[] = [
      item("d1", ["party-A"], { driver_id: "drv-1" }),
      item("d2", ["party-A"], { driver_id: "drv-2" }),
    ];
    const { result } = renderHook(() => useFleet({ scope: "driver", driverId: "drv-1" }, withDrivers));
    const ids = result.current.collection.features.map((f) => f.properties.id);
    expect(ids).toEqual(["d1"]);
  });

  it("a party lens coarsens positions to ~city until out-for-delivery (REQ-074)", () => {
    const src: FleetItem[] = [
      item("pre", ["party-A"], { lng: -97.7431, lat: 30.2672, out_for_delivery: false }),
      item("ofd", ["party-A"], { lng: -97.7431, lat: 30.2672, out_for_delivery: true }),
    ];
    const { result } = renderHook(() => useFleet({ scope: "party", partyId: "party-A" }, src));
    const byId = (id: string) => result.current.collection.features.find((f) => f.properties.id === id);
    expect(byId("pre")?.geometry.coordinates).toEqual([-97.7, 30.3]);
    expect(byId("ofd")?.geometry.coordinates).toEqual([-97.7431, 30.2672]);
  });
});

describe("useFleet — setState mirrors status for the chip (REQ-076)", () => {
  it("records the feature-state AND mirrors statusStr/statusNum/chip on the feature", () => {
    const source: FleetItem[] = [item("shp-1", ["party-A"])];
    const { result } = renderHook(() => useFleet({ scope: "command" }, source));

    act(() => {
      result.current.setState("shp-1", "at-risk", "DWELL");
    });

    const f = result.current.collection.features.find((x) => x.properties.id === "shp-1");
    expect(f?.properties.statusStr).toBe("at-risk");
    expect(f?.properties.statusNum).toBe(1);
    expect(f?.properties.chip).toContain("DWELL");
    expect(result.current.states.get("shp-1")?.status).toBe("at-risk");
  });

  it("mirrors an exception into a labelled chip even without a named risk", () => {
    const source: FleetItem[] = [item("shp-9", ["party-A"], { label: "OS&D LANE 4" })];
    const { result } = renderHook(() => useFleet({ scope: "command" }, source));
    act(() => {
      result.current.setState("shp-9", "exception");
    });
    const f = result.current.collection.features.find((x) => x.properties.id === "shp-9");
    expect(f?.properties.statusStr).toBe("exception");
    expect(f?.properties.chip).toContain("EXCEPTION");
  });
});
