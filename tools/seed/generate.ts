// REQ-155 / REQ-002: SEED-1 — the deterministic seed tenant for dev/CI/screenshot baselines.
// WP-02 slice: the generator now emits the REAL ledger envelope — stream_id (`s:{shipment_id}`),
// integer epoch-ms `ts`/`recorded_at`, `party_refs` as a real array, payloads that satisfy the
// Task-4 Zod schemas (via `eventFixture`), and a canonical hash chain per shipment via `buildChain`.
//
// PURE + workerd-safe: crypto.subtle only, NO `node:crypto` / `node:fs`. The seed-load test imports
// `generateSeed` INSIDE the pool-workers runtime (where node built-ins are absent), so this module
// must stay free of them. The Node CLI (`pnpm seed`) lives in `generate.cli.ts`.
//
// Determinism: seeded PRNG (`mulberry32`) + a fixed base timestamp + a per-run id counter. NO
// Date.now(), NO Math.random(). Run generateSeed() twice and the datasets are byte-identical.
import { buildChain } from "@shuddl/ledger/chain";
import { sha256Hex } from "@shuddl/ledger/canonical";
import { eventFixture, type EventKind, type JsonValue, type LedgerEvent } from "@shuddl/contracts";

const BASE_TS = Date.UTC(2026, 6, 9, 6, 0, 0); // 2026-07-09T06:00:00Z, fixed forever (epoch ms)

// The seeded carrier that executes every physical stop. It MUST be one of the seeded parties:
// pod/exception/osd/custody accruals write passports.party_id (FK -> parties), so an unseeded
// actor party would abort the whole load batch (see tools/seed/load.ts).
const CARRIER_PARTY = "party-7";

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

