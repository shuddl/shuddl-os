import { describe, expect, it } from "vitest";
import { Bps, Cents } from "@shuddl/contracts";
import { allocateCents, apportion } from "../src/money/split.js";

// Deterministic PRNG (mulberry32). Tests MUST be reproducible — no Math.random anywhere.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("REQ-003 / REQ-112 — allocateCents (Hamilton largest-remainder, integer-only)", () => {
  it("always sums exactly to the total (property, 500 seeded cases)", () => {
    const rnd = mulberry32(0x5eed_1234);
    for (let i = 0; i < 500; i++) {
      const total = (1 + Math.floor(rnd() * 1e7)) as Cents;
      const n = 1 + Math.floor(rnd() * 6); // 1..6 legs
      const cuts = Array.from({ length: n - 1 }, () => Math.floor(rnd() * 10_000)).sort((a, b) => a - b);
      const bps = [...cuts, 10_000].map((c, j, a) => c - (a[j - 1] ?? 0));
      expect(bps.reduce((s, b) => s + b, 0)).toBe(10_000); // shares partition the pie
      const parts = allocateCents(total, bps);
      expect(parts).toHaveLength(n);
      expect(parts.every((p) => Number.isInteger(p))).toBe(true);
      expect(parts.reduce((s, p) => s + p, 0)).toBe(total); // the postcondition, externally observed
    }
  });

  it("100 cents over [3333,3333,3334]bps -> [33,33,34] (classic)", () => {
    expect(allocateCents(100, [3333, 3333, 3334])).toEqual([33, 33, 34]);
  });

  it("1 cent over 3 legs gives the whole cent to the largest remainder, ties by index", () => {
    // [3334,3333,3333]: leg 0 has the largest remainder -> it takes the single cent.
    expect(allocateCents(1, [3334, 3333, 3333])).toEqual([1, 0, 0]);
    // Perfect tie [3333,3334,3333] -> the largest remainder is unique (leg 1).
    expect(allocateCents(1, [3333, 3334, 3333])).toEqual([0, 1, 0]);
    // All-equal remainders [3333,3333,3333]+[1] impossible (sum must be 10000); exact tie on
    // two legs resolves to the lower index.
    expect(allocateCents(2, [2500, 2500, 5000])).toEqual([1, 0, 1]);
  });

  it("single leg takes everything; exact division leaves no remainder", () => {
    expect(allocateCents(999, [10_000])).toEqual([999]);
    expect(allocateCents(100, [5000, 5000])).toEqual([50, 50]);
  });

  // REQ-019 regression: a NEGATIVE total must allocate cleanly (BigInt division truncates toward
  // zero, so floor != trunc for negatives — allocate over abs then negate). No throw, exact sum.
  it("always sums exactly for NEGATIVE totals too (property, 500 seeded cases)", () => {
    const rnd = mulberry32(0x5eed_9999);
    for (let i = 0; i < 500; i++) {
      const total = -(1 + Math.floor(rnd() * 1e7)) as Cents; // negative magnitude
      const n = 1 + Math.floor(rnd() * 6);
      const cuts = Array.from({ length: n - 1 }, () => Math.floor(rnd() * 10_000)).sort((a, b) => a - b);
      const bps = [...cuts, 10_000].map((c, j, a) => c - (a[j - 1] ?? 0));
      expect(bps.reduce((s, b) => s + b, 0)).toBe(10_000);
      const parts = allocateCents(total, bps);
      expect(parts).toHaveLength(n);
      expect(parts.every((p) => Number.isInteger(p))).toBe(true);
      expect(parts.reduce((s, p) => s + p, 0)).toBe(total);
    }
  });

  it("negative literal cases: allocate over abs then negate (the coordinator's three probes + edges)", () => {
    expect(allocateCents(-9999, [5000, 2500, 2500])).toEqual([-4999, -2500, -2500]);
    expect(allocateCents(-100, [3333, 3333, 3334])).toEqual([-33, -33, -34]);
    expect(allocateCents(-1, [3334, 3333, 3333])).toEqual([-1, 0, 0]); // -1c over 3 legs
    expect(allocateCents(0, [3333, 3333, 3334])).toEqual([0, 0, 0]);
    // sums are exact (postcondition holds; no throw)
    expect(allocateCents(-9999, [5000, 2500, 2500]).reduce((s, p) => s + p, 0)).toBe(-9999);
    expect(allocateCents(-100, [3333, 3333, 3334]).reduce((s, p) => s + p, 0)).toBe(-100);
    expect(allocateCents(-1, [3334, 3333, 3333]).reduce((s, p) => s + p, 0)).toBe(-1);
    // sign-mirror invariant: negating the total negates each part exactly.
    expect(allocateCents(-100, [3333, 3333, 3334])).toEqual(allocateCents(100, [3333, 3333, 3334]).map((p) => -p));
  });

  it("rejects negative or non-integer shares (integer-only law)", () => {
    expect(() => allocateCents(100, [10_000, -1])).toThrow();
    expect(() => allocateCents(100.5, [10_000])).toThrow();
  });
});


