import { roundHalfUp } from "./money.js";

// REQ-040 / CLAUDE.md Law 5 (PERMANENT) — the $222,084 / 35-lb anomaly safety net. A 35-lb shipment priced
// at $222,084 (~$6,345/lb) is physically absurd and MUST flag at pricing, forever. detectAnomaly is the pure
// DECISION only: given a sell and a weight it returns the flag a nonsensical price carries, or null. It emits
// no event, writes no row, touches no ledger — the /rate service (Task 10) will raise exception.raised from a
// non-null flag. PURE and DETERMINISTIC: no LLM, no I/O, no Date/random. Integer cents throughout.

/**
 * DEFAULT_MAX_CENTS_PER_LB — the safety-net ceiling on price-per-pound, in integer cents.
 *
 * $2,000/lb (200,000¢/lb). This is a deliberately CONSERVATIVE cap: legitimate freight never approaches it,
 * yet the anomaly ($222,084 / 35 lb ≈ $6,345/lb = 634,526¢/lb) blows past it by ~3×. The floor of the safe
 * band is set by real min-charge freight — a 1-lb piece at a ~$115 min charge is ~$115/lb (11,500¢/lb) and
 * is REAL; this cap sits ~17× above that, so min-charge small shipments never false-flag. The band is
 * therefore ~11,500¢/lb (real min-charge) ≪ 200,000¢/lb (cap) ≪ 634,526¢/lb (the anomaly): comfortable
 * clearance on both sides — nothing legitimate reaches it, the $222K case sails past it.
 *
 * FIXED here for WP-04. In production this cap is a tenant-policy input — doc 10 `tenants.policy` anomaly
 * rules / the Watchtower agent — read from config per tenant; it is hard-coded so the net is exercisable
 * end-to-end. Overridable per call via `caps.max_cents_per_lb`.
 */
export const DEFAULT_MAX_CENTS_PER_LB = 200_000;

export interface AnomalyFlag {
  readonly code: "over_per_lb" | "negative";
  readonly detail: string; // human-readable, includes the offending numbers
  readonly per_lb_cents?: number; // present for over_per_lb — the offending price-per-pound (integer cents)
  readonly cap_cents_per_lb?: number; // present for over_per_lb — the cap it exceeded
}

/**
 * detectAnomaly — the price-shouldn't-exist net (REQ-040). Returns a flag, or null when the price is sane.
 *   - sell_cents < 0            → { code: "negative" }: a price cannot be below zero.
 *   - sell_cents / weight > cap → { code: "over_per_lb", per_lb_cents, cap_cents_per_lb }.
 *   - otherwise                 → null.
 *
 * weight_lb must be a positive finite number: per-pound is undefined without it, so a non-positive weight is
 * a CALLER error (a PRICED freight result always carries a positive measured weight) — throw, never divide by
 * zero or silently pass. The per-lb DECISION is made without division (cross-multiply) so no float touches
 * the flag decision.
 *
 * ALL THREE money-ish inputs — sell_cents, weight_lb and the cap — must be INTEGERS, and each throws on a
 * non-integer (§816). "Integer cents in" was stated here from the start but enforced for only two of the
 * three; a fractional sell used to reach a float `Math.round` per-lb. Note the ordering consequence: a
 * fractional NEGATIVE sell now throws rather than returning `{ code: "negative" }`, because a value that is
 * not an integer number of cents is a caller error before it is a price.
 */
