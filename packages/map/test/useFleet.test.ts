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

  it("fails CLOSED on a non-array party_refs — a bare string never substring-leaks (Zod-at-boundary)", () => {
    // Contract violation upstream: party_refs arrives as a bare string, not string[]. With a raw
    // String.includes this would substring-match — a `party-A` lens would see `party-AB`. The lens
    // must treat a non-array ref as NO match (invisible), never a substring leak.
    const leaky: FleetItem = { ...item("ab", []), party_refs: "party-AB" as unknown as string[] };
    const { result } = renderHook(() => useFleet({ scope: "party", partyId: "party-A" }, [leaky]));
    expect(result.current.collection.features).toHaveLength(0);
  });

  it("still matches a real array ref exactly (the guard doesn't over-reject)", () => {
    const src: FleetItem[] = [item("a1", ["party-A"]), item("ab1", ["party-AB"])];
    const { result } = renderHook(() => useFleet({ scope: "party", partyId: "party-A" }, src));
    const ids = result.current.collection.features.map((f) => f.properties.id);
    expect(ids).toEqual(["a1"]); // party-AB is a DIFFERENT party, not a substring of party-A's lens
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

// SERVER-SCOPED PARTY LENS (audit §451). `apps/portal/src/App.tsx:74` sets `serverScoped: true` — the
// CUSTOMER-facing surface runs this branch in production — and it had ZERO test references anywhere.
//
// The branch exists because GET /v1/board already applied the REQ-074 precise/coarse projection server-side,
// so re-coarsening here would blur an out-for-delivery shipment's exact position the server INTENTIONALLY
// sent. That is the stated purpose. The load-bearing half is the sentence after it: "The party_refs filter
// still runs (defence-in-depth against client-side data mixing)" — trusting the server for GENERALIZATION
// must not become trusting it for SCOPE. A future "the server already scoped it" simplification would leak
// another party's shipments into a customer's map with nothing failing.
describe("useFleet — serverScoped party lens (REQ-074, audit §451)", () => {
  // OFF-GRID COORDINATES ARE LOAD-BEARING. `coarsen` is Math.round(n*10)/10, and the shared `item()`
  // fixture sits at -97.7 / 30.3 — already ON that grid, so generalization is a NO-OP for it. Built that
  // way, "the precise position survives" passes even if the client coarsens everything. The first draft of
  // this describe did exactly that; the paired control below is what caught it (§442's shape, on my own test).
  const LNG = -97.74321;
  const LAT = 30.36789;
  const at = (id: string, refs: string[], extra: Partial<FleetItem> = {}): FleetItem =>
    item(id, refs, { lng: LNG, lat: LAT, ...extra });
  const ofd = (id: string, refs: string[]): FleetItem => at(id, refs, { out_for_delivery: true });

  it("serverScoped does NOT re-generalize — the server's precision survives on a PRE-OFD item", () => {
    // PRE-OFD deliberately. `generalizePosition` returns an out-for-delivery feature UNCHANGED regardless of
    // the serverScoped flag, so an OFD fixture cannot isolate this branch — the first draft used one and
    // stayed GREEN when clientGeneralize was forced true. A pre-OFD item is the only shape where
    // `serverScoped` is the SOLE reason the precise position survives.
    const source = [at("a1", ["party-A"], { out_for_delivery: false })];
    const plain = renderHook(() => useFleet({ scope: "party", partyId: "party-A", serverScoped: true }, source));
    const coords = plain.result.current.collection.features[0]!.geometry.coordinates;
    expect(coords[0]).toBeCloseTo(LNG, 5); // the OFF-GRID original, not coarsen(LNG) = -97.7
    expect(coords[1]).toBeCloseTo(LAT, 5);
  });

  it("WITHOUT serverScoped the client DOES generalize the same item — the control that gives the above meaning", () => {
    // Without this, the assertion above passes for a build that never generalizes at all, and the whole
    // REQ-074 client mirror could be dead without a single test noticing (§442's paired-control shape).
    const source = [at("a1", ["party-A"], { out_for_delivery: false })];
    const client = renderHook(() => useFleet({ scope: "party", partyId: "party-A" }, source));
    const server = renderHook(() => useFleet({ scope: "party", partyId: "party-A", serverScoped: true }, source));
    const c = client.result.current.collection.features[0]!.geometry.coordinates;
    const s = server.result.current.collection.features[0]!.geometry.coordinates;
    expect(c, "a non-serverScoped party lens must coarsen a pre-OFD position").not.toEqual(s);
  });

  it("serverScoped STILL applies the party_refs filter — trusting the server for coarsening is not trusting it for SCOPE", () => {
    const source = [ofd("a1", ["party-A"]), ofd("b1", ["party-B"]), ofd("c1", ["party-C"])];
    const { result } = renderHook(() => useFleet({ scope: "party", partyId: "party-A", serverScoped: true }, source));
    const ids = result.current.collection.features.map((f) => f.properties.id);
    expect(ids, "another party's shipment must never reach a customer's map").toEqual(["a1"]);
  });
});
