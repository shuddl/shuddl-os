import { describe, expect, it } from "vitest";
import { ZoneTariff, FloorsConfig, FscConfig, AccessorialSchedule } from "@shuddl/contracts";
import { roundHalfUp, sweepGrid } from "../src/index.js";
import type { TenantRatingConfig, PricedQuote, SweepCell } from "../src/index.js";

// REQ-027 — the in-repo monotonic price sweep: the stand-in for the audited engine's real 504-quote
// monotonic sweep (which runs against tenant-0's tariff in the engagement workspace and vendors into Task 11's
// parity harness). This proves the SAME invariant against tariffs WE control, as a PROPERTY test (not a fixture
// replay): the deficit-weight engine's price is MONOTONIC — a heavier shipment never costs less than a lighter
// one (weight-monotone), and a farther zone never costs less than a nearer one (distance-monotone).
//
// Fixtures are inline, SCHEMA-VALID, and deliberately NOT SEED-1 (cross-package import of the seed is awkward
// under tsc; a representative tariff proves the property universally, since deficit-weight guarantees
// monotonicity for ANY valid ascending-break tariff). The grid echoes the 504-sweep: 7 zones × 72 weights = 504
// PRICED cells.

// ── shared, generic configs (floors / fsc / accessorials do not affect monotonicity; they ride on freight) ──

// floors: contribution 85% ≤ full 92% ≤ target 98% of the cost basis (freight). Ordered bps ⇒ ordered ladder.
const floors = FloorsConfig.parse({
  kind: "floors",
  id: "fl-sweep",
  version: "2026.07",
  contribution_bps: 8_500,
  full_cost_bps: 9_200,
  target_or_bps: 9_800,
});

// fsc 25% — a fixed fraction of freight, so fsc is monotonic in freight and preserves the property.
const fsc = FscConfig.parse({ kind: "fsc", id: "fsc-sweep", version: "2026.07", pct_bps: 2_500 });

// one accessorial; a per-shipment fixed charge is a CONSTANT offset across cells ⇒ cannot break monotonicity.
const accessorials = AccessorialSchedule.parse({
  kind: "accessorials",
  id: "acc-sweep",
  version: "2026.07",
  items: { liftgate: 2_500 },
});

const dims = { l_in: 48, w_in: 40, h_in: 48, pieces: 1 };
const ORIGIN = "97201";

// ── the representative 7-zone tariff (NEAR→FAR), rates scaled up per zone so farther is never cheaper ──

// One lane per zone. dest_zip longest-prefix-matches its 3-digit zone prefix (e.g. "10001" → "100" → Z1).
const LANES = [
  { prefix: "100", zone: "Z1", dest: "10001" },
  { prefix: "200", zone: "Z2", dest: "20002" },
  { prefix: "300", zone: "Z3", dest: "30003" },
  { prefix: "400", zone: "Z4", dest: "40004" },
  { prefix: "500", zone: "Z5", dest: "50005" },
  { prefix: "600", zone: "Z6", dest: "60006" },
  { prefix: "700", zone: "Z7", dest: "70007" },
] as const;

// Base break ladder (cwt DESCENDING as weight rises ⇒ deficit-weight rating is genuinely active), and a base
// min charge. Zone k (0-based) scales EVERY cwt and the min charge by (100 + 20k)/100: Z1 = ×1.00 … Z7 = ×2.20.
// Because each break's cwt and the min charge are non-decreasing across zones, freight is non-decreasing across
// zones at every weight (min of pointwise-non-decreasing terms, then max with a non-decreasing floor) — that is
// the distance-monotonicity this test asserts. All base cwt values keep the scaled result integer.
const BASE_BREAKS = [
  { min_lb: 0, cwt: 4_000 }, // $40/cwt
  { min_lb: 500, cwt: 3_000 }, // $30/cwt
  { min_lb: 2_000, cwt: 2_000 }, // $20/cwt
  { min_lb: 5_000, cwt: 1_500 }, // $15/cwt
] as const;
const BASE_MIN_CHARGE = 5_000;

