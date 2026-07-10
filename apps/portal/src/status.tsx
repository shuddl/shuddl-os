import { useMemo } from "react";
import { Display, Divider, Mono } from "@shuddl/design";
import {
  DEMO_GLYPHS_URL,
  DEMO_TILE_URL,
  MapCanvas,
  generalizePosition,
  type FleetCollection,
  type FleetFeature,
} from "@shuddl/map";

// PUBLIC STATUS (REQ-074) — a no-auth, single-shipment page. The position is CITY-GENERALIZED
// (generalizePosition, ~11km) until the shipment is out-for-delivery, so a shared tracking link never
// leaks an exact truck location. Scoped to one shipment only — this is not a filtered view of anyone
// else's world. Deterministic so the canonical screenshot is stable.

const SHIPMENT_ID = "SHP-40318";
const EXACT_LNG = -104.9903;
const EXACT_LAT = 39.7392;
const OUT_FOR_DELIVERY = false; // pre-OFD ⇒ coarsened

/** The single shipment as a generalized fleet-of-one for the shared canvas. */
function useGeneralizedShipment(): { collection: FleetCollection; coarse: FleetFeature } {
  return useMemo(() => {
    const exact: FleetFeature = {
      type: "Feature",
      id: SHIPMENT_ID,
      geometry: { type: "Point", coordinates: [EXACT_LNG, EXACT_LAT] },
      properties: {
        id: SHIPMENT_ID,
        kind: "truck",
        bearing: 118,
        label: "IN TRANSIT",
        shipment_id: SHIPMENT_ID,
        statusStr: "healthy",
        statusNum: 0,
        chip: "",
      },
    };
    const coarse = generalizePosition(exact, OUT_FOR_DELIVERY);
    return { collection: { type: "FeatureCollection", features: [coarse] }, coarse };
  }, []);
}

export function Status(): React.JSX.Element {
  const { collection, coarse } = useGeneralizedShipment();
  const [lng, lat] = coarse.geometry.coordinates;

  return (
    <main style={{ position: "fixed", inset: 0, background: "var(--field)", overflow: "hidden" }}>
      <MapCanvas tileUrl={DEMO_TILE_URL} glyphsUrl={DEMO_GLYPHS_URL} fleet={collection} onSelect={() => {}} dim={false} />

      <section style={{ position: "absolute", top: 48, left: 32, maxWidth: "80vw", display: "flex", flexDirection: "column", gap: 12 }}>
        <Mono size={11} color="var(--signal-55)">
          SHUDDL · TRACK · {SHIPMENT_ID}
        </Mono>
        <Display size="hero">IN TRANSIT</Display>
        <div style={{ maxWidth: 360 }}>
          <Divider />
        </div>
        <Mono size={12}>
          NEAR DENVER, CO · {(lat ?? 0).toFixed(1)}, {(lng ?? 0).toFixed(1)}
        </Mono>
        <Mono size={11} color="var(--signal-55)">
          POSITION GENERALIZED TO CITY UNTIL OUT FOR DELIVERY
        </Mono>
      </section>
    </main>
  );
}