export function detectAnomaly(
  input: { sell_cents: number; weight_lb: number },
  caps?: { max_cents_per_lb?: number },
): AnomalyFlag | null {
  const { sell_cents, weight_lb } = input;
  const cap = caps?.max_cents_per_lb ?? DEFAULT_MAX_CENTS_PER_LB;

  // Validate the cap. A NaN cap would make `sell > NaN` always false — the permanent net would SILENTLY
  // NO-OP; a zero/negative cap would false-flag every price. A malformed cap is a CALLER error — throw,
  // matching this module's fail-loud stance for its other inputs.
  //
  // §1678 — this used to read "the tenant-policy seam Task 10 feeds from config", which is FALSE and was
  // never true. **No production caller passes `caps` at all**: the sole call site (`price.ts`, the REQ-040
  // net) omits it, so `DEFAULT_MAX_CENTS_PER_LB` is the operative cap for every tenant. `priceShipment` does
  // receive a `TenantRatingConfig` — the config object is right there — but that type carries no cap field,
  // so there is nothing to thread. This is NOT a gap to close on sight: **no register row scopes a
  // tenant-configurable cap**, so wiring one needs an amendment (CLAUDE.md source-of-truth #1). What the
  // parameter IS: an API affordance exercised by this module's own tests. Kept, because the validation below
  // is what makes a future feeder safe — but a reader must not conclude that a tenant can tune this today.
  if (!Number.isInteger(cap) || cap <= 0) {
    throw new Error(
      `detectAnomaly: max_cents_per_lb must be a positive integer (got ${cap}) — a NaN cap silently disables the net, a non-positive cap flags every price`,
    );
  }
  // INTEGER cents, matching `cap` and `weight_lb` above rather than merely finite (audit §816). This module
  // has always DOCUMENTED "integer cents in / integer cents throughout"; until now it only enforced that for
  // two of its three money-ish inputs, and a fractional sell fell through to a `Math.round(sell / weight)`
  // display path — the one float division on a monetary value left in the repo, against CLAUDE.md's money
  // law. `Number.isInteger` subsumes the old finite check (NaN and ±Infinity are not integers), so the
  // rejected set only GREW: it now also rejects a fractional sell instead of silently float-rounding it.
  if (!Number.isInteger(sell_cents)) {
    throw new Error(
      `detectAnomaly: sell_cents must be an integer number of cents (got ${sell_cents}) — the money law admits no fractional cent, and a float per-lb would not round by the shared half-up rule`,
    );
  }
  // A non-positive / non-integer weight is a CALLER error, not an anomaly: price-per-pound is undefined
  // without a positive weight, and the cross-multiply decision below must stay integer-exact. A PRICED
  // freight result always carries a positive integer measured weight (integer pounds; priceFreight returns
  // UNKNOWN on missing/≤0 weight), so this only trips on misuse — fail loud, never divide by zero or misround.
  if (!Number.isInteger(weight_lb) || weight_lb <= 0) {
    throw new Error(
      `detectAnomaly: weight_lb must be a positive integer (got ${weight_lb}) — per-lb is undefined otherwise`,
    );
  }

  // A negative sell is a price that cannot exist. Flag before any per-lb math (a negative could never be
  // "over per lb" against a positive cap anyway).
  if (sell_cents < 0) {
    return {
      code: "negative",
      detail: `sell_cents ${sell_cents} is negative — a price cannot be below zero`,
    };
  }

  // Per-lb DECISION without division (avoid float where the flag is actually decided): sell/weight > cap
  // ⇔ sell_cents > cap × weight_lb. For integer cents and integer pounds this is exact integer arithmetic,
  // and real-freight products stay far inside 2^53 so the comparison never loses precision. Strictly `>`:
  // a price sitting exactly AT the cap is NOT an anomaly.
  const threshold = cap * weight_lb;
  if (sell_cents > threshold) {
    // The offending per-lb, as an exact half-up integer via the money law's SHARED rounding. Unconditional
    // (audit §816): both operands are now validated integers above, so the old `Number.isInteger(...) && ...`
    // ternary could only ever take its first arm — the `Math.round(sell / weight)` fallback was proved dead
    // (replacing it with a constant left this package 157/157 green) and is deleted rather than left as an
    // invitation. The per-lb is informational; the cross-multiply above is the decision that bites.
    const per_lb_cents = roundHalfUp(sell_cents, weight_lb);
    return {
      code: "over_per_lb",
      detail: `sell ${sell_cents}¢ on ${weight_lb} lb = ${per_lb_cents}¢/lb exceeds the ${cap}¢/lb safety cap`,
      per_lb_cents,
      cap_cents_per_lb: cap,
    };
  }

  return null;
}
