import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type { FleetCollection, FleetFeature, Status } from "../src/entities.js";

// The real WebGL render is Task 6's Playwright job. Here we mock MapLibre and assert the things that
// make MapCanvas correct at construction: it hands MapLibre the GREIGE style (not a default street
// style); it registers a click handler so a mark opens the lens — the map itself never navigates away
// (REQ-080); it AUTO-DIMS the world when a visible exception exists (REQ-077, acceptance demo #5); and
// its pulse throbs a cluster that CONTAINS an exception.

const { ctorSpy, onSpy, paintSpy, worldDimSpy, setDataSpy } = vi.hoisted(() => ({
  ctorSpy: vi.fn(),
  onSpy: vi.fn(),
  paintSpy: vi.fn<(layerId: string, name: string, value: unknown) => void>(),
  worldDimSpy: vi.fn<(map: unknown, on: boolean) => void>(),
  setDataSpy: vi.fn<(data: unknown) => void>(),
}));

vi.mock("maplibre-gl", () => {
  class MockMap {
    constructor(opts: unknown) {
      ctorSpy(opts);
    }
    on(type: string, a?: unknown, b?: unknown): this {
      onSpy(type, a, b);
      if (type === "load" && typeof a === "function") (a as () => void)();
      return this;
    }
    addImage(): void {}
    addSource(): void {}
    addLayer(): void {}
    setFeatureState(): void {}
    setPaintProperty(layerId: string, name: string, value: unknown): void {
      paintSpy(layerId, name, value);
    }
    getSource(): { setData: (data: unknown) => void; getClusterExpansionZoom: () => Promise<number> } {
      return { setData: (data: unknown) => setDataSpy(data), getClusterExpansionZoom: () => Promise.resolve(1) };
    }
    getCanvas(): { style: Record<string, string> } {
      return { style: {} };
    }
    easeTo(): void {}
    remove(): void {}
  }
  return { Map: MockMap };
});

// setWorldDim is spied (real impl kept for every other export) so the tests can assert the exact
// boolean the auto-dim wiring drives it with — the world-dim math itself is proven in entities.test.
vi.mock("../src/entities.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/entities.js")>();
  return { ...actual, setWorldDim: (map: unknown, on: boolean): void => worldDimSpy(map, on) };
});

// Imported AFTER vi.mock so the mocked module is in place (vitest hoists vi.mock).
import { MapCanvas } from "../src/MapCanvas.js";

function mark(id: string, status: Status): FleetFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "Point", coordinates: [-97.7, 30.3] },
    properties: {
      id,
      kind: "truck",
      bearing: 0,
      label: "AUSTIN -> DALLAS",
      shipment_id: id,
      statusStr: status,
      statusNum: status === "exception" ? 2 : status === "at-risk" ? 1 : 0,
      chip: "",
    },
  };
}

const fleet: FleetCollection = { type: "FeatureCollection", features: [mark("shp-1", "healthy")] };
const exceptionFleet: FleetCollection = {
  type: "FeatureCollection",
  features: [mark("shp-1", "healthy"), mark("shp-2", "exception")],
};

/** The last value MapCanvas painted onto (layerId, name), or undefined if it never did. */
function lastPaint(layerId: string, name: string): unknown {
  const calls = paintSpy.mock.calls.filter((c) => c[0] === layerId && c[1] === name);
  return calls.length ? calls[calls.length - 1]?.[2] : undefined;
}

describe("MapCanvas (REQ-073/080)", () => {
  beforeEach(() => {
    ctorSpy.mockClear();
    onSpy.mockClear();
    paintSpy.mockClear();
    worldDimSpy.mockClear();
    cleanup();
  });

  it("constructs a MapLibre map with the greige v8 style and no third-party attribution", () => {
    render(<MapCanvas tileUrl="TILE_URL" glyphsUrl="GLYPH_URL" fleet={fleet} onSelect={() => {}} />);
    expect(ctorSpy).toHaveBeenCalledTimes(1);
    const opts = ctorSpy.mock.calls[0]?.[0] as { style: { version: number }; attributionControl: boolean };
    expect(opts.style.version).toBe(8);
    expect(opts.attributionControl).toBe(false);
    expect(JSON.stringify(opts.style)).toContain("TILE_URL");
  });

  it("registers a click handler on the truck marks so a click opens the lens (REQ-080)", () => {
    render(<MapCanvas tileUrl="TILE_URL" glyphsUrl="GLYPH_URL" fleet={fleet} onSelect={() => {}} />);
    const clickCalls = onSpy.mock.calls.filter((c) => c[0] === "click");
    expect(clickCalls.length).toBeGreaterThan(0);
    expect(clickCalls.some((c) => c[1] === "trucks")).toBe(true);
  });
});

