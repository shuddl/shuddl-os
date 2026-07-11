// Shared integer-cents rounding for the rater. INTEGER CENTS ONLY — no float ever touches a monetary
// value here (CLAUDE.md money law). Mirrors the BigInt precedent in packages/ledger/src/money/split.ts
// (allocateCents): the intermediate product is taken through BigInt so a large numerator cannot silently
// lose precision past 2^53, and the returned cent is an exact `number`.

/**
 * roundHalfUp — round the rational `numerator / divisor` to the nearest integer, halves rounding UP
 * (toward +infinity). Round-half-up is the CHOSEN, intentional freight-rounding convention: it is the
 * standard rail-of-thumb for tariff charges AND it preserves monotonicity (a heavier shipment never
 * rounds to a lighter charge), which the deficit-weight sweep property-tests. (This is deliberately NOT
 * banker's/half-even rounding — that would break monotonicity at half-cent boundaries.)
 *
 * Exact integer arithmetic via BigInt: `q = n / d` truncates toward zero and `r = n % d` is the exact
 * remainder, so `2*r >= d` is the half-up decision with no float division anywhere — no fractional cent
 * is ever created or accumulated. Assumes numerator >= 0 and divisor > 0 (all freight inputs are
 * non-negative; truncation == floor on the non-negative domain, so the half-up test is exact). Used by
 * the freight core (rated_lb * cwt_cents / 100) and, from WP-04 Task 4/5, fsc (freight * pct_bps / 10000)
 * and floor arithmetic — the same "round an integer product over a divisor" primitive.
 */
export function roundHalfUp(numerator: number, divisor: number): number {
  if (!Number.isInteger(numerator) || !Number.isInteger(divisor)) {
    throw new Error(`roundHalfUp: numerator and divisor must be integers (got ${numerator}/${divisor})`);
  }
  if (numerator < 0 || divisor <= 0) {
    throw new Error(`roundHalfUp: expects numerator >= 0 and divisor > 0 (got ${numerator}/${divisor})`);
  }
  const n = BigInt(numerator);
  const d = BigInt(divisor);
  const q = n / d; // truncation == floor here (n >= 0, d > 0)
  const r = n % d; // exact remainder, 0 <= r < d
  return Number(r * 2n >= d ? q + 1n : q);
}
