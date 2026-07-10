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
  const n = sharesBps.length;
  const base = new Array<number>(n).fill(0);
  const remainder = new Array<bigint>(n).fill(0n);
  const signed = BigInt(total);
  const negative = signed < 0n;
  const magnitude = negative ? -signed : signed; // ≥ 0, so integer-division == floor
  let allocated = 0n;

  for (let i = 0; i < n; i++) {
    const bps = sharesBps[i];
    if (bps === undefined || !Number.isInteger(bps) || bps < 0) {
      throw new Error(`allocateCents: shares must be non-negative integer basis points (got ${String(bps)})`);
    }
    const product = magnitude * BigInt(bps);
    const floored = product / 10_000n; // magnitude,bps ≥ 0 ⇒ integer-division == floor
    base[i] = Number(floored);
    remainder[i] = product - floored * 10_000n;
    allocated += floored;
  }

  // leftover = magnitude - Σfloor = (Σremainder)/10000, an integer in [0, n) since each remainder < 10000.
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

  // Negate back to total's sign. `x === 0 ? 0 : -x` avoids a signed-zero (−0) leaking into a cent.
  const parts = negative ? base.map((x) => (x === 0 ? 0 : -x)) : base;
  const sum = parts.reduce((s, x) => s + x, 0);
  if (sum !== total) {
    throw new Error(`allocateCents: postcondition failed — parts sum to ${sum}, expected ${total}`);
  }
  return parts;
}