const repTariff = ZoneTariff.parse({
  kind: "zone_tariff",
  id: "zt-sweep",
  version: "2026.07",
  zip_to_zone: Object.fromEntries(LANES.map((l) => [l.prefix, l.zone])),
  rate_groups: LANES.map((l, k) => ({
    id: `grp-${l.zone}`,
    zones: [l.zone],
    breaks: BASE_BREAKS.map((b) => ({ min_lb: b.min_lb, cwt_cents: (b.cwt * (100 + 20 * k)) / 100 })),
    min_charge_cents: (BASE_MIN_CHARGE * (100 + 20 * k)) / 100,
  })),
});

const repConfig: TenantRatingConfig = { zone_tariff: repTariff, floors, fsc, accessorials };

const DEST_ZIPS = LANES.map((l) => l.dest); // NEAR→FAR

// 72 ascending weights spanning 50 … 19,930 lb, straddling every break boundary (500 / 2000 / 5000) so
// monotonicity is exercised ACROSS the breaks where a naive engine would be most tempted to misprice.
const WEIGHTS = Array.from({ length: 72 }, (_, i) => 50 + i * 280);

// The rep-grid sweep options, defined ONCE and reused (incl. the determinism re-runs) so the grid can never
// drift between assertions.
const repOpts = {
  origin_zip: ORIGIN,
  dest_zips: DEST_ZIPS,
  weights_lb: WEIGHTS,
  dims,
  accessorials: ["liftgate"],
} as const;

// ── the TRAP tariff: a steep cwt drop at a break, engineered so NAIVE bracket rating is non-monotonic ──
//
// Two breaks: $1.00/lb below 500 lb, then $0.10/lb at/above 500 lb — a 10× cliff at the break. A NAIVE engine
// (rate the ACTUAL weight at whatever bracket it falls in) charges 499 lb × $1.00 = $499, but 500 lb × $0.10 =
// $50 — the price DROPS $449 as the shipment gets 1 lb heavier. The deficit-weight engine we ship rates the
// 499-lb piece UP to the 500-lb break at the cheap rate (as-rated), so it already charges $50 at 499 lb and
// stays flat/increasing across the cliff. This trap is the centerpiece: it empirically distinguishes the
// as-rated engine from a naive one.
const TRAP_BREAKS = [
  { min_lb: 0, cwt_cents: 10_000 }, // $100/cwt = $1.00/lb (as-rated)
  { min_lb: 500, cwt_cents: 1_000 }, // $10/cwt = $0.10/lb — a STEEP 10× drop at the 500-lb break
] as const;
const TRAP_MIN_CHARGE = 500; // low, so the cliff region is not masked by the min charge

const trapTariff = ZoneTariff.parse({
  kind: "zone_tariff",
  id: "zt-trap",
  version: "2026.07",
  zip_to_zone: { "900": "ZT" },
  rate_groups: [
    {
      id: "grp-trap",
      zones: ["ZT"],
      breaks: TRAP_BREAKS.map((b) => ({ min_lb: b.min_lb, cwt_cents: b.cwt_cents })),
      min_charge_cents: TRAP_MIN_CHARGE,
    },
  ],
});

const trapConfig: TenantRatingConfig = { zone_tariff: trapTariff, floors, fsc, accessorials };

// Weights straddling the 500-lb cliff. 499 → 500 is the trap: naive drops, the engine does not.
const TRAP_WEIGHTS = [
  10, 25, 50, 100, 200, 300, 400, 450, 490, 499, 500, 501, 550, 600, 750, 1_000, 1_500, 2_000, 3_000,
  5_000,
];

