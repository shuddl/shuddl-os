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
  return Number(halfUpBig(BigInt(numerator), BigInt(divisor)));
}

// THE half-up rule, in one place, on exact BigInt operands. roundHalfUp and mulDivHalfUp both funnel
// through this so the rounding convention (round-half-UP; see the doc-comment above) can never drift
// between the freight core and the fsc/accessorial composer. Assumes numerator >= 0 and divisor > 0
// (callers validate the number-domain before widening to BigInt); on that domain truncation == floor,
// so `2*r >= d` is the exact half-up decision with no float division anywhere.
function halfUpBig(numerator: bigint, divisor: bigint): bigint {
  const q = numerator / divisor; // truncation == floor here (numerator >= 0, divisor > 0)
  const r = numerator % divisor; // exact remainder, 0 <= r < divisor
  return r * 2n >= divisor ? q + 1n : q;
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * mulDivHalfUp — compute round_half_up((a × b) / divisor) with the product formed in BigInt.
 *
 * The 2^53 guard (WP-04 Task 3): for the fsc line `freight_cents × pct_bps` can exceed
 * Number.MAX_SAFE_INTEGER for very large freight (Cents allows up to ~10^12; ×10000 bps ≈ 10^16 > 2^53).
 * Computing `a * b` as a JS number would silently lose precision past 2^53 and then mis-round. So the
 * product is taken through BigInt (`BigInt(a) * BigInt(b)`) BEFORE the divide, and rounded with the same
 * exact half-up rule as roundHalfUp. Integer cents in, integer cents out — no float touches the value.
 *
 * Requires a >= 0, b >= 0 (so the product is non-negative and the half-up decision is exact) and
 * divisor > 0, all integers — mirrors roundHalfUp's domain and fails LOUDLY otherwise, never misprices.
 * The RESULT is guarded to be a safe integer: returning a number past 2^53 would itself lose precision,
 * so an out-of-range result throws rather than silently returning a lie. (Legitimate fsc is ~10^12,
 * far inside the safe range; the guard only trips on absurd inputs.)
 */
export function mulDivHalfUp(a: number, b: number, divisor: number): number {
  if (!Number.isInteger(a) || !Number.isInteger(b) || !Number.isInteger(divisor)) {
    throw new Error(`mulDivHalfUp: a, b and divisor must be integers (got ${a}, ${b}, ${divisor})`);
  }
  if (a < 0 || b < 0 || divisor <= 0) {
    throw new Error(`mulDivHalfUp: expects a >= 0, b >= 0 and divisor > 0 (got ${a}, ${b}, ${divisor})`);
  }
  const product = BigInt(a) * BigInt(b); // formed in BigInt: a×b may exceed 2^53 — a JS-number product would lose precision
  const result = halfUpBig(product, BigInt(divisor));
  if (result > MAX_SAFE) {
    throw new Error(
      `mulDivHalfUp: result ${result} exceeds Number.MAX_SAFE_INTEGER — returning it as a JS number would silently lose precision`,
    );
  }
  return Number(result);
}