// M1 — the exception world-dim must be WIRED ON automatically (acceptance demo #5, REQ-077): the map
// dims itself whenever a visible exception exists in the scoped fleet, with no `dim` prop threaded
// from the screen, and LIFTS when the exception clears.
describe("MapCanvas — auto world-dim on a visible exception (REQ-077, demo #5)", () => {
  beforeEach(() => {
    ctorSpy.mockClear();
    onSpy.mockClear();
    paintSpy.mockClear();
    worldDimSpy.mockClear();
    cleanup();
  });

  it("dims the world (setWorldDim true) when the scoped fleet contains an exception — no dim prop", () => {
    render(<MapCanvas tileUrl="t" glyphsUrl="g" fleet={exceptionFleet} onSelect={() => {}} />);
    expect(worldDimSpy).toHaveBeenCalledWith(expect.anything(), true);
    expect(worldDimSpy.mock.calls.every((c) => c[1] === true)).toBe(true);
  });

  it("leaves the world lit (setWorldDim false) when no visible exception exists", () => {
    render(<MapCanvas tileUrl="t" glyphsUrl="g" fleet={fleet} onSelect={() => {}} />);
    expect(worldDimSpy).toHaveBeenCalled();
    expect(worldDimSpy.mock.calls.every((c) => c[1] === false)).toBe(true);
  });

  it("LIFTS the dim when the exception clears (a fresh healthy frame)", () => {
    const { rerender } = render(<MapCanvas tileUrl="t" glyphsUrl="g" fleet={exceptionFleet} onSelect={() => {}} />);
    expect(worldDimSpy).toHaveBeenCalledWith(expect.anything(), true);
    worldDimSpy.mockClear();
    rerender(<MapCanvas tileUrl="t" glyphsUrl="g" fleet={fleet} onSelect={() => {}} />);
    expect(worldDimSpy).toHaveBeenCalledWith(expect.anything(), false);
    expect(worldDimSpy.mock.calls.some((c) => c[1] === true)).toBe(false);
  });

  it("still honours an explicit dim override (dim={true} forces the alarm on even when healthy)", () => {
    render(<MapCanvas tileUrl="t" glyphsUrl="g" fleet={fleet} onSelect={() => {}} dim={true} />);
    expect(worldDimSpy).toHaveBeenCalledWith(expect.anything(), true);
  });
});

// m1 — a cluster that CONTAINS the exception must throb, not just stay lit. The gating moved from the
// paint expression into the layer split (`clusters-exception` filters on the aggregated maxStatus), so
// the pulse is now a CONSTANT write to that layer: same 1.6s urgent sine, no per-feature upload. The
// calm `clusters` layer is never written, keeping its static 1px stroke from the layer spec.
describe("MapCanvas — a clustered exception throbs (operational-map §6)", () => {
  beforeEach(() => {
    ctorSpy.mockClear();
    onSpy.mockClear();
    paintSpy.mockClear();
    worldDimSpy.mockClear();
    cleanup();
  });

  it("pulses clusters-exception with a constant width and leaves the calm cluster layer alone", () => {
    render(<MapCanvas tileUrl="t" glyphsUrl="g" fleet={exceptionFleet} onSelect={() => {}} />);
    const v = lastPaint("clusters-exception", "circle-stroke-width");
    expect(typeof v).toBe("number");
    expect(v as number).toBeGreaterThan(1); // lit AND throbbing > the calm 1px stroke
    expect(lastPaint("clusters", "circle-stroke-width")).toBeUndefined();
  });

  it("throbs the exception leaf and breathes at-risk, both as constants, never touching healthy", () => {
    render(<MapCanvas tileUrl="t" glyphsUrl="g" fleet={exceptionFleet} onSelect={() => {}} />);
    expect(typeof lastPaint("rest-exception", "circle-stroke-width")).toBe("number");
    expect(typeof lastPaint("rest-at-risk", "circle-stroke-width")).toBe("number");
    expect(lastPaint("rest-healthy", "circle-stroke-width")).toBeUndefined();
    expect(lastPaint("rest-exception", "circle-stroke-width") as number).toBeGreaterThan(
      lastPaint("rest-at-risk", "circle-stroke-width") as number,
    );
  });

  it("writes NO per-feature expression per frame — that is the whole defect being closed (REQ-079)", () => {
    render(<MapCanvas tileUrl="t" glyphsUrl="g" fleet={exceptionFleet} onSelect={() => {}} />);
    const pulsed = paintSpy.mock.calls.filter((c) => c[1] === "circle-stroke-width");
    expect(pulsed.length).toBeGreaterThan(0);
    for (const [layerId, , value] of pulsed) {
      expect(typeof value, `pulse write to '${layerId}' must be a scalar, not an expression`).toBe("number");
    }
  });

  it("opens the lens from EVERY at-rest leaf layer, so an exception mark stays clickable (REQ-080)", () => {
    render(<MapCanvas tileUrl="t" glyphsUrl="g" fleet={exceptionFleet} onSelect={() => {}} />);
    const clickLayers = onSpy.mock.calls.filter((c) => c[0] === "click").map((c) => c[1]);
    for (const id of ["rest-healthy", "rest-at-risk", "rest-exception", "trucks", "clusters", "clusters-exception"]) {
      expect(clickLayers, `no click handler on '${id}'`).toContain(id);
    }
  });
});

