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
