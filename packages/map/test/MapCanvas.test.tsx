import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type { FleetCollection } from "../src/entities.js";

// The real WebGL render is Task 6's Playwright job. Here we mock MapLibre and assert the two things
// that make MapCanvas correct at construction: it hands MapLibre the GREIGE style (not a default
// street style), and it registers a click handler so a mark opens the lens — the map itself never
// navigates away (REQ-080).

const { ctorSpy, onSpy } = vi.hoisted(() => ({ ctorSpy: vi.fn(), onSpy: vi.fn() }));

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
    setPaintProperty(): void {}
    getSource(): { setData: () => void; getClusterExpansionZoom: () => Promise<number> } {
      return { setData: () => {}, getClusterExpansionZoom: () => Promise.resolve(1) };
    }
    getCanvas(): { style: Record<string, string> } {
      return { style: {} };
    }
    easeTo(): void {}
    remove(): void {}
  }
  return { Map: MockMap };
});

// Imported AFTER vi.mock so the mocked module is in place (vitest hoists vi.mock).
import { MapCanvas } from "../src/MapCanvas.js";

const fleet: FleetCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: "shp-1",
      geometry: { type: "Point", coordinates: [-97.7, 30.3] },
      properties: {
        id: "shp-1",
        kind: "truck",
        bearing: 0,
        label: "AUSTIN -> DALLAS",
        shipment_id: "shp-1",
        statusStr: "healthy",
        statusNum: 0,
        chip: "",
      },
    },
  ],
};

describe("MapCanvas (REQ-073/080)", () => {
  beforeEach(() => {
    ctorSpy.mockClear();
    onSpy.mockClear();
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
