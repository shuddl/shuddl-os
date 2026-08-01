// reference/travel-matrix.ts — the OSRM-shaped port that every SHUDDL routing call goes through.
//
// WHY THIS EXISTS (the RED this closes): a routing API is a server-side HTTP call an agent CAN make,
// but if the agent calls Mapbox directly it (a) locks SHUDDL to a vendor, (b) leaks the vendor into
// agent logic, and (c) makes it too easy to feed the result into a gate/price/sold-window. This port
// forces the discipline: one interface, drop-in self-host, coordinates-only, minutes are ADVISORY.
//
// Placement: lives in packages/agents/* (or a shared adapter pkg imported only by agents). NEVER in
// packages/ledger (REQ-024 static lint — no external/LLM I/O in the ledger). NEVER imported by any
// client renderer bundle (the MapLibre+Protomaps map is offline-capable and vendor-neutral).
//
// Contract: OSRM /table and /route shapes. Mapbox Matrix (/directions-matrix/v1) and Directions
// (/directions/v5) map cleanly onto these; a self-hosted OSRM or Valhalla is byte-drop-in.

/** Longitude, latitude — the ONLY thing that leaves the tenant. No party/consignee name (REQ-167). */
export type Coord = { readonly lon: number; readonly lat: number };

/** Advisory travel estimate. `source` is stamped so a reader knows this is NOT ledger truth. */
export type TravelEstimate = {
  readonly seconds: number | null; // null = unresolvable lane → treat as UNKNOWN, never a guess
  readonly meters: number | null;
  readonly source: "deterministic" | "mapbox" | "osrm" | "valhalla";
  readonly advisory: true; // a type-level reminder: never a gate/price/sold-window input
};

/** OSRM /table — travel-time matrix. Feasibility + sequencing read from here. */
export interface TravelMatrix {
  table(
    sources: readonly Coord[],
    destinations: readonly Coord[],
    profile?: "driving" | "driving-traffic",
  ): Promise<ReadonlyArray<ReadonlyArray<TravelEstimate>>>;
}

/** OSRM /route — a single A→B leg estimate (live ETA enrichment on Command, online only). */
export interface RoutePlanner {
  route(waypoints: readonly Coord[], profile?: "driving" | "driving-traffic"): Promise<TravelEstimate>;
}

// ── Adapter 1: Deterministic (default; the offline / test / soak fallback) ───────────────────────
// No network. Great-circle distance ÷ an assumed average speed. This is what the DRIVER path and the
// airplane-mode soak (REQ-061) use — a routing call must never sit on that path. Also the CI default
// so no test reaches the network.
export class DeterministicTravelMatrix implements TravelMatrix, RoutePlanner {
  constructor(private readonly avgMetersPerSec = 24 /* ~54 mph line-haul */) {}

