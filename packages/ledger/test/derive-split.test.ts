import { describe, expect, it } from "vitest";
import type { Cents } from "@shuddl/contracts";
import { deriveSplitFromLegs, type CustodyLeg } from "../src/money/derive-split.js";
import { allocateCents, apportion } from "../src/money/split.js";
import { projectMoneyLines } from "../src/projection/money.js";
import { mkEvent } from "./helpers.js";
import statementText from "../../../fixtures/interline/partner-statement.json?raw";

// REQ-019 — interline/cartage splits COMPUTED FROM THE CUSTODY LEGS, never a pre-supplied allocation.
// deriveSplitFromLegs groups the recorded custody legs by their executing party, treats each leg's
// recorded split_bps as that segment's relative revenue WEIGHT, and apportions the whole 10000-bps pie
// across the executing carriers via the Hamilton largest-remainder in money/split.ts (Σ === 10000, zero
// remainder loss). The gross is then apportioned penny-exact by the SAME allocateCents the interline_split
// projection uses — so the derivation and the money_lines can never disagree (REQ-003/040/112).

// Deterministic PRNG (mulberry32) — no Math.random; tests must be reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const leg = (executor: string, split_bps: number, kind = "linehaul"): CustodyLeg => ({ executor_party_id: executor, split_bps, kind });

