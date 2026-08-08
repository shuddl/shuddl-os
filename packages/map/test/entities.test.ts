import { describe, it, expect } from "vitest";
import type { LayerSpecification } from "maplibre-gl";
import { greigeStyle } from "../src/style.js";
import {
  CLUSTER_LAYERS,
  REST_LAYERS,
  fleetSource,
  entityLayers,
  STATUS_NUM,
  setEntityState,
  setWorldDim,
} from "../src/entities.js";
import { chevronImage } from "../src/chevron.js";

// The map is 80% custom style; the entities are the only saturated marks. These specs are the
// unit-testable truth — no WebGL, no render. The rules under test are the ones that break naive
// builds: feature-state is PAINT-ONLY, teal is eta-only, clusters size by count not colour.

/** Find a layer by id or throw (keeps the value non-undefined without a `!`). */
function layer(id: string): LayerSpecification {
  const found = entityLayers().find((l) => l.id === id);
  if (!found) throw new Error(`no entity layer '${id}'`);
  return found;
}

describe("greigeStyle — the greige basemap (REQ-075/145)", () => {
  it("carries ONLY the three basemap tokens — teal lives on the entity layer, not the map", () => {
    const hex = JSON.stringify(greigeStyle("t", "g")).match(/#[0-9A-Fa-f]{6}/g) ?? [];
    expect(new Set(hex.map((h) => h.toUpperCase()))).toEqual(new Set(["#D5D1CC", "#FF4A33", "#1A1A1A"]));
  });

  it("is a v8 style with a greige background and no terrain/POI/raster/3D layers", () => {
    const s = greigeStyle("https://tiles.example/{z}/{x}/{y}", "https://glyphs.example");
    expect(s.version).toBe(8);
    expect(s.layers.some((l) => l.type === "background")).toBe(true);
    for (const l of s.layers) {
      expect(["raster", "hillshade", "fill-extrusion", "heatmap"]).not.toContain(l.type);
    }
  });

  it("injects the tile + glyph URLs and leaves no provider placeholders (self-hosted-ready)", () => {
    const s = greigeStyle("TILE_URL", "GLYPH_URL");
    expect(JSON.stringify(s)).toContain("TILE_URL");
    expect(s.glyphs).toContain("GLYPH_URL");
    expect(JSON.stringify(s)).not.toContain("PROVIDER_");
  });
});

describe("fleetSource — one clustered source (REQ-076/079)", () => {
  it("is a clustered geojson source with a promotable id and a worst-state aggregation", () => {
    const s = fleetSource();
    expect(s.type).toBe("geojson");
    expect(s.promoteId).toBe("id");
    expect(s.cluster).toBe(true);
    expect(s.clusterProperties).toEqual({ maxStatus: ["max", ["get", "statusNum"]] });
  });
});

describe("entityLayers — the paint-only rule + teal discipline (REQ-076/077/078)", () => {
  it("uses feature-state ONLY in paint — never in layout, never in a filter", () => {
    for (const l of entityLayers()) {
      const filter = "filter" in l ? l.filter : undefined;
      expect(JSON.stringify(l.layout ?? {})).not.toContain("feature-state");
      expect(JSON.stringify(filter ?? [])).not.toContain("feature-state");
    }
  });

  it("draws the chip label from the mirrored `chip` property (text-field cannot read feature-state)", () => {
    const chips = layer("chips");
    expect(JSON.stringify(chips.layout)).toContain('["get","chip"]');
  });

  it("puts teal (--progress #00C4B4) ONLY on the eta layer (REQ-078)", () => {
    for (const l of entityLayers()) {
      if (l.id !== "eta") expect(JSON.stringify(l)).not.toContain("00C4B4");
    }
    expect(JSON.stringify(layer("eta"))).toContain("00C4B4");
  });

  it("sizes clusters by count, not colour — a single red family (REQ-076)", () => {
    const clusters = layer("clusters");
    if (clusters.type !== "circle") throw new Error("clusters must be a circle layer");
    expect(clusters.paint?.["circle-radius"]).toEqual(["step", ["get", "point_count"], 12, 50, 18, 250, 26]);
    expect(clusters.paint?.["circle-color"]).toBe("#FF4A33");
  });

  it("exposes exactly the entity layers, in draw order (clusters under → eta on top)", () => {
    expect(entityLayers().map((l) => l.id)).toEqual([
      "clusters",
      "clusters-exception",
      "cluster-count",
      "rest-healthy",
      "rest-at-risk",
      "rest-exception",
      "trucks",
      "chips",
      "eta",
    ]);
  });
});

// REQ-079: the pulse targets are separate layers so the ANIMATED paint value can be a constant. That
// only works if the split partitions the fleet exactly — every mark drawn once, by the layer whose
// pulse matches its status. A gap loses marks from the board; an overlap double-draws them (visible as
// a darker ring) and pays the cost twice.
describe("entityLayers — the pulse split partitions the fleet (REQ-079)", () => {
  /** Evaluate the subset of the filter grammar these layers use, against a plain feature. */
  function matches(filter: unknown, props: Record<string, unknown>): boolean {
    if (!Array.isArray(filter)) return true;
    const [op, ...rest] = filter as [string, ...unknown[]];
    const value = (operand: unknown): unknown => {
      if (Array.isArray(operand) && operand[0] === "get") return props[operand[1] as string];
      return operand;
    };
    if (op === "all") return rest.every((f) => matches(f, props));
    if (op === "!") return !matches(rest[0], props);
    if (op === "has") return props[rest[0] as string] !== undefined;
    if (op === "==") return value(rest[0]) === value(rest[1]);
    if (op === "!=") return value(rest[0]) !== value(rest[1]);
    throw new Error(`unhandled filter op '${op}'`);
  }

  const layerFilter = (id: string): unknown => {
    const l = layer(id);
    return "filter" in l ? l.filter : undefined;
  };

  it("draws every LEAF exactly once, whatever its status", () => {
    for (const statusStr of ["healthy", "at-risk", "exception", "something-unforeseen"]) {
      const hits = ["rest-healthy", "rest-at-risk", "rest-exception"].filter((id) =>
        matches(layerFilter(id), { statusStr }),
      );
      expect(hits, `statusStr='${statusStr}' must match exactly one leaf layer`).toHaveLength(1);
    }
  });

  it("draws every CLUSTER exactly once, whatever it aggregates", () => {
    for (const maxStatus of [0, 1, 2, undefined]) {
      const hits = ["clusters", "clusters-exception"].filter((id) =>
        matches(layerFilter(id), { point_count: 7, maxStatus }),
      );
      expect(hits, `maxStatus=${String(maxStatus)} must match exactly one cluster layer`).toHaveLength(1);
    }
  });

  it("keeps clusters and leaves disjoint — a cluster is never drawn as a leaf, or vice versa", () => {
    const clusterFeature = { point_count: 7, maxStatus: 2 };
    const leafFeature = { statusStr: "exception" };
    for (const id of ["rest-healthy", "rest-at-risk", "rest-exception"]) {
      expect(matches(layerFilter(id), clusterFeature), `${id} must not draw clusters`).toBe(false);
    }
    for (const id of ["clusters", "clusters-exception"]) {
      expect(matches(layerFilter(id), leafFeature), `${id} must not draw leaves`).toBe(false);
    }
  });

  it("gives the three leaf layers byte-identical paint apart from the pulsed stroke width", () => {
    const paints = ["rest-healthy", "rest-at-risk", "rest-exception"].map((id) => {
      const l = layer(id);
      if (l.type !== "circle") throw new Error(`${id} must be a circle layer`);
      return JSON.stringify(l.paint);
    });
    expect(new Set(paints).size, "a mark's look must not depend on which layer draws it").toBe(1);
  });

  // REQ-077 §641 — THE SAME HALF-GUARD, ONE EXPRESSION OVER. §640 pinned the world-DIM's two arms; this is
  // the AT-REST paint, a `match` whose own comment states the intent: "Exception + at-risk stay fully lit;
  // everything else 0.9."
  //
  // MEASURED (§641): setting the exception arm to 0.9 — so an exception mark renders identically to a healthy
  // one, at rest, with no dim involved — left packages/map at 88/88 GREEN. The byte-identical-paint test above
  // compares the three leaf layers to EACH OTHER, so a change applied to all three keeps them equal and stays
  // silent. Comparing siblings cannot see a change that moves every sibling.
  it("at rest, exception and at-risk stay fully lit while the rest fade — the arms must differ", () => {
    const l = layer("rest-exception");
    if (l.type !== "circle") throw new Error("rest-exception must be a circle layer");
    const expr = (l.paint as { "circle-opacity": unknown[] })["circle-opacity"];
    expect(Array.isArray(expr) && expr[0] === "match", "expected a match expression").toBe(true);
    const arms = new Map<string, unknown>();
    for (let i = 2; i < expr.length - 1; i += 2) arms.set(String(expr[i]), expr[i + 1]);
    const fallback = expr[expr.length - 1];
    expect(arms.get("exception"), "an exception mark must stay fully lit").toBe(1);
    expect(arms.get("at-risk"), "an at-risk mark must stay fully lit").toBe(1);
    expect(fallback, "everything else fades").toBe(0.9);
    expect(
      arms.get("exception") === fallback,
      "exception and the fallback render identically — an exception is indistinguishable from a healthy mark " +
        "at rest, which is acceptance demo 5's subject before any dim is applied",
    ).toBe(false);
  });

  it("filters on the STATIC status mirror only — a filter can never read feature-state", () => {
    for (const l of entityLayers()) {
      const filter = "filter" in l ? l.filter : undefined;
      expect(JSON.stringify(filter ?? [])).not.toContain("feature-state");
    }
  });
});

describe("setEntityState — instant paint via feature-state (REQ-076)", () => {
  it("applies the status as feature-state on the fleet source", () => {
    const calls: Array<[unknown, unknown]> = [];
    const map = {
      setFeatureState: (target: unknown, state: unknown): void => {
        calls.push([target, state]);
      },
      setPaintProperty: (): void => {},
    };
    setEntityState(map, "shp-1", "at-risk", "DWELL");
    expect(calls[0]?.[0]).toEqual({ source: "fleet", id: "shp-1" });
    expect(calls[0]?.[1]).toMatchObject({ status: "at-risk" });
  });
});

describe("STATUS_NUM — worst-state ordering", () => {
  it("orders healthy < at-risk < exception so maxStatus aggregates the alarm", () => {
    expect(STATUS_NUM.healthy).toBe(0);
    expect(STATUS_NUM["at-risk"]).toBe(1);
    expect(STATUS_NUM.exception).toBe(2);
  });
});

describe("setWorldDim — dim the world by contrast, exempt the exception (REQ-077)", () => {
  function recorder(): {
    map: { setPaintProperty: (l: string, p: string, v: unknown) => void; setFeatureState: () => void };
    get: (l: string, p: string) => unknown;
    touched: () => string[];
  } {
    const calls: Array<[string, string, unknown]> = [];
    return {
      map: {
        setPaintProperty: (l, p, v): void => {
          calls.push([l, p, v]);
        },
        setFeatureState: (): void => {},
      },
      get: (l, p) => calls.find(([cl, cp]) => cl === l && cp === p)?.[2],
      touched: () => calls.map(([l]) => l),
    };
  }

  it("keeps the exception lit on leaves via feature-state and on clusters via maxStatus", () => {
    const { map, get } = recorder();
    setWorldDim(map, true);
    for (const id of REST_LAYERS) {
      expect(JSON.stringify(get(id, "circle-opacity"))).toContain("feature-state");
      expect(JSON.stringify(get(id, "circle-opacity"))).toContain("exception");
    }
    expect(JSON.stringify(get("trucks", "icon-opacity"))).toContain("feature-state");
    for (const id of CLUSTER_LAYERS) {
      expect(JSON.stringify(get(id, "circle-opacity"))).toContain('["get","maxStatus"]');
    }
    expect(JSON.stringify(get("cluster-count", "text-opacity"))).toContain('["get","maxStatus"]');
  });

  it("dims everything else to 0.35 when on", () => {
    const { map, get } = recorder();
    setWorldDim(map, true);
    for (const id of REST_LAYERS) expect(JSON.stringify(get(id, "circle-opacity"))).toContain("0.35");
  });

  // REQ-077 §640 — DEMO 5's DEFINING HALF: the exception stays LIT while the world dims.
  //
  // CLAUDE.md's fifth acceptance demo is "the exception pulse dimming the map WHILE EVERYTHING ELSE STAYS
  // QUIET". Two claims live in that sentence, and only one was guarded. The test above asserts the dimmed
  // expression CONTAINS "0.35" — which stays true if the exception branch dims too, because then BOTH
  // branches are 0.35 and the string still matches.
  //
  // MEASURED (§640): setting the exception branch to `dim` — so an exception fades into the crowd and the
  // demo loses its entire point — left the map suite at 87/87 GREEN. A uniform dim is not this demo; it is
  // the absence of it.
  //
  // The fix asserts the branches DIFFER, which is the property the sentence actually states. Reading one
  // side and computing the other: the exception arm must be full opacity, the fallback must be the dim
  // factor, and they must not be equal.
  it("when dimmed, the EXCEPTION arm stays lit while the fallback dims — the two must differ", () => {
    const { map, get } = recorder();
    setWorldDim(map, true);
    for (const id of REST_LAYERS) {
      const expr = get(id, "circle-opacity") as unknown[];
      expect(Array.isArray(expr) && expr[0] === "case", `${id}: expected a case expression`).toBe(true);
      const exceptionArm = expr[2];
      const fallback = expr[expr.length - 1];
      expect(exceptionArm, `${id}: the exception arm must stay fully lit`).toBe(1);
      expect(fallback, `${id}: everything else must dim`).toBe(0.35);
      expect(
        exceptionArm === fallback,
        `${id}: exception and fallback opacity are EQUAL — the world dims uniformly and the exception no ` +
          "longer stands out, which is the whole of acceptance demo 5",
      ).toBe(false);
    }
  });

  it("restores full opacity when off (dim factor 1, exception unchanged)", () => {
    const { map, get } = recorder();
    setWorldDim(map, false);
    for (const id of REST_LAYERS) {
      const restOpacity = JSON.stringify(get(id, "circle-opacity"));
      expect(restOpacity).not.toContain("0.35");
      expect(restOpacity).toContain("1");
    }
  });

  // The split multiplied the layers the world-dim has to reach. A layer it forgets stays fully lit
  // while the world darkens around it — the alarm would no longer be the only lit thing (REQ-077).
  // Pinned as an EQUALITY so adding a layer without dimming it fails here rather than on the map.
  // `chips` is deliberately absent and was before the split: the chip text is the label of the mark
  // that is speaking, and it has never been dimmed. Changing that is a design decision, not a
  // performance one, so it is out of scope here.
  it("reaches exactly the layers it is meant to — the split left none behind", () => {
    const { map, touched } = recorder();
    setWorldDim(map, true);
    expect(new Set(touched())).toEqual(
      new Set([...REST_LAYERS, ...CLUSTER_LAYERS, "trucks", "cluster-count", "eta"]),
    );
    const dimmable = new Set(entityLayers().map((l) => l.id));
    for (const id of touched()) expect(dimmable, `dims a layer that does not exist: '${id}'`).toContain(id);
  });
});

describe("chevronImage — a north-pointing mark (REQ-076)", () => {
  it("returns an RGBA bitmap whose data length is width*height*4", () => {
    const img = chevronImage();
    expect(img.width).toBeGreaterThan(0);
    expect(img.height).toBeGreaterThan(0);
    expect(img.data.length).toBe(img.width * img.height * 4);
  });

  it("points NORTH at 0°: the apex is drawn top-centre, the top corners are empty", () => {
    const img = chevronImage();
    const alpha = (x: number, y: number): number => img.data[(y * img.width + x) * 4 + 3] ?? 0;
    const cx = Math.floor(img.width / 2);
    expect(alpha(cx, 3) + alpha(cx, 4) + alpha(cx, 5)).toBeGreaterThan(0); // apex lit
    expect(alpha(1, 1)).toBe(0); // top-left corner empty
    expect(alpha(img.width - 2, 1)).toBe(0); // top-right corner empty
  });

  it("lights pixels in signal red only — no non-token colour (REQ-145)", () => {
    const img = chevronImage();
    for (let i = 0; i < img.data.length; i += 4) {
      if ((img.data[i + 3] ?? 0) > 0) {
        expect([img.data[i], img.data[i + 1], img.data[i + 2]]).toEqual([255, 74, 51]);
        return;
      }
    }
    throw new Error("chevron has no lit pixels");
  });
});
