import type {
  ZoneTariff,
  FloorsConfig,
  FscConfig,
  AccessorialSchedule,
  ClassAdapter,
  JsonObject,
} from "@shuddl/contracts";
import { priceFreight } from "./engine.js";
import { compose } from "./compose.js";
import type { PriceLine } from "./compose.js";
import { computeFloors } from "./floors.js";
import type { Floors } from "./floors.js";
import { detectAnomaly } from "./anomaly.js";
import type { AnomalyFlag } from "./anomaly.js";
import type { FreightUnknown } from "./types.js";

// REQ-027 / I5 — the unified rating entry. PURE and DETERMINISTIC (no LLM/I/O/Date/random): it ties the
// freight core (priceFreight) → the composer (compose) → the floors (computeFloors) into ONE priced quote
// that carries its three floors AND pins every rate_config version it priced against. No approval-matrix
// logic, no interline split, no class adapter — those are later WP-04 tasks. An UNKNOWN freight result
// passes straight through: no floors on air, no versions on air.

// A rate request: measured physics (same fields priceFreight consumes) plus the requested accessorial
// codes. Structurally a ShipmentPhysics with an extra `accessorials` field, so it is accepted by
// priceFreight unchanged.
export interface RateRequest {
  origin_zip: string;
  dest_zip: string;
  weight_lb?: number;
  dims?: { l_in: number; w_in: number; h_in: number; pieces: number } | null;
  accessorials?: readonly string[]; // requested accessorial codes
}

// The tenant's SEED-1 rating_config bundle. class_adapter is carried for shape completeness but is NOT
// used yet (Task 9) — so it is NEVER pinned into versions below.
export interface TenantRatingConfig {
  zone_tariff: ZoneTariff;
  floors: FloorsConfig;
  fsc: FscConfig;
  accessorials: AccessorialSchedule;
  class_adapter?: ClassAdapter;
}

// Fully readonly: this object becomes a co-signed, append-only quote.priced event (contracts
// QuotePricedPayload) — nothing in it may be mutated after priceShipment returns it, matching compose's
// readonly breakdown. basis is typed as the contracts JsonObject so every value is JSON-serializable
// (no Date/bigint/undefined) — a bad future edit fails HERE, not at Task 10's Zod parse of the payload.
export interface PricedQuote {
  readonly status: "PRICED";
  readonly sell_cents: number;
  readonly lines: readonly PriceLine[];
  readonly floors: Floors;
  readonly cost_cents: number; // the cost basis the floors were computed from
  readonly versions: { readonly rate_config_ids: readonly string[] }; // ALL configs used, min 1 (I5)
  readonly basis: JsonObject; // audit trace, JSON-serializable by construction
  // REQ-040 (permanent) — the anomaly safety net over the quote's OWN output. null on a sane price; a flag
  // on a price that shouldn't exist ($222,084 / 35 lb). Computed+carried here; raising exception.raised on a
  // non-null flag is the /rate service (Task 10), not the engine.
  readonly anomaly: AnomalyFlag | null;
}

// Reuse the Task-3 UNKNOWN union unchanged — an UNKNOWN never grows floors or versions.
export type QuoteResult = PricedQuote | FreightUnknown;

// A config is version-pinned as `id@version`; every rate_config carries both (contracts guarantees min-1
// non-empty strings). Pinning the pair (not just the id) is what makes a quote reproducible under a later
// config revision.
function pin(c: { id: string; version: string }): string {
  return `${c.id}@${c.version}`;
}

// The cost-proxy seam. This WP uses the linehaul freight as the cost basis the floors are configured
// fractions of. The real multi-factor cost surface (stops / touches / cube-miles / dwell / density —
// doc 01 Rater) is a tenant-0/engagement input and is OUT OF SCOPE here; when it lands, THIS is the single
// insertion point (it will read the wider request + config, hence the second parameter). Named so a future
// cost surface has one greppable home.
function costBasis(freight: { freight_cents: number }, _config: TenantRatingConfig): number {
  return freight.freight_cents;
}

export function priceShipment(request: RateRequest, config: TenantRatingConfig): QuoteResult {
  // 1. Freight core. An UNKNOWN (missing physics / unserved lane) passes straight through — no floors on
  //    an UNKNOWN, no price on air (REQ-004).
  const freight = priceFreight(request, config.zone_tariff);
  if (freight.status === "UNKNOWN") {
    return freight;
  }

  // 2. Compose freight + fsc + accessorials into ordered price lines + the list sell.
  const composed = compose(
    freight.freight_cents,
    request.accessorials ?? [],
    config.fsc,
    config.accessorials,
  );

  // 3. Cost basis — the linehaul-freight cost proxy (see costBasis; the future multi-factor surface plugs
  //    in there). The floors are configured fractions of this basis.
  const cost_cents = costBasis(freight, config);

  // 4. Floors — the contribution/full/target ladder over the cost basis (throws if misordered).
  const floors = computeFloors(cost_cents, config.floors);

  // 5. Version pinning (I5): pin EVERY config that influenced this price — tariff, floors, fsc,
  //    accessorials. class_adapter is NOT used (Task 9), so it is NOT pinned. De-duplicated (a Set keeps
  //    first-seen order) in a deterministic config order; always ≥ 1 (zone_tariff is always present).
  const rate_config_ids = [
    ...new Set(
      [config.zone_tariff, config.floors, config.fsc, config.accessorials].map(pin),
    ),
  ];

  // 6. Audit trace: the freight basis (zone / group / matched prefix / as-rated lb / cwt / min-charge)
  //    plus the cost basis, the floor bps that produced the ladder, and the accessorial codes requested.
  const basis: JsonObject = {
    ...freight.basis,
    cost_cents,
    contribution_bps: config.floors.contribution_bps,
    full_cost_bps: config.floors.full_cost_bps,
    target_or_bps: config.floors.target_or_bps,
    requested_accessorials: [...(request.accessorials ?? [])],
  };

  // 7. Anomaly safety net (REQ-040, permanent). Run detectAnomaly over the quote's OWN output — the composed
  //    sell over the shipment's measured weight — so a price that shouldn't exist ($222,084 / 35 lb) flags AT
  //    pricing, forever. A PRICED freight result guarantees a positive measured weight (priceFreight returns
  //    UNKNOWN otherwise), so request.weight_lb is present here; assert it so the net never silently no-ops on
  //    a broken invariant, and narrow for the type-checker. (Carrying the flag only — the /rate service at
  //    Task 10 turns a non-null flag into an exception.raised event; the engine stays pure.)
  if (request.weight_lb === undefined) {
    throw new Error(
      "priceShipment: PRICED freight without a weight_lb — invariant broken; the REQ-040 anomaly net cannot run",
    );
  }
  const anomaly = detectAnomaly({ sell_cents: composed.sell_cents, weight_lb: request.weight_lb });

  return {
    status: "PRICED",
    sell_cents: composed.sell_cents,
    lines: composed.lines,
    floors,
    cost_cents,
    versions: { rate_config_ids },
    basis,
    anomaly,
  };
}
