import type { StyleSpecification } from "maplibre-gl";
import greigeTemplate from "../greige-style.json";

// The greige "Terminal Gallery" basemap (REQ-075): land --field, water/waterway --ink-dark @6%,
// roads/boundaries --signal @5–14%, city labels micro-mono in signal-55. No terrain, no POI, no
// building fills, no colour beyond the three basemap tokens — saturation is reserved for the
// entity marks drawn on top (entities.ts). The template lives in ../greige-style.json (copied from
// the terminal-gallery-map-ui skill) with two provider placeholders; this function injects them.

const TILE_PLACEHOLDER = "{PROVIDER_VECTOR_TILE_URL}";
const GLYPHS_PLACEHOLDER = "{PROVIDER_GLYPHS_URL}";

/** Recursively drop `"//"` documentation keys so the runtime style is style-spec clean. */
function stripComments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripComments);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (key !== "//") out[key] = stripComments(val);
    }
    return out;
  }
  return value;
}

/**
 * Build the MapLibre greige style, targeting a self-hosted vector tile endpoint and glyph
 * endpoint (REQ-075). `tileUrl` replaces the vector source URL; `glyphsUrl` replaces the glyph
 * host (the `{fontstack}/{range}.pbf` suffix is preserved). Returns a valid v8 style.
 */
export function greigeStyle(tileUrl: string, glyphsUrl: string): StyleSpecification {
  const injected = JSON.stringify(greigeTemplate)
    .split(TILE_PLACEHOLDER).join(tileUrl)
    .split(GLYPHS_PLACEHOLDER).join(glyphsUrl);
  return stripComments(JSON.parse(injected)) as StyleSpecification;
}

// ── Mapbox path (opt-in, evaluation / promo) ───────────────────────────────────────────────────
// REQ-075 keeps the SHIPPED default self-hosted (greigeStyle above). This second builder renders the
// SAME greige grammar on Mapbox's own vector tiles when an owner token is supplied via
// VITE_MAPBOX_TOKEN — proven in-browser on the owner's tiles (tools/live/out/command-mapbox*.png).
// Two things differ from the OpenMapTiles template and MUST be right or the basemap renders blank
// (the demotiles-schema class of bug): Mapbox Streets v8 renames source-layers
// (transportation→road, boundary→admin, place→place_label, class "city"→"settlement"), and Mapbox
// requires visible attribution. Glyphs stay on the keyless self-hosted endpoint so city labels keep
// the blessed JetBrains-Mono micro-type — no Mapbox-hosted font is introduced. Only the five blessed
// tokens appear (water = --ink-dark @6%, never a sixth colour). Caveat for the owner: Mapbox's ToS
// governs use of their tiles; confirm your plan permits this before shipping the Mapbox path.

const MAPBOX_STREETS = "mapbox://mapbox.mapbox-streets-v8";

/** The greige "Terminal Gallery" basemap on Mapbox Streets v8 vectors. `glyphsUrl` is the keyless
 * self-hosted glyph host (mono labels, REQ-075); the vector source is resolved by
 * `mapboxTransformRequest`. Returns a valid v8 style carrying only the blessed tokens. */
export function greigeStyleMapbox(glyphsUrl: string): StyleSpecification {
  return {
    version: 8,
    name: "shuddl-terminal-gallery-mapbox",
    glyphs: `${glyphsUrl}/{fontstack}/{range}.pbf`,
    sources: {
      v: { type: "vector", url: MAPBOX_STREETS, attribution: "© Mapbox © OpenStreetMap" },
    },
    layers: [
      { id: "field", type: "background", paint: { "background-color": "#D5D1CC" } },
      { id: "water", type: "fill", source: "v", "source-layer": "water",
        paint: { "fill-color": "#1A1A1A", "fill-opacity": 0.06 } },
      { id: "waterway", type: "line", source: "v", "source-layer": "waterway",
        paint: { "line-color": "#1A1A1A", "line-opacity": 0.06, "line-width": 0.6 } },
      { id: "road-minor", type: "line", source: "v", "source-layer": "road",
        filter: ["!in", "class", "motorway", "trunk", "primary"],
        layout: { "line-cap": "round" },
        paint: { "line-color": "#FF4A33", "line-opacity": 0.05,
          "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.3, 12, 0.8, 16, 1.4] } },
      { id: "road-major", type: "line", source: "v", "source-layer": "road",
        filter: ["in", "class", "motorway", "trunk", "primary"],
        layout: { "line-cap": "round" },
        paint: { "line-color": "#FF4A33", "line-opacity": 0.1,
          "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.4, 10, 1.2, 16, 3.0] } },
      { id: "boundary", type: "line", source: "v", "source-layer": "admin",
        filter: ["<=", "admin_level", 1],
        paint: { "line-color": "#FF4A33", "line-opacity": 0.14, "line-width": 0.5, "line-dasharray": [3, 3] } },
      { id: "place-major", type: "symbol", source: "v", "source-layer": "place_label",
        filter: ["in", "class", "country", "state", "settlement"],
        layout: {
          "text-field": ["upcase", ["coalesce", ["get", "name_en"], ["get", "name"]]],
          "text-font": ["JetBrains Mono Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 3, 9, 8, 11],
          "text-letter-spacing": 0.12, "text-max-width": 8, "text-padding": 24,
        },
        paint: { "text-color": "#FF4A33", "text-opacity": 0.55, "text-halo-color": "#D5D1CC", "text-halo-width": 1 } },
    ],
  } as StyleSpecification;
}

/** MapLibre `transformRequest` that resolves `mapbox://` URLs against the Mapbox API with the owner
 * token: a tileset id → its TileJSON, and any api.mapbox.com request gets the token appended. Glyphs
 * are served elsewhere (self-hosted), so `mapbox://fonts/*` is intentionally not handled here. */
export function mapboxTransformRequest(token: string): (url: string) => { url: string } | undefined {
  return (url: string) => {
    if (url.startsWith("mapbox://")) {
      const id = url.slice("mapbox://".length);
      return { url: `https://api.mapbox.com/v4/${id}.json?secure=&access_token=${token}` };
    }
    if (url.includes("api.mapbox.com") && !url.includes("access_token=")) {
      return { url: `${url}${url.includes("?") ? "&" : "?"}access_token=${token}` };
    }
    return undefined;
  };
}
