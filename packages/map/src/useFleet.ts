import { useCallback, useMemo, useRef, useState } from "react";
import {
  STATUS_NUM,
  type EntityKind,
  type FleetCollection,
  type FleetFeature,
  type Status,
} from "./entities.js";
import { generalizePosition } from "./generalize.js";

// useFleet is the scoped-subscription seam onto the fleet (WP-02 lens contract; live DO fan-out is
// WP-10). It returns the lens-scoped FeatureCollection the map renders, plus a setState that mirrors
// status into the properties the chip/layout read AND records the feature-state for MapCanvas to
// apply. Scoping is authoritative here for the synthetic source; in production the server never sends
// out-of-scope shipments (REQ-074) and this stays as defence-in-depth.

/** A single fleet entity as it arrives from the lens (the WP-02 shape). */
export interface FleetItem {
  id: string;
  lng: number;
  lat: number;
  bearing: number;
  kind: EntityKind;
  status: Status;
  risk?: string;
  label: string;
  shipment_id: string;
  party_refs: string[];
  driver_id?: string;
  out_for_delivery?: boolean;
}

/** The viewer's scope. Command sees the whole tenant fleet; driver only its assignments; party only
 * its own shipments, generalized to ~city until out-for-delivery (REQ-074). */
export type Lens =
  | { scope: "command" }
  | { scope: "driver"; driverId: string }
  | { scope: "party"; partyId: string };

/** The mirrored feature-state MapCanvas applies with setEntityState after each setData. */
export interface FleetEntityState {
  status: Status;
  risk?: string;
}

export interface UseFleetResult {
  collection: FleetCollection;
  states: ReadonlyMap<string, FleetEntityState>;
  setState(id: string, status: Status, risk?: string): void;
}

/** Server-side lens semantics, enforced here for the synthetic source. */
function scopeToLens(lens: Lens, source: readonly FleetItem[]): FleetItem[] {
  if (lens.scope === "driver") return source.filter((i) => i.driver_id === lens.driverId);
  if (lens.scope === "party") return source.filter((i) => i.party_refs.includes(lens.partyId));
  return [...source];
}

/** The mono status chip text (doc 07 / operational-map §4): a named risk speaks, an exception names
 * itself, everything else stays label-light so healthy marks don't clutter the canvas. */
function chipFor(status: Status, risk: string | undefined, label: string): string {
  if (risk) return risk;
  if (status === "exception") return `EXCEPTION · ${label}`;
  return "";
}

function toFeature(item: FleetItem, state: FleetEntityState | undefined): FleetFeature {
  const status = state?.status ?? item.status;
  const risk = state?.risk ?? item.risk;
  return {
    type: "Feature",
    id: item.id,
    geometry: { type: "Point", coordinates: [item.lng, item.lat] },
    properties: {
      id: item.id,
      kind: item.kind,
      bearing: item.bearing,
      label: item.label,
      shipment_id: item.shipment_id,
      statusStr: status,
      statusNum: STATUS_NUM[status],
      chip: chipFor(status, risk, item.label),
    },
  };
}

export function useFleet(lens: Lens, source: readonly FleetItem[]): UseFleetResult {
  const statesRef = useRef<Map<string, FleetEntityState>>(new Map());
  const [version, setVersion] = useState(0);

  const scoped = useMemo(() => scopeToLens(lens, source), [lens, source]);

  const collection = useMemo<FleetCollection>(() => {
    const features = scoped.map((item) => {
      const feature = toFeature(item, statesRef.current.get(item.id));
      return lens.scope === "party" ? generalizePosition(feature, item.out_for_delivery ?? false) : feature;
    });
    // `version` is a dependency so a setState re-derives the mirrored properties.
    void version;
    return { type: "FeatureCollection", features };
  }, [scoped, lens, version]);

  const setState = useCallback((id: string, status: Status, risk?: string): void => {
    statesRef.current.set(id, risk === undefined ? { status } : { status, risk });
    setVersion((v) => v + 1);
  }, []);

  return { collection, states: statesRef.current, setState };
}