describe("REQ-019 — apportion (Hamilton largest-remainder over arbitrary integer weights)", () => {
  it("apportions a pie proportional to the weights, summing EXACTLY to the total", () => {
    expect(apportion(10_000, [3000, 7000])).toEqual([3000, 7000]); // already-normalized weights → identity
    expect(apportion(10_000, [1, 1, 1])).toEqual([3334, 3333, 3333]); // 10000/3 → largest-remainder gives the odd bps to idx 0
    expect(apportion(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(apportion(10_000, [150, 350])).toEqual([3000, 7000]); // raw mileage weights normalize to the pie
  });

  it("always sums exactly to the total (property, 500 seeded cases of raw weights)", () => {
    const rnd = mulberry32(0x5eed_0019);
    for (let i = 0; i < 500; i++) {
      const total = Math.floor(rnd() * 5_000_000);
      const n = 1 + Math.floor(rnd() * 6);
      const weights = Array.from({ length: n }, () => Math.floor(rnd() * 9_999)); // 0..9998, may be 0
      if (weights.reduce((s, w) => s + w, 0) === 0) weights[0] = 1; // apportion refuses an all-zero weight set
      const parts = apportion(total, weights);
      expect(parts).toHaveLength(n);
      expect(parts.every((p) => Number.isInteger(p) && p >= 0)).toBe(true);
      expect(parts.reduce((s, p) => s + p, 0)).toBe(total);
    }
  });

  it("rejects malformed inputs (integer-only, non-negative, a positive weight required)", () => {
    expect(() => apportion(-1, [1])).toThrow();
    expect(() => apportion(1.5, [1])).toThrow();
    expect(() => apportion(100, [1, -1])).toThrow();
    expect(() => apportion(100, [0, 0])).toThrow(); // cannot apportion by an all-zero weight set
    expect(() => apportion(100, [])).toThrow();
  });
});

describe("REQ-019 — deriveSplitFromLegs (derive the allocation from the custody legs)", () => {
  it("groups legs by executing party and sums each carrier's recorded split_bps into its share", () => {
    // carrier-a executes two legs (2000 + 1000 = 3000 bps); the allocation reflects the SUM.
    const legs = [leg("carrier-a", 2000, "pickup"), leg("carrier-b", 5000), leg("carrier-a", 1000, "delivery"), leg("carrier-c", 2000, "cartage")];
    const split = deriveSplitFromLegs(legs, 1_000_000);
    expect(split.total_cents).toBe(1_000_000);
    // First-seen executor order (carrier-a, carrier-b, carrier-c), the shares summing to exactly 10000 bps.
    expect(split.allocations).toEqual([
      { party_id: "carrier-a", share_bps: 3000 },
      { party_id: "carrier-b", share_bps: 5000 },
      { party_id: "carrier-c", share_bps: 2000 },
    ]);
    expect(split.allocations.reduce((s, a) => s + a.share_bps, 0)).toBe(10_000);
  });

  it("normalizes raw per-leg weights that do NOT sum to 10000 to the pie via largest-remainder", () => {
    // Two mileage-weighted legs (150 + 350 = 500) → 3000 / 7000 bps of the whole movement.
    const split = deriveSplitFromLegs([leg("carrier-a", 150), leg("carrier-b", 350)], 500_000);
    expect(split.allocations).toEqual([
      { party_id: "carrier-a", share_bps: 3000 },
      { party_id: "carrier-b", share_bps: 7000 },
    ]);
  });

  it("is penny-exact end to end: the derived bps + allocateCents reconcile Σ === gross (property, 400 cases)", () => {
    const rnd = mulberry32(0x5eed_0403);
    for (let i = 0; i < 400; i++) {
      const gross = Math.floor(rnd() * 9_000_000);
      const n = 1 + Math.floor(rnd() * 5);
      const parties = Array.from({ length: n }, (_, j) => `carrier-${j}`);
      const legs: CustodyLeg[] = parties.map((p) => leg(p, 1 + Math.floor(rnd() * 8000)));
      const split = deriveSplitFromLegs(legs, gross);
      expect(split.allocations.reduce((s, a) => s + a.share_bps, 0)).toBe(10_000); // shares partition the pie
      const cents = allocateCents(gross as Cents, split.allocations.map((a) => a.share_bps));
      expect(cents.reduce((s, c) => s + c, 0)).toBe(gross); // zero remainder loss
    }
  });

  it("rejects malformed legs (no legs, non-integer/negative split_bps, no revenue anywhere)", () => {
    expect(() => deriveSplitFromLegs([], 100)).toThrow();
    expect(() => deriveSplitFromLegs([leg("a", 1.5)], 100)).toThrow();
    expect(() => deriveSplitFromLegs([leg("a", -1)], 100)).toThrow();
    expect(() => deriveSplitFromLegs([leg("a", 0), leg("b", 0)], 100)).toThrow(); // no revenue weight to split
    expect(() => deriveSplitFromLegs([leg("a", 5000)], 100.5)).toThrow(); // gross must be integer cents
  });
});

describe("REQ-019 — the derived split flows through the EXISTING interline_split projection", () => {
  it("projectMoneyLines(split.computed) posts penny-exact AP interline_split lines that reconcile to the gross", () => {
    const legs = [leg("carrier-a", 2000, "pickup"), leg("carrier-b", 5000), leg("carrier-a", 1000, "delivery"), leg("carrier-c", 2000, "cartage")];
    const split = deriveSplitFromLegs(legs, 999_999); // an odd gross to force the largest-remainder penny
    // The derived split is the split.computed payload verbatim (round-tripped as the JSON the event carries).
    const e = mkEvent("split.computed", { payload: JSON.parse(JSON.stringify(split)) });
    const p = projectMoneyLines(e, { division: "north" });
    // Every posted line is AP interline_split against the frozen 5000-INTERLINE-AP gl_map.
    expect(p.lines.every((l) => l.kind === "interline_split" && l.direction === "ap" && l.gl_map === "5000-INTERLINE-AP")).toBe(true);
    expect(p.lines.map((l) => l.party_id)).toEqual(["carrier-a", "carrier-b", "carrier-c"]);
    // Penny-exact: the AP lines sum EXACTLY to the gross (the Hamilton remainder is absorbed, never lost).
    expect(p.lines.reduce((s, l) => s + l.amount_cents, 0)).toBe(999_999);
  });
});

describe("REQ-019 DoD — the derived split matches the partner statement to the penny", () => {
  interface Statement {
    label: string;
    gross_sell_cents: number;
    legs: { kind: string; executor_party_id: string; split_bps: number }[];
    partner_statement: { party_id: string; share_bps: number; amount_cents: number }[];
  }
  const fixture = JSON.parse(statementText) as { statements: Statement[] };

  for (const st of fixture.statements) {
    it(`${st.label}: derived allocations + cents reconcile to the statement`, () => {
      const split = deriveSplitFromLegs(st.legs, st.gross_sell_cents);
      // The derived bps per carrier match the partner statement's shares.
      expect(split.allocations).toEqual(st.partner_statement.map((r) => ({ party_id: r.party_id, share_bps: r.share_bps })));
      // The projected AP cents match the statement amounts to the penny.
      const cents = allocateCents(st.gross_sell_cents as Cents, split.allocations.map((a) => a.share_bps));
      expect(cents).toEqual(st.partner_statement.map((r) => r.amount_cents));
      expect(cents.reduce((s, c) => s + c, 0)).toBe(st.gross_sell_cents);
    });
  }
});


// §1272 — THE DEGENERATE LEG SET. `derive-split.ts` states the contract in a comment: *"apportion THROWS on an
// all-zero weight set (no revenue to split) — a leg set with no split anywhere is malformed, not a
// free-for-all direct move"*. It is REACHABLE — `split_bps: 0` is a valid non-negative integer and passes the
// per-leg check, so a leg set that is entirely zero reaches `apportion` — and it was exercised by NOTHING:
// deleting the `divisor === 0n` guard left packages/ledger at 719/719 GREEN, and deleting the
// `weights.length === 0` guard left the split suites at 17/17.
//
// What the guards buy is the difference between a NAMED refusal and `RangeError: Division by zero` out of a
// BigInt divide, on the interline money path. Same shape as §1271's tiebreaks: the behaviour only appears on
// boring data — every fixture here splits a real pie between real carriers.
describe("§1272 degenerate weight sets are refused by name, not by a BigInt crash", () => {
  it("a leg set whose split_bps are ALL zero throws the documented error (not a division by zero)", () => {
    const zeroLegs = [leg("carrier-a", 0), leg("carrier-b", 0)];
    expect(() => deriveSplitFromLegs(zeroLegs, 500_000)).toThrow(/all-zero weight set|at least one weight must be positive/);
  });

  it("ONE positive weight among zeros is fine — the guard refuses only the all-zero set", () => {
    // The complement, so the guard cannot be "any zero anywhere is fatal" and still pass.
    const mixed = [leg("carrier-a", 0), leg("carrier-b", 10_000)];
    const split = deriveSplitFromLegs(mixed, 500_000);
    expect(split.allocations.map((a) => a.share_bps)).toEqual([0, 10_000]);
    expect(split.allocations.reduce((s, a) => s + a.share_bps, 0)).toBe(10_000);
  });

  // The empty set is a DIFFERENT fault from the all-zero set, and it is refused ONE LAYER UP: this function
  // has its own `legs.length === 0` guard, so `apportion`'s `weights.length === 0` is never reached from here.
  // Asserting the exact message pins WHICH layer refuses — a loose regex matched all three messages and would
  // have passed whichever guard fired (measured; that was this test's first draft, and it failed clean AND
  // mutated, which is how the mis-attribution surfaced).
  it("an EMPTY leg set is refused HERE, by name — before apportion is ever called", () => {
    expect(() => deriveSplitFromLegs([], 500_000)).toThrow(/at least one custody leg is required/);
  });
});