// §1272 — `apportion`'s own degenerate-input contract, tested at ITS level. `deriveSplitFromLegs` refuses an
// empty leg set with its own guard one layer up, so these two branches of `apportion` are reachable only
// through its exported API — and both were exercised by nothing (removing either left the split suites green).
// The messages differ on purpose: no weights at all is a caller bug; weights that are all zero is malformed
// data. A shared message would make the two indistinguishable in a log.
describe("§1272 apportion refuses degenerate weight sets by name", () => {
  it("NO weights → 'at least one weight is required'", () => {
    expect(() => apportion(100, [])).toThrow(/at least one weight is required/);
  });

  it("ALL-ZERO weights → the all-zero message, never a BigInt division by zero", () => {
    expect(() => apportion(100, [0, 0, 0])).toThrow(/at least one weight must be positive/);
    // The complement: one positive weight is enough, and it takes the whole pie.
    expect(apportion(100, [0, 5, 0])).toEqual([0, 100, 0]);
  });
});

// ── §1762 — THE LEDGER'S MISSING MARGIN TEST, and what measurement said about the BigInt ────────────────
//
// `packages/rater/src/money.ts` has a DERIVED overflow ceiling whose algebra a test recomputes, so raising
// any input fails there rather than in production. The ledger's money core carries the same exposure — its
// widest intermediate is `total × bps` — and had NO equivalent. These tests are that equivalent, plus the
// measurement that says how much room the current bounds leave.
//
// MEASURED (audit §1762), and the measurement says something sharper than "add a ceiling test". The widest
// intermediate at the contract bound is `999_999_999_999 × 10_000 = 9.99999999999e15`, which is PAST 2^53
// (9.007e15). So the products genuinely are unrepresentable as doubles and the BigInt is load-bearing at
// TODAY's domain — not a guard against some future wider one.
//
// And yet: two Hamilton cores — the shipped BigInt one and the "why is this BigInt, they're just cents"
// float rewrite — were run against each other and produced IDENTICAL allocations on
//
//     400,000 random cases across 1..1e12 (the whole range `Cents` admits)      0 disagree
//     40,000,000 ADVERSARIAL cases (one leg's bps driven to 9999, total at the  0 disagree
//       bound — the shape that maximises the single widest product)
//     the first observable disagreements appear ONE DECADE UP: 8 / 50,000 at    (outside the domain)
//       1e13, rising to ~27% by 1e17
//
// The rounding error in a ~1e16 product is at most 1, and `floor(product / 10000)` only moves if that error
// crosses a multiple of the divisor — which never happened in 40.4M trials. **So this is a guard whose
// necessity NO mutation can demonstrate and only the arithmetic can.** Deleting it would look exactly like
// deleting dead weight, and would corrupt money rarely rather than never — the worse of the two failure
// modes, since a rare wrong cent in an interline split is what nobody reconciles.
//
// That is why the test below asserts the ALGEBRA rather than a behaviour, and why the bound is read off the
// schema instead of restated: the argument for the BigInt lives in the relationship between `Cents.max`,
// `Bps.max` and 2^53, and nothing anywhere asserted that relationship.
//
// The bound is DERIVED from the schema rather than restated here: a lockstep comment is a missing test, so
// this reads `Cents` itself and computes the ceiling, and moving money.ts's bound fails these instead of
// silently invalidating the measurement above.
describe("§1762 — the ledger money core's overflow margin, derived from the Cents schema", () => {
  it("finds the contract's own bound by probing the schema, never by restating it", () => {
    expect(Cents.safeParse(CENTS_MAX).success).toBe(true);
    expect(Cents.safeParse(CENTS_MAX + 1).success).toBe(false);
    expect(Cents.safeParse(-CENTS_MAX).success).toBe(true);
  });

  it("the widest intermediate at the bound is ALREADY past 2^53 — the BigInt is required, not defensive", () => {
    // The money core's widest intermediate is magnitude × bps, with bps <= 10000 (Bps's own max).
    expect(Bps.safeParse(10_000).success).toBe(true);
    expect(Bps.safeParse(10_001).success).toBe(false);
    const widest = CENTS_MAX * 10_000; // 9.99999999999e15
    // THE ASSERTION THAT MATTERS, and it points the OPPOSITE way from the one first written here. A double
    // cannot represent this product: 9.99e15 > 9.007e15. So the module header's claim is literally true at
    // the CURRENT bound — the BigInt is load-bearing today, not a guard against some future wider domain.
    expect(widest).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    // Bidirectional: if Cents.max is ever LOWERED under ~9.007e11 the products fit in a double and this
    // whole rationale goes stale, so that change must land here rather than quietly outdating the comment.
    expect(CENTS_MAX).toBeGreaterThan(Math.floor(Number.MAX_SAFE_INTEGER / 10_000));
  });

  it("the BigInt core is still exact ONE DECADE above the bound — so the margin is real, not assumed", () => {
    // A measured witness where a float core misallocates two of four legs by a cent. It is deliberately a
    // value `Cents` REJECTS: the point is that the core survives past the boundary the schema enforces.
    const total = 5_833_107_833_750;
    expect(Cents.safeParse(total).success).toBe(false);
    const bps = [1512, 50, 7199, 1239];
    expect(bps.reduce((s, b) => s + b, 0)).toBe(10_000);
    expect(allocateCents(total as Cents, bps)).toEqual([881_965_904_463, 29_165_539_169, 4_199_254_329_517, 722_722_060_601]);
  });
});

