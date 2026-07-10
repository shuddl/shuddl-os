import type { ExpressionSpecification, GeoJSONSourceSpecification, LayerSpecification } from "maplibre-gl";
import type { Feature, FeatureCollection, Point } from "geojson";
import { TOKENS } from "@shuddl/design";

// The entities are the ONLY saturated marks on the greige canvas. This module is the pure,
// unit-testable truth for the source + layer specs and the two state mutators — no WebGL. The
// correctness traps it encodes (from the terminal-gallery-map-ui operational-map reference):
//   • feature-state is PAINT-ONLY — never in `layout`/`filter`; status is mirrored into the
//     `statusStr`/`statusNum`/`chip` PROPERTIES for everything layout/filter/cluster reads.
//   • teal (--progress) is the ONE sanctioned saturated extra, and ONLY on the eta line (REQ-078).
//   • clusters size by COUNT (geometry), never by colour — a single red family (REQ-076).

export type Status = "healthy" | "at-risk" | "exception";
export type EntityKind = "truck" | "at_rest" | "facility" | "delivered";

/** Worst-state ordering, so `clusterProperties.maxStatus` aggregates the alarm to the cluster. */
export const STATUS_NUM: Record<Status, number> = { healthy: 0, "at-risk": 1, exception: 2 };

/** A fleet entity's mirrored properties. Status lives here (for layout/filter/cluster) AND as
 * feature-state (for instant paint). Declared as a `type` (not an interface) so it satisfies the
 * open `GeoJsonProperties` slot GeoJSON expects. */
export type FleetProperties = {
  id: string;
  kind: EntityKind;
  bearing: number;
  label: string;
  shipment_id: string;
  statusStr: Status;
  statusNum: number;
  chip: string;
};

export type FleetFeature = Feature<Point, FleetProperties>;
export type FleetCollection = FeatureCollection<Point, FleetProperties>;

const EMPTY_FLEET: FleetCollection = { type: "FeatureCollection", features: [] };

/** ONE clustered GeoJSON source for the whole fleet. `promoteId` gives every entity a stable id
 * so `setFeatureState` can target it; `maxStatus` aggregates the worst state in each cluster so a
 * cluster CONTAINING an exception stays lit while its neighbours dim (setWorldDim). */
export function fleetSource(data: FleetCollection = EMPTY_FLEET): GeoJSONSourceSpecification {
  return {
    type: "geojson",
    promoteId: "id",
    data,
    cluster: true,
    clusterRadius: 48,
    clusterMaxZoom: 7,
    clusterProperties: { maxStatus: ["max", ["get", "statusNum"]] },
  };
}

/** The six entity layers, in draw order (clusters underneath → eta on top). Every state-driven
 * paint value reads `["coalesce", ["feature-state","status"], ["get","statusStr"], "healthy"]` so it
 * works whether or not feature-state was applied yet, and survives a cluster `setData`. */
