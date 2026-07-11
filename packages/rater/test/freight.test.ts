import { describe, expect, it } from "vitest";
import { ZoneTariff } from "@shuddl/contracts";
import { priceFreight } from "../src/engine.js";
import { roundHalfUp } from "../src/money.js";
import type { ShipmentPhysics } from "../src/types.js";

// REQ-004 "No price on air": pricing is a projection of MEASURED physics. Missing weight OR dims ⇒
// UNKNOWN, never a number. These are HAND-COMPUTED known-answer tests against a small explicit tariff
// (NOT SEED-1 — Task 3 stays self-contained so every cent is auditable). cwt = per-hundredweight, so
// charge = round(rated_lb * cwt_cents / 100).

// --- the fixture: two zone prefixes over one lane, plus a served-zone-with-no-group, and an unserved zip.
//   zip_to_zone: "801" → ZB, "8011" → ZA (longer prefix wins for 8011x), "970" → ZC (has NO rate group).
//   (zip_to_zone keys are 3–5 digit prefixes per the Task-1 schema.)
//   grp-main breaks: 0 lb @ 5000¢/cwt, 1000 lb @ 2000¢/cwt (higher break, lower cwt ⇒ deficit rating).
//   min_charge 8500¢.
const rawTariff = {
  kind: "zone_tariff" as const,
  id: "zt-test",
  version: "2026.07-test",
  zip_to_zone: { "801": "ZB", "8011": "ZA", "970": "ZC" },
  rate_groups: [
    {
      id: "grp-main",
      zones: ["ZA", "ZB"],
      breaks: [
        { min_lb: 0, cwt_cents: 5000 },
        { min_lb: 1000, cwt_cents: 2000 },
      ],
      min_charge_cents: 8500,
    },
  ],
};

// Prove the fixture is a VALID ZoneTariff (Task 1 schema) — the engine is only ever fed parsed configs.
const tariff = ZoneTariff.parse(rawTariff);

// a valid dims object so the "missing_physics" path is exercised only by the field under test.
const dims = { l_in: 48, w_in: 40, h_in: 48, pieces: 1 };
const okShip = (over: Partial<ShipmentPhysics>): ShipmentPhysics => ({
  origin_zip: "97201",
  dest_zip: "80112",
  weight_lb: 1500,
  dims,
  ...over,
});

describe("priceFreight — UNKNOWN-no-sell (no price on air, REQ-004)", () => {
  it("missing weight_lb ⇒ UNKNOWN/missing_physics", () => {
    const s: ShipmentPhysics = { origin_zip: "97201", dest_zip: "80112", dims };
    expect(priceFreight(s, tariff)).toEqual({ status: "UNKNOWN", reason: "missing_physics" });
  });

  it("weight_lb = 0 (non-positive) ⇒ UNKNOWN/missing_physics", () => {
    expect(priceFreight(okShip({ weight_lb: 0 }), tariff)).toEqual({
      status: "UNKNOWN",
      reason: "missing_physics",
    });
  });

  it("weight_lb < 0 (negative) ⇒ UNKNOWN/missing_physics", () => {
    expect(priceFreight(okShip({ weight_lb: -1 }), tariff)).toEqual({
      status: "UNKNOWN",
      reason: "missing_physics",
    });
  });

  it("weight_lb = NaN ⇒ UNKNOWN/missing_physics (Number.isFinite guard)", () => {
    expect(priceFreight(okShip({ weight_lb: Number.NaN }), tariff)).toEqual({
      status: "UNKNOWN",
      reason: "missing_physics",
    });
  });

  it("weight_lb = Infinity ⇒ UNKNOWN/missing_physics (Number.isFinite guard)", () => {
    expect(priceFreight(okShip({ weight_lb: Number.POSITIVE_INFINITY }), tariff)).toEqual({
      status: "UNKNOWN",
      reason: "missing_physics",
    });
  });

  it("dims = null ⇒ UNKNOWN/missing_physics", () => {
    expect(priceFreight(okShip({ dims: null }), tariff)).toEqual({
      status: "UNKNOWN",
      reason: "missing_physics",
    });
  });

  it("dims = undefined ⇒ UNKNOWN/missing_physics", () => {
    const s: ShipmentPhysics = { origin_zip: "97201", dest_zip: "80112", weight_lb: 1500 };
    expect(priceFreight(s, tariff)).toEqual({ status: "UNKNOWN", reason: "missing_physics" });
  });
});