// NAIVE (WRONG) bracket rating — the engine we deliberately do NOT ship. It picks the single break the ACTUAL
// weight falls in (last break with min_lb ≤ weight) and charges actual_weight × that cwt, floored at the min
// charge. Used ONLY to prove the trap test would catch such an engine (it is non-monotonic at the cliff).
function naiveBracketFreight(
  breaks: readonly { min_lb: number; cwt_cents: number }[],
  minCharge: number,
  weight: number,
): number {
  let bracket = breaks[0];
  for (const b of breaks) {
    if (weight >= b.min_lb) bracket = b;
  }
  if (bracket === undefined) throw new Error("naiveBracketFreight: empty breaks");
  return Math.max(roundHalfUp(weight * bracket.cwt_cents, 100), minCharge);
}

// The freight line's amount (integer cents) — read from the price breakdown DIRECTLY, not via cost_cents.
// cost_cents happens to equal freight today (costBasis returns freight), but price.ts documents costBasis as
// the future multi-factor cost-surface seam; reading the freight LINE keeps this correct when cost_cents
// diverges. Throw (not `!`) if no freight line — an emitted quote must always carry one.
function freightOf(q: PricedQuote): number {
  const line = q.lines.find((l) => l.kind === "freight");
  if (line === undefined) throw new Error("freightOf: PRICED quote carries no freight line");
  return line.amount_cents;
}

// Safe positional read: throw (never `!` / vacuous undefined) so a bad index fails loud (noUncheckedIndexedAccess).
function at(nums: readonly number[], i: number, label: string): number {
  const v = nums[i];
  if (v === undefined) throw new Error(`${label}: no value at index ${i}`);
  return v;
}

// Assert a numeric sequence is non-decreasing, showing the offending value diff (native matcher) on failure.
function assertNonDecreasing(nums: readonly number[], label: string): void {
  for (let i = 1; i < nums.length; i++) {
    const prev = nums[i - 1];
    const cur = nums[i];
    // A missing entry would make the pair a vacuous pass — throw rather than skip (noUncheckedIndexedAccess).
    if (prev === undefined || cur === undefined) {
      throw new Error(`${label}: missing value at index ${prev === undefined ? i - 1 : i}`);
    }
    expect(cur, `${label}: non-monotonic at index ${i}`).toBeGreaterThanOrEqual(prev);
  }
}

// Group a sweep's cells by dest_zip, preserving weight order (each dest sees WEIGHTS in the same order).
function sellsByDest(cells: readonly SweepCell[]): Map<string, number[]> {
  const byDest = new Map<string, number[]>();
  for (const c of cells) {
    const arr = byDest.get(c.dest_zip) ?? [];
    arr.push(c.quote.sell_cents);
    byDest.set(c.dest_zip, arr);
  }
  return byDest;
}

