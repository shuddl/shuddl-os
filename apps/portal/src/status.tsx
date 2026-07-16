import { useEffect, useState } from "react";
import { Display, Divider, Mono } from "@shuddl/design";
import { DEMO_GLYPHS_URL, DEMO_TILE_URL, MapCanvas, type FleetCollection } from "@shuddl/map";
import { get } from "./lib/api.js";

// PUBLIC STATUS (REQ-086) — a no-auth, single-shipment tracking page. It reads the (forwardable) status cap
// from the URL and calls GET /pub/status/:cap (NO session, NO bearer scoping) — the FIRST public data read.
// It renders ONLY what the public API returns:
//   · the milestone `state`;
//   · the position, which is ALWAYS city-generalized server-side (~11km, even at OFD, because a cap URL is
//     forwardable) — rendered as coarse text with an explicit "generalized to city" caption, NEVER implying
//     an exact truck location;
//   · eta ONLY if the server sends a real one — it omits eta today, so we render nothing for it (a fabricated
//     number would violate the honest-instrument law).
// ANY failure — a bad/expired cap (a uniform 401), a missing cap, or any read fault — collapses to the SAME
// clean "STATUS UNAVAILABLE" with no detail/existence leak, mirroring the server's uniform deny.

// Opt-in Mapbox tiles when VITE_MAPBOX_TOKEN is set at build; unset ⇒ self-hosted default (REQ-075).
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;

// The public status shape (mirrors workers/api/src/pub/status.ts PublicStatus). position is city-coarse e6
// integers; eta is optional and NEVER populated by the server today.
interface PublicStatus {
  state: string;
  out_for_delivery: boolean;
  position?: { lat_e6: number; lon_e6: number };
  eta?: number;
}

type Phase = { kind: "loading" } | { kind: "ready"; status: PublicStatus } | { kind: "unavailable" };

// The greige field is the whole page; no marker feature is synthesized for an anonymous public shipment (the
// honest coarse position rides the TEXT overlay, never a precise-looking dot).
const EMPTY_FLEET: FleetCollection = { type: "FeatureCollection", features: [] };

/** e6 integer → a COARSE 1-decimal degree string (~city). The server already coarsened; this only formats. */
function coarseDeg(e6: number): string {
  return (e6 / 1_000_000).toFixed(1);
}

export function Status({ cap }: { cap: string | null }): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>(cap ? { kind: "loading" } : { kind: "unavailable" });

  useEffect(() => {
    if (!cap) {
      setPhase({ kind: "unavailable" });
      return;
    }
    let live = true;
    setPhase({ kind: "loading" });
    get<PublicStatus>(`/pub/status/${encodeURIComponent(cap)}`)
      .then((status) => {
        if (live) setPhase({ kind: "ready", status });
      })
      .catch(() => {
        // No detail leak: a 401 (bad/expired cap) and any other fault ALL render the same clean unavailable.
        if (live) setPhase({ kind: "unavailable" });
      });
    return () => {
      live = false;
    };
  }, [cap]);

  if (phase.kind === "unavailable") return <Unavailable />;
  if (phase.kind === "loading") {
    return (
      <main style={{ position: "fixed", inset: 0, background: "var(--field)", display: "flex", alignItems: "center", padding: 32 }}>
        <Mono size={11} color="var(--signal-55)">
          LOADING STATUS…
        </Mono>
      </main>
    );
  }

  const { state, position, eta } = phase.status;
  return (
    <main style={{ position: "fixed", inset: 0, background: "var(--field)", overflow: "hidden" }}>
      <MapCanvas tileUrl={DEMO_TILE_URL} glyphsUrl={DEMO_GLYPHS_URL} fleet={EMPTY_FLEET} onSelect={() => {}} mapboxToken={MAPBOX_TOKEN} />

      <section style={{ position: "absolute", top: 48, left: 32, maxWidth: "80vw", display: "flex", flexDirection: "column", gap: 12 }}>
        <Mono size={11} color="var(--signal-55)">
          SHUDDL · TRACK
        </Mono>
        {/* underscores → spaces for display only (cosmetic, never fabrication); CSS handles the casing. */}
        <Display size="hero">{state.replace(/_/g, " ")}</Display>
        <div style={{ maxWidth: 360 }}>
          <Divider />
        </div>

        {position !== undefined ? (
          <Mono size={12}>
            <span data-testid="status-position">
              POSITION (GENERALIZED) · {coarseDeg(position.lat_e6)}, {coarseDeg(position.lon_e6)}
            </span>
          </Mono>
        ) : (
          <Mono size={12} color="var(--signal-55)">
            POSITION NOT YET REPORTED
          </Mono>
        )}
        <Mono size={11} color="var(--signal-55)">
          POSITION GENERALIZED TO CITY — NOT AN EXACT LOCATION
        </Mono>

        {/* eta: rendered ONLY when the server sends a real one. It omits eta today ⇒ nothing here, never a fake. */}
        {typeof eta === "number" ? (
          <Mono size={12}>
            <span data-testid="status-eta">ETA · {new Date(eta).toISOString()}</span>
          </Mono>
        ) : null}
      </section>
    </main>
  );
}

// The uniform, clean unavailable screen — a bad/expired/missing cap. It leaks NOTHING (no shipment id, no
// tenant, no "does not exist"): the same posture as the server's uniform 401.
function Unavailable(): React.JSX.Element {
  return (
    <main
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--field)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 16,
        padding: 32,
        maxWidth: 640,
      }}
    >
      <Mono size={11} color="var(--signal-55)">
        SHUDDL · TRACK
      </Mono>
      <Display size="section">STATUS UNAVAILABLE</Display>
      <Mono size={12} color="var(--signal-deep)">
        This tracking link is invalid or has expired. Ask the sender for a fresh link.
      </Mono>
    </main>
  );
}
