import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, MapLayerMouseEvent } from "maplibre-gl";
import { greigeStyle } from "./style.js";
import {
  entityLayers,
  fleetSource,
  setEntityState,
  setWorldDim,
  type FleetCollection,
  type FleetFeature,
} from "./entities.js";
import { chevronImage } from "./chevron.js";

// The operational canvas (REQ-073 full-viewport). MapLibre draws the greige basemap + the entity GL
// layers; positions glide via a throttled setData (~30fps ease-to-target, so 30s-sparse GPS reads as
// continuous), the two pulses ride one cheap sine, and a click opens the lens WITHOUT navigating the
// map away (REQ-080). All motion honours prefers-reduced-motion. The real WebGL render is exercised
// by the Playwright perf/screen harness; here the MapLibre construction is guarded so jsdom tests can
// mock it.

export interface MapCanvasProps {
  tileUrl: string;
  glyphsUrl: string;
  fleet: FleetCollection;
  onSelect: (shipmentId: string) => void;
  /** Optional world-dim OVERRIDE. Left undefined (the norm), the canvas dims itself whenever the
   * scoped fleet contains a visible exception and lifts when it clears — so acceptance demo #5 fires
   * off the ledger, not a prop. Pass `true`/`false` only to force the alarm on/off. */
  dim?: boolean;
}