describe("priceFreight — zone resolution", () => {
  it("dest with no matching prefix ⇒ UNKNOWN/no_zone (we don't price an unserved lane)", () => {
    expect(priceFreight(okShip({ dest_zip: "99999" }), tariff)).toEqual({
      status: "UNKNOWN",
      reason: "no_zone",
    });
  });

  it("served zone with no rate group ⇒ UNKNOWN/no_rate_group", () => {
    // dest 97008 → prefix "970" → zone ZC, which no rate group serves.
    expect(priceFreight(okShip({ dest_zip: "97008" }), tariff)).toEqual({
      status: "UNKNOWN",
      reason: "no_rate_group",
    });
  });

  it("longest-prefix wins: dest 80112 matches both '801' and '8011' ⇒ zone ZA (the longer)", () => {
    const r = priceFreight(okShip({ dest_zip: "80112", weight_lb: 1500 }), tariff);
    expect(r.status).toBe("PRICED");
    if (r.status !== "PRICED") return;
    expect(r.basis.zone).toBe("ZA");
    expect(r.basis.matched_zip_prefix).toBe("8011");
  });
});

describe("priceFreight — deficit-weight (as-rated) freight, hand-computed", () => {
  it("mid-bracket 1500 lb: cheapest break is 1000-lb @2000¢ ⇒ 30000¢", () => {
    // break 0: max(1500,0)=1500 → 1500*5000/100 = 75000¢
    // break 1: max(1500,1000)=1500 → 1500*2000/100 = 30000¢  ← min
    const r = priceFreight(okShip({ dest_zip: "80112", weight_lb: 1500 }), tariff);
    expect(r.status).toBe("PRICED");
    if (r.status !== "PRICED") return;
    expect(r.freight_cents).toBe(30000);
    expect(r.basis).toEqual({
      zone: "ZA",
      rate_group_id: "grp-main",
      matched_zip_prefix: "8011",
      as_rated_lb: 1500,
      applied_cwt_cents: 2000,
      min_charge_applied: false,
    });
  });

  it("deficit-weight PROOF: 900 lb rates UP to the 1000-lb break because it's cheaper", () => {
    // break 0: max(900,0)=900 → 900*5000/100 = 45000¢
    // break 1: max(900,1000)=1000 → 1000*2000/100 = 20000¢  ← min (rate UP to 1000 lb)
    const r = priceFreight(okShip({ dest_zip: "80112", weight_lb: 900 }), tariff);
    expect(r.status).toBe("PRICED");
    if (r.status !== "PRICED") return;
    expect(r.freight_cents).toBe(20000);
    expect(r.basis.as_rated_lb).toBe(1000); // rated UP, not the actual 900
    expect(r.basis.applied_cwt_cents).toBe(2000);
    expect(r.basis.min_charge_applied).toBe(false);
  });

  it("below the min charge: 100 lb ⇒ freight floored at min_charge 8500¢, min_charge_applied true", () => {
    // break 0: max(100,0)=100 → 100*5000/100 = 5000¢ (winning as-rated)
    // break 1: max(100,1000)=1000 → 1000*2000/100 = 20000¢
    // as_rated = 5000 < min_charge 8500 → freight = 8500, floor applied
    const r = priceFreight(okShip({ dest_zip: "80112", weight_lb: 100 }), tariff);
    expect(r.status).toBe("PRICED");
    if (r.status !== "PRICED") return;
    expect(r.freight_cents).toBe(8500);
    expect(r.basis.min_charge_applied).toBe(true);
    expect(r.basis.as_rated_lb).toBe(100); // the winning break was break 0 (actual weight)
    expect(r.basis.applied_cwt_cents).toBe(5000);
  });

  it("local monotonicity: 900 ≤ 1500 ≤ 2000 lb ⇒ freight non-decreasing (20000, 30000, 40000)", () => {
    const at = (w: number) => {
      const r = priceFreight(okShip({ dest_zip: "80112", weight_lb: w }), tariff);
      if (r.status !== "PRICED") throw new Error(`expected PRICED at ${w} lb`);
      return r.freight_cents;
    };
    // 2000 lb: break1 max(2000,1000)=2000 → 2000*2000/100 = 40000¢ (break0 would be 100000¢)
    const [a, b, c] = [at(900), at(1500), at(2000)];
    expect([a, b, c]).toEqual([20000, 30000, 40000]);
    expect(a).toBeLessThanOrEqual(b);
    expect(b).toBeLessThanOrEqual(c);
  });
});