// ── §1762 — the property, exercised at the domain's EDGE rather than five orders below it ───────────────
//
// The 500-case property above draws totals from 1..1e7; `Cents` admits ~1e12. The measurement above found no
// input in that gap that distinguishes the two implementations, so this is coverage of the DOMAIN, not a
// mutation catcher — stated plainly so nobody credits it with more than it does.
//
// The third assertion is the one with teeth. Sum-to-total cannot see a misallocation, because the leftover
// pass redistributes whatever the floors got wrong until the total is met — it is self-healing against
// exactly the fault it appears to catch. The Hamilton guarantee is stronger: every part sits within ONE cent
// of its exact proportional share, checked in BigInt so the check cannot lose the precision it is testing
// for. It is a PROPERTY, never a re-implementation — it does not recompute the allocation, so it cannot
// agree with a wrong answer for the same wrong reason.
const CENTS_MAX = 999_999_999_999;

function assertHamilton(total: number, bps: readonly number[], parts: readonly number[]): void {
  expect(parts.reduce((s, p) => s + p, 0)).toBe(total);
  expect(parts.every((p) => Number.isSafeInteger(p))).toBe(true);
  const t = BigInt(total < 0 ? -total : total);
  for (let i = 0; i < parts.length; i++) {
    const part = BigInt(parts[i] ?? 0);
    const mag = part < 0n ? -part : part;
    const drift = mag * 10_000n - t * BigInt(bps[i] ?? 0);
    const abs = drift < 0n ? -drift : drift;
    expect(abs < 10_000n).toBe(true);
  }
}

describe("§1762 — allocateCents holds across the FULL Cents domain, both signs", () => {
  it("property, 400 seeded cases drawn across the whole admissible range", () => {
    const rnd = mulberry32(0xed_9e_1762);
    for (let i = 0; i < 400; i++) {
      const magnitude = 1 + Math.floor(rnd() * CENTS_MAX);
      const total = (rnd() < 0.5 ? -magnitude : magnitude) as Cents;
      const n = 1 + Math.floor(rnd() * 6);
      const cuts = Array.from({ length: n - 1 }, () => Math.floor(rnd() * 10_000)).sort((a, b) => a - b);
      const bps = [...cuts, 10_000].map((c, j, a) => c - (a[j - 1] ?? 0));
      expect(bps.reduce((s, b) => s + b, 0)).toBe(10_000);
      assertHamilton(total, bps, allocateCents(total, bps));
    }
  });

  it("the exact extremes of the domain, over shares chosen so every leg carries a remainder", () => {
    const bps = [1429, 1429, 1429, 1429, 1428, 1428, 1428];
    expect(bps.reduce((s, b) => s + b, 0)).toBe(10_000);
    for (const total of [CENTS_MAX, -CENTS_MAX] as Cents[]) {
      assertHamilton(total, bps, allocateCents(total, bps));
    }
  });

  it("apportion is exact when the WEIGHTS carry the scale (the 10000-bps pie over trillion-unit legs)", () => {
    // derive-split apportions the bps pie by recorded leg weights, so here the wide operand is the WEIGHT.
    const weights = [999_999_999_999, 500_000_000_001, 3];
    const parts = apportion(10_000, weights);
    expect(parts.reduce((s, p) => s + p, 0)).toBe(10_000);
    const divisor = weights.reduce((s, w) => s + BigInt(w), 0n);
    for (let i = 0; i < parts.length; i++) {
      const drift = BigInt(parts[i] ?? 0) * divisor - 10_000n * BigInt(weights[i] ?? 0);
      const abs = drift < 0n ? -drift : drift;
      expect(abs < divisor).toBe(true);
    }
  });
});
