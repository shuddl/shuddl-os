// REQ-003 (interline share allocation) / REQ-112. Largest-remainder (Hamilton) apportionment.
// INTEGER CENTS ONLY — no float ever touches a monetary value here (CLAUDE.md money law). The
// products use BigInt so a large total*bps cannot silently lose precision past 2^53; the returned
// shares are exact `number` cents. Postcondition: the parts sum to EXACTLY `total`, asserted below.

/**
 * Apportion `total` cents across shares given in basis points (each 0..10000, summing to 10000).
 * The largest-remainder pass runs on the MAGNITUDE `abs(total)`, then each part is negated back to
 * `total`'s sign. This matters because BigInt division truncates toward zero, not toward −∞ — for a
 * negative total, per-share `trunc` and `floor` diverge and every share rounds the wrong way, which
 * the leftover pass cannot recover (REQ-019 regression). Running over the non-negative magnitude
 * makes truncation == floor again, so the result is exact for either sign. `total` may be negative
 * (a reversal/re-allocation); shares (bps) are always non-negative. Postcondition asserted below.
 */
export function allocateCents(total: number, sharesBps: readonly number[]): number[] {
  if (!Number.isInteger(total)) {
    throw new Error(`allocateCents: total must be an integer number of cents (got ${total})`);
  }
  const weights: bigint[] = [];
  for (let i = 0; i < sharesBps.length; i++) {
    const bps = sharesBps[i];
    if (bps === undefined || !Number.isInteger(bps) || bps < 0) {
      throw new Error(`allocateCents: shares must be non-negative integer basis points (got ${String(bps)})`);
    }
    weights.push(BigInt(bps));
  }
  const signed = BigInt(total);
  const negative = signed < 0n;
  const magnitude = negative ? -signed : signed; // ≥ 0, so integer-division == floor
  // The pie is 10000 bps (the divisor); shares that don't total 10000 would fail the postcondition below.
  const base = largestRemainder(magnitude, weights, 10_000n);
  // Negate back to total's sign. `x === 0 ? 0 : -x` avoids a signed-zero (−0) leaking into a cent.
  const parts = negative ? base.map((x) => (x === 0 ? 0 : -x)) : base;
  const sum = parts.reduce((s, x) => s + x, 0);
  if (sum !== total) {
    throw new Error(`allocateCents: postcondition failed — parts sum to ${sum}, expected ${total}`);
  }
  return parts;
}

/**
 * apportion `total` (a non-negative integer) across `weights` (non-negative integers, at least one > 0)
 * proportional to `weight / Σweights`, via the SAME largest-remainder pass allocateCents uses (BigInt,
 * ties by ascending index). Postcondition: the parts sum to EXACTLY `total`, zero remainder loss.
 *
 * REQ-019 — this is how the interline split's per-carrier basis points are DERIVED from the custody legs:
 * apportion the 10000-bps pie across the executing carriers by their recorded per-leg weights. It is the
 * general form of allocateCents (which fixes the divisor at 10000 for a bps-partition and handles a signed
 * total); both share `largestRemainder`, so the derivation and the money projection can never round apart.
 */
export function apportion(total: number, weights: readonly number[]): number[] {
  if (!Number.isInteger(total) || total < 0) {
    throw new Error(`apportion: total must be a non-negative integer (got ${total})`);
  }
  if (weights.length === 0) {
    throw new Error("apportion: at least one weight is required");
  }
  let divisor = 0n;
  const w: bigint[] = [];
  for (let i = 0; i < weights.length; i++) {
    const x = weights[i];
    if (x === undefined || !Number.isInteger(x) || x < 0) {
      throw new Error(`apportion: weights must be non-negative integers (got ${String(x)} at index ${i})`);
    }
    divisor += BigInt(x);
    w.push(BigInt(x));
  }
  if (divisor === 0n) {
    throw new Error("apportion: at least one weight must be positive — cannot apportion by an all-zero weight set");
  }
  const parts = largestRemainder(BigInt(total), w, divisor);
  const sum = parts.reduce((s, x) => s + x, 0);
  if (sum !== total) {
    throw new Error(`apportion: postcondition failed — parts sum to ${sum}, expected ${total}`);
  }
  return parts;
}

/**
 * mulDivHalfUp — round_half_up((a × b) / divisor) with the product formed in BigInt (audit §843).
 *
 * The MIRROR of `packages/rater/src/money.ts`, whose own header says it mirrors THIS file's `allocateCents`.
 * One BigInt money module per package is the established shape here: the rater cannot import the ledger and
 * the ledger must not import the rater (that would invert the layering — the rater is a domain engine ABOVE
 * the ledger, and neither package depends on the other today). The ROUNDING RULE is stated once in each and
 * is the same rule: truncation == floor on the non-negative domain, so `2*r >= d` is the exact half-up
 * decision with no float division anywhere.
 *
 * Added for the storage-cost estimate, which expressed a sub-cent rate as the fractional constant
 * `STORAGE_COST_CENTS_PER_GB_MONTH = 1.5` — the repo's only `*CENTS*` identifier bound to a non-integer.
 * Requires a, b >= 0 and divisor > 0, all integers; fails LOUDLY rather than misrounding.
 */
export function mulDivHalfUp(a: number, b: number, divisor: number): number {
  if (!Number.isInteger(a) || !Number.isInteger(b) || !Number.isInteger(divisor)) {
    throw new Error(`mulDivHalfUp: a, b and divisor must be integers (got ${a}, ${b}, ${divisor})`);
  }
  if (a < 0 || b < 0 || divisor <= 0) {
    throw new Error(`mulDivHalfUp: expects a >= 0, b >= 0 and divisor > 0 (got ${a}, ${b}, ${divisor})`);
  }
  const n = BigInt(a) * BigInt(b);
  const d = BigInt(divisor);
  const q = n / d;
  const r = n % d;
  const result = r * 2n >= d ? q + 1n : q;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`mulDivHalfUp: result ${result} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(result);
}

/**
 * The shared largest-remainder (Hamilton) core, over the NON-NEGATIVE magnitude so BigInt truncation ==
 * floor (see the module note on the negative-total regression). Gives each index floor(magnitude*weight/
 * divisor), then hands the leftover (magnitude − Σfloor, an integer in [0, n)) to the largest remainders,
 * ties broken by ascending index. Callers own their own input validation, sign handling, and postcondition.
 * `divisor` is Σweights for a proportional apportion, or the fixed 10000 pie for a bps-partition.
 */
function largestRemainder(magnitude: bigint, weights: readonly bigint[], divisor: bigint): number[] {
  const n = weights.length;
  const base = new Array<number>(n).fill(0);
  const remainder = new Array<bigint>(n).fill(0n);
  let allocated = 0n;
  for (let i = 0; i < n; i++) {
    const product = magnitude * (weights[i] ?? 0n);
    const floored = product / divisor; // magnitude,weight ≥ 0 ⇒ integer-division == floor
    base[i] = Number(floored);
    remainder[i] = product - floored * divisor;
    allocated += floored;
  }
  const leftover = Number(magnitude - allocated);
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => {
    const ra = remainder[a] ?? 0n;
    const rb = remainder[b] ?? 0n;
    return rb > ra ? 1 : rb < ra ? -1 : a - b; // largest remainder first; ties by ascending index
  });
  for (let k = 0; k < leftover; k++) {
    const idx = order[k];
    if (idx !== undefined) base[idx] = (base[idx] ?? 0) + 1;
  }
  return base;
}