describe("monotonic price sweep — the representative 7-zone grid (504-invariant stand-in, REQ-027)", () => {
  const cells = sweepGrid(repConfig, repOpts);

  it("prices a full 7×72 = 504-cell grid, every cell PRICED", () => {
    expect(cells).toHaveLength(DEST_ZIPS.length * WEIGHTS.length);
    expect(cells).toHaveLength(504);
    for (const c of cells) expect(c.quote.status).toBe("PRICED");
  });

  // (1) WEIGHT-MONOTONIC — the key engine invariant. For each dest, sell is non-decreasing across the whole
  // ascending weight range (the deficit-weight guarantee; the trap tariff below proves it at a cliff).
  it("is weight-monotonic: for each dest_zip, sell_cents is non-decreasing across ascending weight", () => {
    const byDest = sellsByDest(cells);
    for (const dest of DEST_ZIPS) {
      const sells = byDest.get(dest);
      expect(sells).toBeDefined();
      if (sells === undefined) continue;
      expect(sells).toHaveLength(WEIGHTS.length);
      assertNonDecreasing(sells, `weight-monotone @ dest ${dest}`);
    }
  });

  // (2) DISTANCE-MONOTONIC. For each weight, order cells NEAR→FAR (DEST_ZIPS order) and assert sell RISES.
  //
  // §1638 — THIS ASSERTION WAS `>=` AND A ZONE-BLIND ENGINE PASSED IT. `equal` satisfies non-decreasing, so
  // replacing the zone lookup with `tariff.rate_groups[0]` — every lane in the country priced identically —
  // left this file **11/11 GREEN**, the whole rater package at 170/171 (the one RED was an UNKNOWN reason
  // code, not a price), and the api worker at **882/882**. That matters more here than in an ordinary test:
  // the audited 504-quote sweep is one of the five BLOCKED private fixtures, and CLAUDE.md names THIS file as
  // the in-repo substitute proving *"the same weight- and distance-monotonicity"*. Half of that claim was
  // being carried by an assertion a flat function satisfies.
  //
  // STRICT is the correct strength BECAUSE OF THIS TARIFF, not in general: zone k scales every cwt AND the min
  // charge by (100 + 20k)/100, so each zone is 20% dearer than the last at every weight — the fixture is
  // strictly increasing by construction (see BASE_BREAKS above), and an assertion weaker than the fixture is
  // the gap. A tariff with two equally-priced zones would need `>=`; this one does not have any.
  it("is distance-monotonic: for each weight, sell_cents STRICTLY rises NEAR→FAR (a flat engine must fail)", () => {
    const byDest = sellsByDest(cells);
    for (let j = 0; j < WEIGHTS.length; j++) {
      const acrossZones = DEST_ZIPS.map((dest) => {
        const sells = byDest.get(dest);
        if (sells === undefined) throw new Error(`missing sweep column for dest ${dest}`);
        const v = sells[j];
        if (v === undefined) throw new Error(`missing cell dest ${dest} weight index ${j}`);
        return v;
      });
      for (let i = 1; i < acrossZones.length; i++) {
        const prev = acrossZones[i - 1];
        const cur = acrossZones[i];
        if (prev === undefined || cur === undefined) throw new Error(`distance sweep hole at zone index ${i}`);
        expect(
          cur,
          `distance-monotone @ weight ${WEIGHTS[j]}: zone ${i} (${DEST_ZIPS[i]}) priced ${cur} vs zone ${i - 1} ` +
            `(${DEST_ZIPS[i - 1]}) at ${prev}. This tariff makes every zone 20% dearer than the last, so EQUAL ` +
            "means the engine did not read the zone at all — the failure `>=` could not see.",
        ).toBeGreaterThan(prev);
      }
    }
  });

  // (3) EVERY CELL IS WELL-FORMED: PRICED, carries all three ordered floors (contribution ≤ full ≤ target),
  // pins ≥ 1 rate_config version (I5), and raises NO anomaly (a legitimate tariff sweep must be anomaly-free —
  // a flag here would be a real REQ-040 finding).
  it("every cell is well-formed: floors ordered, versions pinned (I5), anomaly null (REQ-040)", () => {
    for (const c of cells) {
      const q = c.quote;
      expect(q.status).toBe("PRICED");
      expect(q.floors.contribution).toBeLessThanOrEqual(q.floors.full);
      expect(q.floors.full).toBeLessThanOrEqual(q.floors.target);
      expect(q.versions.rate_config_ids.length).toBeGreaterThanOrEqual(1);
      expect(q.anomaly).toBeNull();
    }
  });

  // (4) DETERMINISM: two runs deep-equal (pure; no Date/random).
  it("is deterministic: two sweepGrid runs deep-equal", () => {
    const a = sweepGrid(repConfig, repOpts);
    const b = sweepGrid(repConfig, repOpts);
    expect(a).toEqual(b);
  });
});