  private haversine(a: Coord, b: Coord): number {
    const R = 6_371_000, toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  private est(a: Coord, b: Coord): TravelEstimate {
    const meters = this.haversine(a, b);
    return { meters, seconds: meters / this.avgMetersPerSec, source: "deterministic", advisory: true };
  }
  async table(s: readonly Coord[], d: readonly Coord[]) {
    return s.map((a) => d.map((b) => this.est(a, b)));
  }
  async route(w: readonly Coord[]) {
    let m = 0;
    for (let i = 1; i < w.length; i++) m += this.haversine(w[i - 1]!, w[i]!);
    return { meters: m, seconds: m / this.avgMetersPerSec, source: "deterministic" as const, advisory: true as const };
  }
}

// ── Adapter 2: Mapbox (live; Command-side ETA enrichment ONLY, online) ────────────────────────────
// Server-side HTTP GET. Matrix: durations/distances only, no geometry; ≤25 coords/60rpm (driving),
// ≤10 coords/30rpm (driving-traffic) — docs.mapbox.com/api/navigation/matrix. Token from the Worker
// env/secret, NEVER shipped to a client. Coordinates-only in the URL (REQ-167). NOTE: Mapbox display
// ToS forbids rendering Mapbox-sourced geometry/isochrones on a non-Mapbox renderer — so this adapter
// returns MINUTES for logic only; it must not feed the MapLibre map. For isochrones/catchment,
// self-host Valhalla (Adapter 3) instead.
export class MapboxTravelMatrix implements TravelMatrix {
  constructor(private readonly token: string, private readonly fetchImpl: typeof fetch = fetch) {}
  async table(sources: readonly Coord[], destinations: readonly Coord[], profile: "driving" | "driving-traffic" = "driving") {
    const coords = [...sources, ...destinations].map((c) => `${c.lon},${c.lat}`).join(";");
    const srcIdx = sources.map((_, i) => i).join(";");
    const dstIdx = destinations.map((_, i) => i + sources.length).join(";");
    const url =
      `https://api.mapbox.com/directions-matrix/v1/mapbox/${profile}/${coords}` +
      `?sources=${srcIdx}&destinations=${dstIdx}&annotations=duration,distance&access_token=${this.token}`;
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new Error(`ROUTING_UPSTREAM:${res.status}`); // degrade to Deterministic at the call site
    const body = (await res.json()) as { durations?: (number | null)[][]; distances?: (number | null)[][] };
    return sources.map((_, i) =>
      destinations.map((__, j) => ({
        seconds: body.durations?.[i]?.[j] ?? null, // null lane → UNKNOWN, never fabricated
        meters: body.distances?.[i]?.[j] ?? null,
        source: "mapbox" as const,
        advisory: true as const,
      })),
    );
  }
}

// ── Adapter 3: Self-hosted OSRM/Valhalla (vendor-lock-free; the target for catchment/isochrone) ───
// Same OSRM /table shape → drop-in for MapboxTravelMatrix with zero call-site change. Valhalla adds
// /isochrone, which — unlike Mapbox — has NO display-ToS tie to a renderer, so its polygons MAY be
// drawn on the MapLibre+Protomaps map and it stays offline-capable when co-hosted. Isochrone output is
// still ADVISORY (catchment), never a price input.
export class OsrmTravelMatrix implements TravelMatrix, RoutePlanner {
  constructor(private readonly baseUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}
  async table(sources: readonly Coord[], destinations: readonly Coord[], profile: "driving" | "driving-traffic" = "driving") {
    const all = [...sources, ...destinations];
    const coords = all.map((c) => `${c.lon},${c.lat}`).join(";");
    const srcIdx = sources.map((_, i) => i).join(";");
    const dstIdx = destinations.map((_, i) => i + sources.length).join(";");
    const url = `${this.baseUrl}/table/v1/${profile}/${coords}?sources=${srcIdx}&destinations=${dstIdx}&annotations=duration,distance`;
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new Error(`ROUTING_UPSTREAM:${res.status}`);
    const body = (await res.json()) as { durations?: (number | null)[][]; distances?: (number | null)[][] };
    return sources.map((_, i) =>
      destinations.map((__, j) => ({
        seconds: body.durations?.[i]?.[j] ?? null,
        meters: body.distances?.[i]?.[j] ?? null,
        source: "osrm" as const,
        advisory: true as const,
      })),
    );
  }
  async route(waypoints: readonly Coord[], profile: "driving" | "driving-traffic" = "driving") {
    const coords = waypoints.map((c) => `${c.lon},${c.lat}`).join(";");
    const res = await this.fetchImpl(`${this.baseUrl}/route/v1/${profile}/${coords}?overview=false`);
    if (!res.ok) throw new Error(`ROUTING_UPSTREAM:${res.status}`);
    const body = (await res.json()) as { routes?: { duration: number; distance: number }[] };
    const r = body.routes?.[0];
    return { seconds: r?.duration ?? null, meters: r?.distance ?? null, source: "osrm" as const, advisory: true as const };
  }
}

// ── Feasibility helper — advisory only. NOTE it returns a FLAG, not a gate decision. ──────────────
// A board renders `feasible:false` as a soft warning. The HARD "not double-booked" guarantee is the
// D1 partial-UNIQUE slot index + the capacity gate reading D1 occupancy (WP-08 plan, Decision 1) —
// NOT this estimate. If the routing call fails, degrade to DeterministicTravelMatrix; never block on it.
export async function isAppointmentReachable(
  matrix: TravelMatrix,
  originsInProgress: Coord,
  dock: Coord,
  slaSecondsUntilWindow: number,
): Promise<{ feasible: boolean; etaSeconds: number | null; advisory: true }> {
  const [[est]] = await matrix.table([originsInProgress], [dock]);
  if (est?.seconds == null) return { feasible: true, etaSeconds: null, advisory: true }; // UNKNOWN → don't fabricate a block
  return { feasible: est.seconds <= slaSecondsUntilWindow, etaSeconds: est.seconds, advisory: true };
}