describe("priceFreight — deterministic round-half-up (no fractional-cent accumulation)", () => {
  const roundingTariff = ZoneTariff.parse({
    kind: "zone_tariff" as const,
    id: "zt-round",
    version: "2026.07-round",
    zip_to_zone: { "100": "ZR" },
    rate_groups: [
      {
        id: "grp-round",
        zones: ["ZR"],
        breaks: [{ min_lb: 0, cwt_cents: 4230 }],
        min_charge_cents: 0,
      },
    ],
  });

  it("sub-half rounds DOWN: 101 lb @ 4230¢/cwt = 4272.3¢ ⇒ 4272¢ (pins half-UP, not ceil)", () => {
    // 101 * 4230 / 100 = 4272.3 → fractional 0.3 < 0.5 → rounds DOWN → 4272 (a ceil would give 4273)
    const r = priceFreight(
      { origin_zip: "97201", dest_zip: "10001", weight_lb: 101, dims },
      roundingTariff,
    );
    expect(r.status).toBe("PRICED");
    if (r.status !== "PRICED") return;
    expect(r.freight_cents).toBe(4272);
  });

  it("exact half rounds UP: 105 lb @ 4230¢/cwt = 4441.5¢ ⇒ 4442¢", () => {
    // 105 * 4230 / 100 = 4441.5 → fractional 0.5 → rounds UP → 4442
    const r = priceFreight(
      { origin_zip: "97201", dest_zip: "10001", weight_lb: 105, dims },
      roundingTariff,
    );
    expect(r.status).toBe("PRICED");
    if (r.status !== "PRICED") return;
    expect(r.freight_cents).toBe(4442);
  });
});

describe("roundHalfUp — the shared integer-cents primitive (freight, and WP-04 fsc/floors)", () => {
  it("rounds an exact half UP", () => {
    expect(roundHalfUp(12650, 100)).toBe(127); // 126.50 → 127
    expect(roundHalfUp(1, 2)).toBe(1); // 0.50 → 1
  });

  it("rounds sub-half DOWN (not ceil)", () => {
    expect(roundHalfUp(12630, 100)).toBe(126); // 126.30 → 126
    expect(roundHalfUp(1, 3)).toBe(0); // 0.333… → 0
  });

  it("rounds above-half UP", () => {
    expect(roundHalfUp(12670, 100)).toBe(127); // 126.70 → 127
    expect(roundHalfUp(2, 3)).toBe(1); // 0.666… → 1
  });

  it("leaves an exact integer unchanged", () => {
    expect(roundHalfUp(12600, 100)).toBe(126); // 126.00 → 126
  });

  it("works with the fsc/floors divisor (10000 = basis points), half-up", () => {
    // WP-04 Task 4 shape: fsc = round(freight_cents * pct_bps / 10000). divisor is 10000, not 100.
    expect(roundHalfUp(55505000, 10000)).toBe(5551); // 5550.5 → 5551
    expect(roundHalfUp(55504999, 10000)).toBe(5550); // 5550.4999 → 5550
  });

  it("is exact at the top of the safe-integer range (BigInt, no float division)", () => {
    // MAX_SAFE_INTEGER = 9007199254740991; /2 = 4503599627370495.5 → half-up → 4503599627370496.
    // (The caller must keep the product within the safe range; roundHalfUp does not multiply.)
    expect(roundHalfUp(Number.MAX_SAFE_INTEGER, 2)).toBe(4503599627370496);
  });

  it("rejects non-integer / negative / zero-divisor inputs (fails loudly, never misprices)", () => {
    expect(() => roundHalfUp(1.5, 100)).toThrow();
    expect(() => roundHalfUp(-1, 100)).toThrow();
    expect(() => roundHalfUp(100, 0)).toThrow();
  });
});

describe("priceFreight — malformed tariff fails loudly (never misprices)", () => {
  it("breaks NOT ascending by min_lb ⇒ throws", () => {
    const badTariff = ZoneTariff.parse({
      kind: "zone_tariff" as const,
      id: "zt-bad",
      version: "2026.07-bad",
      zip_to_zone: { "801": "ZA" },
      rate_groups: [
        {
          id: "grp-bad",
          zones: ["ZA"],
          breaks: [
            { min_lb: 1000, cwt_cents: 2000 },
            { min_lb: 0, cwt_cents: 5000 }, // descending — malformed
          ],
          min_charge_cents: 0,
        },
      ],
    });
    expect(() => priceFreight(okShip({ dest_zip: "80112", weight_lb: 500 }), badTariff)).toThrow(
      /ascending/i,
    );
  });
});
