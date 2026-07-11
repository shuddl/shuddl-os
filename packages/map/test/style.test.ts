import { describe, expect, it } from "vitest";
import { greigeStyle, greigeStyleMapbox, mapboxTransformRequest } from "../src/style.js";

// The five blessed tokens (07-DESIGN-SYSTEM). The basemap may use ONLY these — a sixth colour on the
// map is the defect this test guards against (the scratchpad render once used a raw #C9C4BE water).
const BLESSED = new Set(["#D5D1CC", "#FF4A33", "#A52F18", "#1A1A1A", "#00C4B4"]);

/** Every hex colour literal anywhere in the style object (recursively). */
function hexes(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    const m = value.match(/#[0-9a-fA-F]{3,8}/g);
    if (m) out.push(...m.map((h) => h.toUpperCase()));
  } else if (Array.isArray(value)) {
    for (const v of value) hexes(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) hexes(v, out);
  }
  return out;
}

describe("greigeStyle (self-hosted default, OpenMapTiles schema)", () => {
  it("injects the provider endpoints and stays token-clean", () => {
    const s = greigeStyle("https://tiles.example/planet", "https://tiles.example/fonts");
    expect(JSON.stringify(s)).toContain("https://tiles.example/planet");
    for (const h of hexes(s)) expect(BLESSED.has(h)).toBe(true);
  });
});

describe("greigeStyleMapbox (opt-in Mapbox path, Streets v8 schema)", () => {
  const s = greigeStyleMapbox("https://glyphs.example/fonts");

  it("targets the Mapbox Streets v8 source and requires attribution", () => {
    const src = (s.sources as Record<string, { url?: string; attribution?: string }>).v;
    expect(src?.url).toBe("mapbox://mapbox.mapbox-streets-v8");
    expect(src?.attribution).toMatch(/Mapbox/);
  });

  it("uses the Mapbox-v8 source-layer names, NOT the OpenMapTiles ones (the demotiles-class bug)", () => {
    const layers = s.layers as Array<{ "source-layer"?: string }>;
    const sourceLayers = layers.map((l) => l["source-layer"]).filter(Boolean);
    expect(sourceLayers).toContain("road"); // not "transportation"
    expect(sourceLayers).toContain("admin"); // not "boundary"
    expect(sourceLayers).toContain("place_label"); // not "place"
    expect(sourceLayers).not.toContain("transportation");
    expect(sourceLayers).not.toContain("boundary");
  });

  it("carries only the five blessed tokens — no sixth colour on the basemap", () => {
    for (const h of hexes(s)) expect(BLESSED.has(h)).toBe(true);
  });

  it("keeps the blessed mono label font on the keyless glyph host (no Mapbox-hosted font)", () => {
    expect(s.glyphs).toBe("https://glyphs.example/fonts/{fontstack}/{range}.pbf");
    expect(JSON.stringify(s)).toContain("JetBrains Mono Regular");
  });
});

describe("mapboxTransformRequest", () => {
  const t = mapboxTransformRequest("pk.TESTTOKEN");

  it("resolves a mapbox:// tileset id to its TileJSON with the token", () => {
    const r = t("mapbox://mapbox.mapbox-streets-v8");
    expect(r?.url).toBe("https://api.mapbox.com/v4/mapbox.mapbox-streets-v8.json?secure=&access_token=pk.TESTTOKEN");
  });

  it("appends the token to a bare api.mapbox.com tile request", () => {
    const r = t("https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/4/3/6.vector.pbf");
    expect(r?.url).toContain("access_token=pk.TESTTOKEN");
  });

  it("does not double-append when a token is already present", () => {
    expect(t("https://api.mapbox.com/v4/x/1/1/1.pbf?access_token=abc")).toBeUndefined();
  });

  it("leaves a non-Mapbox (self-hosted glyph) request untouched", () => {
    expect(t("https://tiles.openfreemap.org/fonts/JetBrains%20Mono%20Regular/0-255.pbf")).toBeUndefined();
  });
});
