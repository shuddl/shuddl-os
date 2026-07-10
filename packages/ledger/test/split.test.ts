import { describe, expect, it } from "vitest";
import type { Cents } from "@shuddl/contracts";
import { allocateCents } from "../src/money/split.js";

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

  it("rejects negative or non-integer shares (integer-only law)", () => {
    expect(() => allocateCents(100, [10_000, -1])).toThrow();
    expect(() => allocateCents(100.5, [10_000])).toThrow();
  });
});