export function entityLayers(): LayerSpecification[] {
  // (a) Clusters — 1,000 points collapse to counts at low zoom. Size by count, single red family.
  const clusters: LayerSpecification = {
    id: "clusters",
    type: "circle",
    source: "fleet",
    filter: ["has", "point_count"],
    paint: {
      "circle-color": TOKENS.signal,
      "circle-opacity": 0.85,
      "circle-radius": ["step", ["get", "point_count"], 12, 50, 18, 250, 26],
      "circle-stroke-color": TOKENS.field,
      "circle-stroke-width": 1,
    },
  };

  const clusterCount: LayerSpecification = {
    id: "cluster-count",
    type: "symbol",
    source: "fleet",
    filter: ["has", "point_count"],
    layout: {
      "text-field": ["get", "point_count_abbreviated"],
      "text-font": ["JetBrains Mono Regular"],
      "text-size": 11,
      "text-letter-spacing": 0.08,
    },
    paint: { "text-color": TOKENS.field },
  };

  // (b) At-rest leaves — opacity/rings by STATE via feature-state (paint only). Exception + at-risk
  //     stay fully lit; everything else 0.9.
  const rest: LayerSpecification = {
    id: "rest",
    type: "circle",
    source: "fleet",
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-color": TOKENS.signal,
      "circle-opacity": [
        "match",
        ["coalesce", ["feature-state", "status"], ["get", "statusStr"], "healthy"],
        "exception", 1,
        "at-risk", 1,
        0.9,
      ],
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 3, 12, 6, 16, 9],
      "circle-stroke-color": TOKENS.signal,
      "circle-stroke-width": 1,
    },
  };

  // (c) Moving trucks as chevrons oriented to heading — icon-rotate reads the `bearing` PROPERTY
  //     (a layout property; it cannot read feature-state). The chevron art points north at 0°.
  const trucks: LayerSpecification = {
    id: "trucks",
    type: "symbol",
    source: "fleet",
    filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "kind"], "truck"]],
    layout: {
      "icon-image": "chevron",
      "icon-rotate": ["get", "bearing"],
      "icon-rotation-alignment": "map",
      "icon-size": ["interpolate", ["linear"], ["zoom"], 6, 0.5, 14, 1.1],
      "icon-allow-overlap": true,
    },
    paint: { "icon-opacity": ["case", ["boolean", ["feature-state", "dimmed"], false], 0.35, 1] },
  };

  // (d) Mono status chips — text-field reads the `chip` PROPERTY (layout can't read feature-state);
  //     empty chips are filtered so healthy marks stay label-light.
  const chips: LayerSpecification = {
    id: "chips",
    type: "symbol",
    source: "fleet",
    filter: ["all", ["!", ["has", "point_count"]], ["!=", ["get", "chip"], ""]],
    layout: {
      "text-field": ["get", "chip"],
      "text-font": ["JetBrains Mono Regular"],
      "text-size": 10,
      "text-letter-spacing": 0.1,
      "text-offset": [0, 1.4],
      "text-anchor": "top",
    },
    paint: { "text-color": TOKENS.signal, "text-halo-color": TOKENS.field, "text-halo-width": 1 },
  };

  // (e) The single sanctioned teal: the ETA fill on one focused shipment's remaining route (REQ-078).
  const eta: LayerSpecification = {
    id: "eta",
    type: "line",
    source: "focus-route",
    paint: { "line-color": TOKENS.progress, "line-width": 2, "line-opacity": 0.9 },
  };

  return [clusters, clusterCount, rest, trucks, chips, eta];
}

/** The minimal MapLibre surface the state mutators touch — a real `maplibregl.Map` is assignable to
 * it, and a test can supply a two-method stub. */
export interface StatefulMap {
  setFeatureState(target: { source: string; id: string | number }, state: Record<string, unknown>): void;
  setPaintProperty(layerId: string, name: string, value: unknown): void;
}

/** Apply a status to one entity as an event lands — O(1) paint via feature-state, no geometry
 * re-parse. The `chip`/`statusStr` property mirror (for layout/filter/cluster) is the caller's job
 * (useFleet), flushed on the next throttled `setData`. */
export function setEntityState(map: StatefulMap, id: string, status: Status, risk?: string): void {
  map.setFeatureState({ source: "fleet", id }, { status, risk: risk ?? null });
}

/** Exception world-dim (REQ-077): drop everything else to 35% so the one pulsing red mark is the
 * only lit thing — by PAINT, not a DOM veil. Leaves exempt the exception via feature-state; clusters
 * (which have no feature-state) exempt via the aggregated `maxStatus` (2 === exception). */
export function setWorldDim(map: StatefulMap, on: boolean): void {
  const dim = on ? 0.35 : 1;
  const keepLeaf: ExpressionSpecification = [
    "case",
    ["==", ["coalesce", ["feature-state", "status"], ["get", "statusStr"], "healthy"], "exception"],
    1,
    dim,
  ];
  const keepCluster: ExpressionSpecification = ["case", ["==", ["get", "maxStatus"], 2], 1, dim];
  map.setPaintProperty("rest", "circle-opacity", keepLeaf);
  map.setPaintProperty("trucks", "icon-opacity", keepLeaf);
  map.setPaintProperty("eta", "line-opacity", on ? dim : 0.9);
  map.setPaintProperty("clusters", "circle-opacity", keepCluster);
  map.setPaintProperty("cluster-count", "text-opacity", keepCluster);
}