describe("monotonic price sweep — the TRAP tariff proves deficit-weight rating (steep cliff at a break)", () => {
  // No accessorials here (exercises sweepGrid's `accessorials ?? []` branch); freight/sell still ride the cliff.
  const cells = sweepGrid(trapConfig, {
    origin_zip: ORIGIN,
    dest_zips: ["90001"],
    weights_lb: TRAP_WEIGHTS,
    dims,
  });
  const engineFreight = cells.map((c) => freightOf(c.quote)); // the freight LINE — vs naiveBracketFreight
  const engineSell = cells.map((c) => c.quote.sell_cents);
  const naiveFreight = TRAP_WEIGHTS.map((w) => naiveBracketFreight(TRAP_BREAKS, TRAP_MIN_CHARGE, w));

  const i499 = TRAP_WEIGHTS.indexOf(499);
  const i500 = TRAP_WEIGHTS.indexOf(500);

  it("SANITY: a NAIVE bracket engine IS non-monotonic at the 499→500 cliff (so this test can catch one)", () => {
    // naive charges 499 lb × $1.00/lb = 49,900¢, then 500 lb × $0.10/lb = 5,000¢: the price DROPS as the
    // shipment gets heavier. If this ever stops being true, the trap no longer proves anything — fail loudly.
    const naive499 = at(naiveFreight, i499, "naiveFreight@499");
    const naive500 = at(naiveFreight, i500, "naiveFreight@500");
    expect(naive499).toBe(49_900);
    expect(naive500).toBe(5_000);
    expect(naive500).toBeLessThan(naive499); // the cliff: heavier is CHEAPER under naive rating
    // and the naive sequence is non-monotonic SOMEWHERE across the trap weights.
    let naiveHasDescent = false;
    for (let i = 1; i < naiveFreight.length; i++) {
      const prev = naiveFreight[i - 1];
      const cur = naiveFreight[i];
      if (prev !== undefined && cur !== undefined && cur < prev) naiveHasDescent = true;
    }
    expect(naiveHasDescent).toBe(true);
  });

  it("the deficit-weight ENGINE is monotonic across the SAME cliff (freight non-decreasing)", () => {
    // The engine rates 499 lb UP to the 500-lb break at $0.10/lb ⇒ 5,000¢, matching the 500-lb charge, so there
    // is no drop. Contrast with naive above: 5,000 (not 49,900) at 499 lb.
    const engine499 = at(engineFreight, i499, "engineFreight@499");
    const engine500 = at(engineFreight, i500, "engineFreight@500");
    expect(engine499).toBe(5_000);
    expect(engine500).toBe(5_000);
    expect(engine500).toBeGreaterThanOrEqual(engine499);
    assertNonDecreasing(engineFreight, "trap freight (engine)");
  });

  it("the engine's composed SELL is also weight-monotonic across the cliff", () => {
    assertNonDecreasing(engineSell, "trap sell (engine)");
  });

  it("every trap cell is well-formed (PRICED, floors ordered, versions pinned, anomaly null)", () => {
    for (const c of cells) {
      const q = c.quote;
      expect(q.status).toBe("PRICED");
      expect(q.floors.contribution).toBeLessThanOrEqual(q.floors.full);
      expect(q.floors.full).toBeLessThanOrEqual(q.floors.target);
      expect(q.versions.rate_config_ids.length).toBeGreaterThanOrEqual(1);
      expect(q.anomaly).toBeNull();
    }
  });
});

describe("sweepGrid — a mis-specified grid FAILS LOUD (never a silent monotonicity hole)", () => {
  it("throws naming the cell when a lane is unserved (UNKNOWN must not be silently skipped)", () => {
    expect(() =>
      sweepGrid(repConfig, {
        origin_zip: ORIGIN,
        dest_zips: ["99999"], // no zone prefix matches ⇒ UNKNOWN/no_zone
        weights_lb: [500],
        dims,
      }),
    ).toThrow(/dest_zip=99999.*UNKNOWN/s);
  });

  it("throws naming the cell when physics are missing (weight 0 ⇒ UNKNOWN/missing_physics)", () => {
    expect(() =>
      sweepGrid(repConfig, {
        origin_zip: ORIGIN,
        dest_zips: [DEST_ZIPS[0]!],
        weights_lb: [0],
        dims,
      }),
    ).toThrow(/weight_lb=0.*UNKNOWN/s);
  });
});