/** A visible exception anywhere in the scoped fleet is what arms the world-dim (REQ-077). */
function hasVisibleException(fleet: FleetCollection): boolean {
  return fleet.features.some((f) => f.properties.statusStr === "exception");
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Planar heading, 0° = north (matches the chevron art), clockwise. */
function bearingTo(lng: number, lat: number, tlng: number, tlat: number): number {
  const deg = (Math.atan2(tlng - lng, tlat - lat) * 180) / Math.PI;
  return (deg + 360) % 360;
}

function cloneFeature(f: FleetFeature): FleetFeature {
  const c = f.geometry.coordinates;
  return {
    type: "Feature",
    id: f.id,
    geometry: { type: "Point", coordinates: [c[0] ?? 0, c[1] ?? 0] },
    properties: { ...f.properties },
  };
}

function targetsOf(fleet: FleetCollection): Map<string, [number, number]> {
  const targets = new Map<string, [number, number]>();
  for (const f of fleet.features) {
    const c = f.geometry.coordinates;
    targets.set(String(f.id), [c[0] ?? 0, c[1] ?? 0]);
  }
  return targets;
}

/** Keep the on-screen position of persisting marks (so they glide), seed new marks at their target,
 * always refresh the mirrored properties (statusStr/chip) from the incoming fleet. */
function mergeAnimated(prev: FleetCollection, fleet: FleetCollection): FleetCollection {
  const existing = new Map(prev.features.map((f) => [String(f.id), f]));
  return {
    type: "FeatureCollection",
    features: fleet.features.map((f) => {
      const kept = existing.get(String(f.id));
      if (kept) {
        kept.properties = f.properties;
        return kept;
      }
      return cloneFeature(f);
    }),
  };
}

function animateToward(fleet: FleetCollection, targets: ReadonlyMap<string, [number, number]>): void {
  for (const f of fleet.features) {
    const t = targets.get(String(f.id));
    if (!t) continue;
    const c = f.geometry.coordinates;
    const lng = c[0] ?? t[0];
    const lat = c[1] ?? t[1];
    f.geometry.coordinates = [lng + (t[0] - lng) * 0.2, lat + (t[1] - lat) * 0.2];
    f.properties.bearing = bearingTo(lng, lat, t[0], t[1]);
  }
}

/** Re-assert feature-state for the small non-healthy set after a setData (clusters can drop it). */
function applyStates(map: maplibregl.Map, fleet: FleetCollection): void {
  for (const f of fleet.features) {
    if (f.properties.statusStr !== "healthy") setEntityState(map, f.properties.id, f.properties.statusStr);
  }
}

function pushDataIfReady(map: maplibregl.Map, fleet: FleetCollection): void {
  const src = map.getSource("fleet");
  if (src && "setData" in src) {
    (src as GeoJSONSource).setData(fleet);
    applyStates(map, fleet);
  }
}

/** The two pulses off one sine: exception throbs (1.6s), at-risk breathes (3s), healthy is static.
 * Leaves throb via feature-state on the `rest` layer; a CLUSTER holding an exception (aggregated
 * `maxStatus === 2`) throbs on the same 1.6s urgent sine via its stroke-width — clusters have no
 * feature-state, so the gate reads the `maxStatus` property. Calmer clusters keep the static 1px
 * stroke, so a cluster containing the alarm is lit AND throbbing (operational-map §6) while its
 * neighbours stay quiet. Reduced-motion renders one static frame (the loop is never scheduled). */
function applyPulse(map: maplibregl.Map, ts: number): void {
  const urgent = 0.5 + 0.5 * Math.sin((ts / 1600) * 2 * Math.PI);
  const calm = 0.5 + 0.5 * Math.sin((ts / 3000) * 2 * Math.PI);
  map.setPaintProperty("rest", "circle-stroke-width", [
    "match",
    ["coalesce", ["feature-state", "status"], ["get", "statusStr"], "healthy"],
    "exception",
    2 + 4 * urgent,
    "at-risk",
    1 + 1.5 * calm,
    1,
  ]);
  map.setPaintProperty("clusters", "circle-stroke-width", [
    "case",
    ["==", ["get", "maxStatus"], 2],
    2 + 4 * urgent, // exception-bearing cluster: the same fat, throbbing ring
    1, // everything else: the static 1px stroke
  ]);
}

export function MapCanvas({ tileUrl, glyphsUrl, fleet, onSelect, dim }: MapCanvasProps): React.JSX.Element {
  // The world dims automatically on a visible exception; an explicit `dim` prop still overrides.
  const effectiveDim = dim ?? hasVisibleException(fleet);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const animatedRef = useRef<FleetCollection>({ type: "FeatureCollection", features: [] });
  const targetsRef = useRef<Map<string, [number, number]>>(new Map());
  const rafRef = useRef<number | null>(null);
  const pulseRafRef = useRef<number | null>(null);
  const lastDataRef = useRef(0);
  const reducedRef = useRef(false);
  const loadedRef = useRef(false);
  const fleetRef = useRef(fleet);
  const onSelectRef = useRef(onSelect);
  const dimRef = useRef(effectiveDim);
  fleetRef.current = fleet;
  onSelectRef.current = onSelect;
  dimRef.current = effectiveDim;

  // Construct the map once per tile/glyph endpoint. fleet/onSelect/dim are read via refs so the map
  // is never torn down and rebuilt on a data tick.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const map = new maplibregl.Map({
      container,
      style: greigeStyle(tileUrl, glyphsUrl),
      center: [-98.5, 39.5],
      zoom: 4,
      attributionControl: false,
    });
    mapRef.current = map;
    reducedRef.current = prefersReducedMotion();

    const tick = (now: number): void => {
      animateToward(animatedRef.current, targetsRef.current);
      if (now - lastDataRef.current >= 33) {
        pushDataIfReady(map, animatedRef.current);
        lastDataRef.current = now;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    const pulseFrame = (now: number): void => {
      applyPulse(map, now);
      if (!reducedRef.current) pulseRafRef.current = requestAnimationFrame(pulseFrame);
    };

    map.on("load", () => {
      map.addImage("chevron", chevronImage());
      animatedRef.current = { type: "FeatureCollection", features: fleetRef.current.features.map(cloneFeature) };
      targetsRef.current = targetsOf(fleetRef.current);
      map.addSource("fleet", fleetSource(animatedRef.current));
      map.addSource("focus-route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      for (const layer of entityLayers()) map.addLayer(layer);
      applyStates(map, animatedRef.current);
      setWorldDim(map, dimRef.current);
      loadedRef.current = true;

      const openLens = (e: MapLayerMouseEvent): void => {
        const sid = e.features?.[0]?.properties?.["shipment_id"];
        if (typeof sid === "string") onSelectRef.current(sid);
      };
      map.on("click", "trucks", openLens);
      map.on("click", "rest", openLens);
      map.on("click", "clusters", (e: MapLayerMouseEvent) => {
        const cid = e.features?.[0]?.properties?.["cluster_id"];
        const geometry = e.features?.[0]?.geometry;
        const src = map.getSource("fleet");
        if (typeof cid !== "number" || !src || !("getClusterExpansionZoom" in src)) return;
        void (src as GeoJSONSource).getClusterExpansionZoom(cid).then((zoom) => {
          if (geometry && geometry.type === "Point") {
            map.easeTo({ center: [geometry.coordinates[0] ?? 0, geometry.coordinates[1] ?? 0], zoom });
          }
        });
      });
      map.on("mouseenter", "trucks", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "trucks", () => {
        map.getCanvas().style.cursor = "";
      });

      if (reducedRef.current) {
        pulseFrame(0); // one static frame, no loop
      } else {
        rafRef.current = requestAnimationFrame(tick);
        pulseRafRef.current = requestAnimationFrame(pulseFrame);
      }
    });

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (pulseRafRef.current !== null) cancelAnimationFrame(pulseRafRef.current);
      loadedRef.current = false;
      map.remove();
      mapRef.current = null;
    };
  }, [tileUrl, glyphsUrl]);

  // A new fleet frame: retarget the glide and refresh the mirror, then push once (throttled loop
  // picks it up; under reduced-motion we snap and push immediately).
  useEffect(() => {
    targetsRef.current = targetsOf(fleet);
    animatedRef.current = mergeAnimated(animatedRef.current, fleet);
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    if (reducedRef.current) {
      for (const f of animatedRef.current.features) {
        const t = targetsRef.current.get(String(f.id));
        if (t) f.geometry.coordinates = [t[0], t[1]];
      }
      pushDataIfReady(map, animatedRef.current);
    }
  }, [fleet]);

  // Exception world-dim (REQ-077, acceptance demo #5) — paint only, once the layers exist. Driven by
  // `effectiveDim` (a visible exception, unless the screen overrides), so the world dims the instant
  // an exception lands in the scoped fleet and lifts the instant it clears.
  useEffect(() => {
    const map = mapRef.current;
    if (map && loadedRef.current) setWorldDim(map, effectiveDim);
  }, [effectiveDim]);

  return (
    <div
      ref={containerRef}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", background: "var(--field)" }}
    />
  );
}