// The glide loop pushes a full setData onto a CLUSTERED source, which MapLibre cannot diff — every
// push reloads and re-parses every tile. So the loop must push only when something actually changed.
// "Changed" has two halves, and dropping either one is a bug: a coordinate moved (the glide's own
// signal) OR a fleet frame brought new properties (status/chip) without moving anything.
describe("MapCanvas — the throttled push fires only on real change (REQ-079)", () => {
  const frames: FrameRequestCallback[] = [];

  /** Run every currently-queued animation frame at `now`; each one re-queues itself. */
  function flush(now: number): void {
    for (const cb of frames.splice(0)) cb(now);
  }

  beforeEach(() => {
    ctorSpy.mockClear();
    onSpy.mockClear();
    paintSpy.mockClear();
    worldDimSpy.mockClear();
    setDataSpy.mockClear();
    frames.length = 0;
    cleanup();
    // Motion ON — otherwise the component takes the reduced-motion path and never schedules the loop.
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("skips the push when nothing moved and nothing changed", () => {
    render(<MapCanvas tileUrl="t" glyphsUrl="g" fleet={fleet} onSelect={() => {}} />);
    flush(1000); // the mount frame carries the initial fleet
    setDataSpy.mockClear();
    flush(2000); // > 33ms later, but the marks are already at their targets
    flush(3000);
    expect(setDataSpy).not.toHaveBeenCalled();
  });

  it("STILL pushes a frame that changed only properties — a status must never wait for motion", () => {
    const { rerender } = render(<MapCanvas tileUrl="t" glyphsUrl="g" fleet={fleet} onSelect={() => {}} />);
    flush(1000);
    setDataSpy.mockClear();
    flush(2000);
    expect(setDataSpy).not.toHaveBeenCalled(); // quiescent

    // Same coordinates, new status. The glide reports no movement; the push must happen anyway.
    const restatused: FleetCollection = {
      type: "FeatureCollection",
      features: [mark("shp-1", "exception")],
    };
    rerender(<MapCanvas tileUrl="t" glyphsUrl="g" fleet={restatused} onSelect={() => {}} />);
    flush(3000);
    expect(setDataSpy).toHaveBeenCalledTimes(1);
    const pushed = setDataSpy.mock.calls[0]?.[0] as FleetCollection;
    expect(pushed.features[0]?.properties.statusStr).toBe("exception");

    // …and exactly once: the dirty flag is consumed by the push that carries it.
    setDataSpy.mockClear();
    flush(4000);
    expect(setDataSpy).not.toHaveBeenCalled();
  });

  it("pushes while a mark is genuinely travelling", () => {
    const { rerender } = render(<MapCanvas tileUrl="t" glyphsUrl="g" fleet={fleet} onSelect={() => {}} />);
    flush(1000);

    const movedFleet: FleetCollection = {
      type: "FeatureCollection",
      features: [{ ...mark("shp-1", "healthy"), geometry: { type: "Point", coordinates: [-90, 35] } }],
    };
    rerender(<MapCanvas tileUrl="t" glyphsUrl="g" fleet={movedFleet} onSelect={() => {}} />);
    flush(2000);
    setDataSpy.mockClear();
    flush(3000); // still easing toward the new target
    expect(setDataSpy).toHaveBeenCalledTimes(1);
  });
});
