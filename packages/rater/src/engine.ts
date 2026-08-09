import type { ZoneTariff } from "@shuddl/contracts";
import type { FreightResult, ShipmentPhysics } from "./types.js";
import { mulDivHalfUp } from "./money.js";

// REQ-004 — the freight core. PURE and DETERMINISTIC: no LLM, no I/O, no Date/random. Given measured
// physics + a parsed ZoneTariff it returns PRICED (with a fully-explained basis) or UNKNOWN. Money is
// INTEGER cents throughout; fractional cents are rounded ONCE per break by roundHalfUp and never summed.

const CWT = 100; // one hundredweight = 100 lb; cwt_cents is the rate per 100 lb.

// Longest-prefix zone match: a key "800" matches a zip "80112"; if several keys are prefixes of the zip,
// the LONGEST key wins (most specific lane). Object key order is not relied upon — length decides. EXPORTED
// as the ONE zone-resolution truth: freight pricing resolves the dest zone with it, and REQ-059's
// resolveTransitDays resolves BOTH the origin AND dest zones with the SAME function, so a transit lane keys
// off exactly the zones a price does. The parameter is a plain `zip` (not `destZip`) — the resolver is
// direction-agnostic; the caller decides which endpoint it is resolving.
export function matchZone(
  zip: string,
  zipToZone: ZoneTariff["zip_to_zone"],
): { prefix: string; zone: string } | undefined {
  let best: { prefix: string; zone: string } | undefined;
  for (const [prefix, zone] of Object.entries(zipToZone)) {
    if (!zip.startsWith(prefix)) continue;
    if (best === undefined || prefix.length > best.prefix.length) {
      best = { prefix, zone };
    }
  }
  return best;
}

export function priceFreight(shipment: ShipmentPhysics, tariff: ZoneTariff): FreightResult {
  // 1. UNKNOWN-no-sell: pricing is a projection of MEASURED physics. Weight must be a positive, finite,
  //    WHOLE-pound integer (measured physics is whole pounds) AND dims must be present. Anything missing —
  //    including a fractional weight_lb — ⇒ UNKNOWN, never a price on air, never a crash (REQ-004). This is
  //    the gate that blocks Quote→Booked without weight/dims: a weightless quote returns UNKNOWN (REQ-041).
  //    A non-integer weight would otherwise form a fractional numerator that mulDivHalfUp/roundHalfUp reject.
  const weight = shipment.weight_lb;
  if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0 || !Number.isInteger(weight)) {
    return { status: "UNKNOWN", reason: "missing_physics" };
  }
  //    DIMS ARE A MEASUREMENT, NOT A TOKEN (audit §820). The check here used to be presence alone —
  //    `!== null && !== undefined` — which any object satisfies. Measured: `{}`, all-zeros, negatives and
  //    NaN each returned PRICED. The API-reachable shape is the one that matters: `/v1/rate`, the public
  //    quote and the MCP quote all type l/w/h as `nonnegative()` and pieces as `positive()`, so a caller can
  //    POST one piece measuring 0×0×0 inches and receive a real price — a price on air, over the public API,
  //    against the law this module exists to enforce. The ledger already knew better: the
  //    `freight.measured` event schema requires `SafeInt.min(1)` per dimension, so the PRICING path was
  //    laxer than the LEDGER path for the same physical fact.
  //    The remedy is REQ-004's own — UNKNOWN, not a 400. The boundary schemas deliberately admit 0 to mean
  //    "this dimension was not provided", and turning that into a rejection would break callers; treating it
  //    as unmeasured is exactly what the law prescribes. Guard shape mirrors the weight guard above.
  const dims = shipment.dims;
  if (dims === null || dims === undefined) {
    return { status: "UNKNOWN", reason: "missing_physics" };
  }
  for (const measure of [dims.l_in, dims.w_in, dims.h_in, dims.pieces]) {
    if (typeof measure !== "number" || !Number.isFinite(measure) || !Number.isInteger(measure) || measure <= 0) {
      return { status: "UNKNOWN", reason: "missing_physics" };
    }
  }

  // 2. Zone: longest-prefix match of dest_zip. No match ⇒ we don't serve the lane, still no price on air.
  const matched = matchZone(shipment.dest_zip, tariff.zip_to_zone);
  if (matched === undefined) {
    return { status: "UNKNOWN", reason: "no_zone" };
  }

  // 3. Rate group: the first group whose `zones` includes the matched zone.
  const group = tariff.rate_groups.find((g) => g.zones.includes(matched.zone));
  if (group === undefined) {
    return { status: "UNKNOWN", reason: "no_rate_group" };
  }

  // 4. Deficit-weight (as-rated) freight. A malformed tariff must fail LOUDLY, never misprice: the breaks
  //    must be strictly ascending by min_lb (the algorithm's monotonicity guarantee depends on it).
  for (let i = 1; i < group.breaks.length; i++) {
    const prev = group.breaks[i - 1];
    const cur = group.breaks[i];
    if (prev === undefined || cur === undefined) continue; // unreachable (contiguous), satisfies TS
    if (cur.min_lb <= prev.min_lb) {
      throw new Error(
        `rater: rate group "${group.id}" breaks must be strictly ascending by min_lb (found ${prev.min_lb} then ${cur.min_lb})`,
      );
    }
  }

  // For EVERY break: rate the shipment UP to that break's minimum, charge at that break's cwt rate, and
  // keep the CHEAPEST result. Rating up to a higher break can be cheaper because higher breaks carry
  // lower cwt rates — standard LTL deficit-weight rating. First break achieving the minimum wins (ties
  // resolve to the earlier/lower break, which is deterministic).
  let winner: { charge: number; ratedLb: number; cwtCents: number } | undefined;
  for (const b of group.breaks) {
    const ratedLb = Math.max(weight, b.min_lb);
    // Money law: form the monetary product in BigInt (mulDivHalfUp), NEVER as a JS float. `ratedLb *
    // cwt_cents` can exceed 2^53 for large cwt (Cents allows ~10^12), and a float product would silently
    // lose precision and mis-round by a cent. Same primitive compose/floors use — no float touches the value.
    const charge = mulDivHalfUp(ratedLb, b.cwt_cents, CWT);
    if (winner === undefined || charge < winner.charge) {
      winner = { charge, ratedLb, cwtCents: b.cwt_cents };
    }
  }
  if (winner === undefined) {
    // Unreachable: ZoneTariff schema guarantees breaks.length >= 1. Defensive against a hand-built tariff.
    throw new Error(`rater: rate group "${group.id}" has no weight breaks`);
  }

  // Floor at the group's minimum charge. min_charge_applied is true only when the floor actually raised
  // the price above the computed as-rated charge.
  const minCharge = group.min_charge_cents;
  const asRated = winner.charge;
  const freightCents = Math.max(asRated, minCharge);
  const minChargeApplied = minCharge > asRated; // the floor actually raised the price above as-rated

  return {
    status: "PRICED",
    freight_cents: freightCents,
    basis: {
      zone: matched.zone,
      rate_group_id: group.id,
      matched_zip_prefix: matched.prefix,
      as_rated_lb: winner.ratedLb,
      applied_cwt_cents: winner.cwtCents,
      min_charge_applied: minChargeApplied,
    },
  };
}
