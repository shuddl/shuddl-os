// The freight engine's input/output surface. REQ-004 ("No price on air"): the engine consumes
// MEASURED physics and a parsed tariff and returns either a fully-explained PRICED result or an
// UNKNOWN with a machine-readable reason — never a number derived from missing data.
// All four declarations use `type` for consistency (FreightResult is a union, which must be a type).

export type ShipmentPhysics = {
  origin_zip: string; // carrier-side origin; SEED-1 zoning is dest-based, so origin does not affect the zone match
  dest_zip: string;
  weight_lb?: number; // integer pounds; absent ⇒ UNKNOWN
  dims?: { l_in: number; w_in: number; h_in: number; pieces: number } | null; // absent/null ⇒ UNKNOWN
};

export type FreightUnknown = {
  status: "UNKNOWN";
  reason: "missing_physics" | "no_zone" | "no_rate_group";
};

export type FreightPriced = {
  status: "PRICED";
  freight_cents: number; // integer cents
  basis: {
    zone: string;
    rate_group_id: string;
    matched_zip_prefix: string; // the zip_to_zone key that won longest-prefix match on dest_zip
    as_rated_lb: number; // the weight actually rated (deficit-weight may rate up)
    applied_cwt_cents: number; // the break rate that produced the winning charge
    min_charge_applied: boolean;
  };
};

export type FreightResult = FreightPriced | FreightUnknown;
