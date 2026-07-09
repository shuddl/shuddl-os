import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

// REQ-155: SEED-1 — deterministic seed tenant for dev/CI/screenshot baselines.
// Seeded PRNG + fixed base timestamp: NO Date.now(), NO Math.random().
const BASE_TS = Date.UTC(2026, 6, 9, 6, 0, 0); // 2026-07-09T06:00:00Z, fixed forever

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LIFECYCLES: Array<{ status: string; kinds: string[]; count: number }> = [
  { status: "QUOTED", kinds: ["quote.requested", "quote.priced", "quote.sent"], count: 3 },
  { status: "BOOKED", kinds: ["quote.requested", "quote.priced", "quote.accepted", "booking.created", "credit.checked"], count: 3 },
  { status: "DISPATCHED", kinds: ["booking.created", "appointment.set", "pickup.scheduled", "dispatch.assigned"], count: 2 },
  { status: "PICKED_UP", kinds: ["dispatch.assigned", "stop.arrived", "freight.counted", "freight.photographed", "custody.transferred", "stop.departed"], count: 3 },
  { status: "IN_TRANSIT", kinds: ["custody.transferred", "stop.departed", "position.updated", "position.updated"], count: 3 },
  { status: "OUT_FOR_DELIVERY", kinds: ["position.updated", "stop.arrived"], count: 2 },
  { status: "DELIVERED", kinds: ["stop.arrived", "pod.signed", "delivery.evidenced"], count: 2 },
  { status: "INVOICED", kinds: ["pod.signed", "delivery.evidenced", "invoice.issued"], count: 1 },
  { status: "EXCEPTION", kinds: ["stop.arrived", "exception.raised", "osd.captured"], count: 1 },
];

export type SeedEvent = {
  id: string;
  shipment_id: string;
  seq: number;
  ts: string;
  actor: { party: string; user: string; device: string | null };
  kind: string;
  payload: Record<string, unknown>;
  evidence: Array<{ doc_id: string; hash: string }>;
  prev_hash: string;
  sig: string;
  visibility: string;
  source: "native";
  confidence: 1;
};
export type SeedShipment = {
  id: string;
  refs: { pro: string };
  shipper: string;
  consignee: string;
  status_cache: string;
  commodities: { pieces: number; weight: number };
  events: SeedEvent[];
};
export type Seed = {
  tenant: { slug: string; name: string; plan: string };
  parties: Array<{ id: string; kind: string; name: string }>;
  rate_config: { kind: string; version: number };
  shipments: SeedShipment[];
};

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function generateSeed(): Seed {
  const rnd = mulberry32(1);
  const parties = Array.from({ length: 8 }, (_, i) => ({
    id: `party-${i + 1}`,
    kind: i < 6 ? "shipper" : "carrier",
    name: `SEED CUSTOMER ${String(i + 1).padStart(2, "0")}`,
  }));
  const shipments: SeedShipment[] = [];
  let proCounter = 100001;
  for (const lc of LIFECYCLES) {
    for (let n = 0; n < lc.count; n++) {
      const id = `shp-${String(shipments.length + 1).padStart(3, "0")}`;
      let prev = "GENESIS";
      const events = lc.kinds.map((kind, seq) => {
        const ts = new Date(BASE_TS + shipments.length * 3_600_000 + seq * 600_000).toISOString();
        const ev: SeedEvent = {
          id: `evt-${id}-${seq}`,
          shipment_id: id,
          seq,
          ts,
          actor: { party: "seed-1", user: "seed-user", device: kind.startsWith("pod") ? "seed-device" : null },
          kind,
          payload: { note: "SEED-1", r: Math.floor(rnd() * 1e6) },
          evidence:
            kind === "freight.photographed" || kind === "delivery.evidenced"
              ? [{ doc_id: `doc-${id}-${seq}`, hash: sha256(`${id}-${seq}`) }]
              : [],
          prev_hash: prev,
          sig: "seed-unsigned",
          visibility: "internal",
          source: "native",
          confidence: 1,
        };
        prev = sha256(JSON.stringify(ev));
        return ev;
      });
      shipments.push({
        id,
        refs: { pro: String(proCounter++) },
        shipper: parties[Math.floor(rnd() * 6)]?.id ?? "party-1",
        consignee: parties[Math.floor(rnd() * 6)]?.id ?? "party-2",
        status_cache: lc.status,
        commodities: { pieces: 1 + Math.floor(rnd() * 10), weight: 50 + Math.floor(rnd() * 5000) },
        events,
      });
    }
  }
  return { tenant: { slug: "seed-1", name: "SEED-1", plan: "pro" }, parties, rate_config: { kind: "zone_tariff", version: 1 }, shipments };
}

export function seedHash(seed: Seed): string {
  return sha256(JSON.stringify(seed));
}

function main(): void {
  const seed = generateSeed();
  mkdirSync("seed", { recursive: true });
  writeFileSync("seed/SEED-1.json", JSON.stringify(seed, null, 2));
  writeFileSync("tools/seed/seed.hash", seedHash(seed) + "\n");
  console.log(`SEED-1 written (${seed.shipments.length} shipments), hash ${seedHash(seed).slice(0, 12)}…`);
}
if (process.argv[1]?.endsWith("generate.ts")) main();