const LIFECYCLES: Array<{ status: string; kinds: EventKind[]; count: number }> = [
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

export type SeedParty = { id: string; kind: string; name: string };
// SEED-1's rating_config mirrors doc 13 §02.4 (`rating-config/` = tariffs, zone maps, rate groups,
// accessorial schedules, floors, FSC) toward REQ-165 — but it is SYNTHETIC seed data, not any real
// tenant's rate table. Fields are plain number/string (not the branded Cents/Bps) so these literals
// need no cast; the tests parse each config through its @shuddl/contracts schema to prove validity.
export type SeedRatingConfig = {
  zone_tariff: {
    kind: "zone_tariff";
    id: string;
    version: string;
    zip_to_zone: Record<string, string>;
    rate_groups: Array<{
      id: string;
      zones: string[];
      breaks: Array<{ min_lb: number; cwt_cents: number }>;
      min_charge_cents: number;
    }>;
  };
  floors: { kind: "floors"; id: string; version: string; target_or_bps: number; full_cost_bps: number; contribution_bps: number };
  fsc: { kind: "fsc"; id: string; version: string; pct_bps: number };
  accessorials: { kind: "accessorials"; id: string; version: string; items: Record<string, number> };
  class_adapter: { kind: "class_adapter"; id: string; version: string; class_to_density_pcf: Record<string, number> };
};
export type SeedShipment = {
  id: string;
  division: string;
  refs: { pro: string };
  shipper_party_id: string;
  consignee_party_id: string;
  bill_to_party_id: string;
  commodities: { pieces: number; weight: number };
  status: string;
  created_ts: number;
  events: LedgerEvent[];
};
export type Seed = {
  tenant: { slug: string; name: string; plan: string };
  parties: SeedParty[];
  rate_config: { kind: string; version: number };
  rating_config: SeedRatingConfig;
  shipments: SeedShipment[];
};

// A fixed, hand-authored LTL tariff for SEED-1 — every value is a literal (NO rnd/Date), so it is
// byte-identical on every run. Zones are ranked by distance from the origin (Z1 nearest … Z6 farthest);
// two rate groups price a subset of zones each (near Z1–Z3 cheaper, far Z4–Z6 dearer, so cost rises
// with distance). Within a group, breaks ASCEND by min_lb while cwt_cents DECREASE (standard LTL:
// heavier freight, lower rate per hundredweight). All money is integer cents; all bps are 0..10000.
const RATING_CONFIG: SeedRatingConfig = {
  zone_tariff: {
    kind: "zone_tariff",
    id: "zt-seed1",
    version: "v1",
    // ~40 three-digit ZIP prefixes → zone, banded by distance from the seed origin (PNW).
    zip_to_zone: {
      "970": "Z1", "971": "Z1", "972": "Z1",
      "973": "Z2", "974": "Z2", "975": "Z2", "976": "Z2", "977": "Z2", "978": "Z2", "979": "Z2",
      "980": "Z3", "981": "Z3", "982": "Z3", "983": "Z3", "984": "Z3", "985": "Z3", "988": "Z3", "990": "Z3",
      "836": "Z4", "590": "Z4", "591": "Z4", "597": "Z4", "940": "Z4", "945": "Z4", "958": "Z4",
      "800": "Z5", "801": "Z5", "802": "Z5", "840": "Z5", "841": "Z5", "890": "Z5", "891": "Z5",
      "100": "Z6", "104": "Z6", "300": "Z6", "331": "Z6", "600": "Z6", "606": "Z6", "750": "Z6", "770": "Z6",
    },
    rate_groups: [
      {
        id: "rg-near", // Z1–Z3: shorter haul, lower rates
        zones: ["Z1", "Z2", "Z3"],
        breaks: [
          { min_lb: 0, cwt_cents: 3800 },
          { min_lb: 500, cwt_cents: 3200 },
          { min_lb: 1000, cwt_cents: 2700 },
          { min_lb: 2000, cwt_cents: 2300 },
          { min_lb: 5000, cwt_cents: 1900 },
          { min_lb: 10000, cwt_cents: 1600 },
        ],
        min_charge_cents: 9500,
      },
      {
        id: "rg-far", // Z4–Z6: longer haul, higher rates
        zones: ["Z4", "Z5", "Z6"],
        breaks: [
          { min_lb: 0, cwt_cents: 5200 },
          { min_lb: 500, cwt_cents: 4500 },
          { min_lb: 1000, cwt_cents: 3900 },
          { min_lb: 2000, cwt_cents: 3300 },
          { min_lb: 5000, cwt_cents: 2700 },
          { min_lb: 10000, cwt_cents: 2200 },
        ],
        min_charge_cents: 11500,
      },
    ],
  },
  // OR = operating ratio (cost/revenue). contribution_bps <= full_cost_bps <= target_or_bps.
  floors: { kind: "floors", id: "fl-seed1", version: "v1", target_or_bps: 9800, full_cost_bps: 9200, contribution_bps: 8500 },
  fsc: { kind: "fsc", id: "fsc-seed1", version: "v1", pct_bps: 2400 }, // 24% fuel surcharge
  accessorials: {
    kind: "accessorials",
    id: "acc-seed1",
    version: "v1",
    items: { liftgate: 3500, residential: 2500, detention: 6500, notify: 1200 }, // cents
  },
  // Freight class -> density (lb/ft^3); higher class = lower density. Edge adapter only (REQ-004).
  class_adapter: {
    kind: "class_adapter",
    id: "cls-seed1",
    version: "v1",
    class_to_density_pcf: { "50": 30, "70": 15, "92.5": 10.5, "125": 6 },
  },
};

// Deterministic v4-variant uuid from a per-run counter (matches the ledger test-helper scheme,
// so it satisfies zod's uuid() and never collides within a run). Reset at the top of generateSeed.
function makeUuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

// A deterministic 64-hex evidence hash placeholder (EvidenceRef.hash regex is /^[0-9a-f]{64}$/).
// Seed evidence points at synthetic doc ids; there is no documents FK on events.evidence.
function makeEvidenceHash(n: number): string {
  return n.toString(16).padStart(64, "0");
}

function actorFor(kind: EventKind): { party: string; user?: string; device?: string } {
  if (kind === "pod.signed" || kind === "custody.transferred") {
    return { party: CARRIER_PARTY, user: "seed-driver", device: "seed-device" }; // I4: device present
  }
  if (kind === "dispatch.assigned") return { party: CARRIER_PARTY, user: "seed-driver" };
  return { party: CARRIER_PARTY };
}

// Payloads the projections REQUIRE (booking.created's status-cache throws without the party ids;
// invoice.issued's money projection keys money_lines/invoices off these). Everything else falls
// back to eventFixture's minimal-valid payload for the kind.
function payloadFor(kind: EventKind, sh: { id: string; shipper: string; consignee: string; ts: number }): Record<string, JsonValue> | undefined {
  switch (kind) {
    case "booking.created":
      return {
        division: "main",
        shipper_party_id: sh.shipper,
        consignee_party_id: sh.consignee,
        bill_to_party_id: sh.shipper,
        created_ts: sh.ts,
      };
    case "invoice.issued":
      return {
        invoice_id: `inv-${sh.id}`,
        party_id: sh.shipper,
        division: "main",
        lines: [{ line_no: 1, kind: "freight", amount_cents: 120_000, gl_map: "4000-REV" }],
      };
    case "custody.transferred":
      return { from_party: sh.shipper, to_party: CARRIER_PARTY };
    default:
      return undefined; // use eventFixture's default payload
  }
}

export async function generateSeed(): Promise<Seed> {
  const rnd = mulberry32(1);
  let uuidCounter = 0;
  let evidenceCounter = 0;
  const nextUuid = (): string => makeUuid(++uuidCounter);

  const parties: SeedParty[] = Array.from({ length: 8 }, (_, i) => ({
    id: `party-${i + 1}`,
    kind: i < 6 ? "shipper" : "carrier",
    name: `SEED CUSTOMER ${String(i + 1).padStart(2, "0")}`,
  }));

  const shipments: SeedShipment[] = [];
  let proCounter = 100001;

  for (const lc of LIFECYCLES) {
    for (let n = 0; n < lc.count; n++) {
      const shipmentIndex = shipments.length;
      const id = `shp-${String(shipmentIndex + 1).padStart(3, "0")}`;
      const shipper = parties[Math.floor(rnd() * 6)]?.id ?? "party-1";
      const consignee = parties[Math.floor(rnd() * 6)]?.id ?? "party-2";
      const pieces = 1 + Math.floor(rnd() * 10);
      const weight = 50 + Math.floor(rnd() * 5000);
      const createdTs = BASE_TS + shipmentIndex * 3_600_000;

      // Build the per-shipment events, then hash-chain them (buildChain assigns seq/prev_hash/hash).
      const drafts: LedgerEvent[] = lc.kinds.map((kind, k) => {
        const ts = createdTs + k * 600_000;
        const custom = payloadFor(kind, { id, shipper, consignee, ts });
        const evidence =
          kind === "freight.photographed" || kind === "delivery.evidenced"
            ? [{ doc_id: `doc-${id}-${k}`, hash: makeEvidenceHash(++evidenceCounter) }]
            : [];
        // visibility(internal) / source(native) / confidence(10000) are eventFixture defaults already.
        return eventFixture(kind, {
          id: nextUuid(),
          stream_id: `s:${id}`,
          shipment_id: id,
          ts,
          recorded_at: ts + 500, // server clock >= actor ts (Merkle day bucketing)
          actor: actorFor(kind),
          party_refs: [shipper, consignee],
          evidence,
          ...(custom ? { payload: custom } : {}),
        });
      });
      const events = await buildChain(drafts);

      shipments.push({
        id,
        division: "main",
        refs: { pro: String(proCounter++) },
        shipper_party_id: shipper,
        consignee_party_id: consignee,
        bill_to_party_id: shipper,
        commodities: { pieces, weight },
        status: lc.status,
        created_ts: createdTs,
        events,
      });
    }
  }

  return {
    tenant: { slug: "seed-1", name: "SEED-1", plan: "pro" },
    parties,
    rate_config: { kind: "zone_tariff", version: 1 },
    rating_config: RATING_CONFIG,
    shipments,
  };
}

export async function seedHash(seed: Seed): Promise<string> {
  return sha256Hex(new TextEncoder().encode(JSON.stringify(seed)));
}
