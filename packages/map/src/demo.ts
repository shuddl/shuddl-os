import type { FleetItem } from "./useFleet.js";
import type { EntityKind } from "./entities.js";

// The deterministic synthetic fleet — the WP-02 lens shape (`FleetItem`) produced from a seed so the
// perf harness (1,000 entities, REQ-079) AND the five canonical screenshots are byte-stable, with NO
// `Date.now` / `Math.random` anywhere (plan assumption 4: a synthetic source stands in for the live
// Durable-Object fan-out, which is WP-10). Everything CONUS-bounded; state grammar in real
// proportions (calm healthy majority · ~12% at-risk · exactly one exception).

/** mulberry32 — a tiny, fast, deterministic PRNG. Same seed ⇒ the same stream, forever. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A CONUS interior box (kept inside the continental extent so a coarse round stays plausible).
const LNG_MIN = -123;
const LNG_MAX = -69;
const LAT_MIN = 26;
const LAT_MAX = 48;

// Kind mix weighted toward moving trucks (the fleet reads as motion). No `delivered`-heavy skew.
const KINDS: readonly EntityKind[] = ["truck", "truck", "truck", "at_rest", "facility", "delivered"];
// The five sanctioned risk kinds (operational-map §the three-tier grammar).
const RISKS: readonly string[] = ["DWELL", "ETA", "DETENTION", "HOS", "CREDIT"];
// Generic public city codes — geography, never an identity (REQ-167 identity-leak lint).
const CITIES: readonly string[] = [
  "SEA", "PDX", "SLC", "DEN", "PHX", "DFW", "MSP", "ORD",
  "ATL", "MEM", "IND", "CLT", "BOS", "EWR", "JAX", "LAX",
];

/** Round to 5 decimals so serialized fleets are compact and byte-stable. */
function round5(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}

function pick<T>(arr: readonly T[], r: number, fallback: T): T {
  return arr[Math.floor(r * arr.length)] ?? fallback;
}

export interface GenerateFleetOptions {
  /** How many entities to synthesize. */
  count: number;
  /** PRNG seed — a fixed seed ⇒ a byte-identical fleet. */
  seed?: number;
  /** Synthetic party buckets (party-0…party-{n-1}) for portal/party-lens scoping. */
  parties?: number;
  /** Synthetic driver buckets (drv-0…drv-{n-1}) for driver-lens scoping. */
  drivers?: number;
  /** Fraction marked at-risk (default 0.12 ≈ the "~12%" DoD figure). */
  atRiskRate?: number;
}

/**
 * Synthesize a deterministic `FleetItem[]` in the WP-02 lens shape. Exactly one entity is an
 * exception; roughly `atRiskRate` are at-risk (each naming a varied risk kind); the rest are healthy.
 */
export function generateFleet(opts: GenerateFleetOptions): FleetItem[] {
  const { count, seed = 0x5eed, parties = 8, drivers = 40, atRiskRate = 0.12 } = opts;
  const rand = mulberry32(seed);
  // One exception, placed deterministically from the first draw (independent of the per-entity loop).
  const exceptionAt = count > 0 ? Math.floor(rand() * count) : -1;
  const items: FleetItem[] = [];
  for (let i = 0; i < count; i++) {
    const lng = round5(LNG_MIN + rand() * (LNG_MAX - LNG_MIN));
    const lat = round5(LAT_MIN + rand() * (LAT_MAX - LAT_MIN));
    const bearing = Math.floor(rand() * 360);
    const kind = pick(KINDS, rand(), "truck");
    const from = pick(CITIES, rand(), "SEA");
    const to = pick(CITIES, rand(), "LAX");
    const riskRoll = rand();
    const riskPick = pick(RISKS, rand(), "DWELL"); // drawn every iteration to keep the stream stable
    const id = `shp-${(i + 1).toString().padStart(4, "0")}`;

    const item: FleetItem = {
      id,
      lng,
      lat,
      bearing,
      kind,
      status: "healthy",
      label: `${from} → ${to}`,
      shipment_id: id,
      party_refs: [`party-${i % parties}`],
      driver_id: `drv-${i % drivers}`,
      out_for_delivery: kind === "delivered",
    };
    if (i === exceptionAt) {
      item.status = "exception";
    } else if (riskRoll < atRiskRate) {
      item.status = "at-risk";
      item.risk = riskPick;
    }
    items.push(item);
  }
  return items;
}

/** The perf seed + fixture. `fleet1k()` is the DoD's 1,000-entity input (REQ-079); the perf harness
 * (`packages/map/perf/fleet-1k.ts`) re-exports it, and `perf.spec.ts` drives the command app with it. */
export const FLEET_1K_SEED = 0x51eed01;
export function fleet1k(): FleetItem[] {
  return generateFleet({ count: 1000, seed: FLEET_1K_SEED, parties: 12, drivers: 80 });
}

/** A calm ~140-entity board for the Command screenshot — whole fleet, one exception, stable. */
export function demoFleet(): FleetItem[] {
  return generateFleet({ count: 140, seed: 0xc0ffee, parties: 8, drivers: 20 });
}

// Demo tile + glyph endpoints (plan assumption 1/2): the greige STYLE and entity grammar are built
// now against a public demo source; self-hosted Protomaps vectors + JetBrains-Mono glyph PBFs on R2
// are a deploy line item. Swap these for the tenant's tile host at deploy. Strings only — no render.
export const DEMO_TILE_URL = "https://demotiles.maplibre.org/tiles/tiles.json";
export const DEMO_GLYPHS_URL = "https://demotiles.maplibre.org/font";
