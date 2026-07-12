import { describe, expect, it } from "vitest";
import { ZoneTariff, FloorsConfig, FscConfig, AccessorialSchedule } from "@shuddl/contracts";
import { priceShipment } from "../src/price.js";
import type { RateRequest, TenantRatingConfig, PricedQuote } from "../src/price.js";

// REQ-027 / I5: priceShipment ties freight → compose → floors into one PRICED quote that (a) carries its
// three floors, (b) PINS every rate_config version id it priced against (min 1), and (c) passes an
// UNKNOWN straight through (no floors, no versions — no price on air). Small inline SCHEMA-VALID fixtures
// with KNOWN numbers so every cent is hand-auditable (NOT SEED-1 — that integration is a later task).

// zone tariff: dest 80112 → prefix "801" → zone ZA → grp-main. Two breaks (deficit-weight); min_charge 8500.
const zone_tariff = ZoneTariff.parse({
  kind: "zone_tariff",
  id: "zt-test",
  version: "2026.07",
  zip_to_zone: { "801": "ZA" },
  rate_groups: [
    {
      id: "grp-main",
      zones: ["ZA"],
      breaks: [
        { min_lb: 0, cwt_cents: 5_000 },
        { min_lb: 1_000, cwt_cents: 2_000 },
      ],
      min_charge_cents: 8_500,
    },
  ],
});

// floors: contribution 85% ≤ full 92% ≤ target 98% of the cost basis.
const floors = FloorsConfig.parse({
  kind: "floors",
  id: "fl-test",
  version: "2026.07",
  contribution_bps: 8_500,
  full_cost_bps: 9_200,
  target_or_bps: 9_800,
});

// fsc 25%.
const fsc = FscConfig.parse({ kind: "fsc", id: "fsc-test", version: "2026.07", pct_bps: 2_500 });

const accessorials = AccessorialSchedule.parse({
  kind: "accessorials",
  id: "acc-test",
  version: "2026.07",
  items: { liftgate: 2_500, residential: 4_000 },
});

const config: TenantRatingConfig = { zone_tariff, floors, fsc, accessorials };

const dims = { l_in: 48, w_in: 40, h_in: 48, pieces: 1 };

// A 1500-lb shipment on the served lane. Hand-computed:
//   freight: cheapest break is 1000-lb @2000¢ ⇒ 1500*2000/100 = 30000¢ (cost basis = 30000).
//   fsc:      30000 * 2500 / 10000 = 7500.
//   liftgate: 2500.  sell = 30000 + 7500 + 2500 = 40000.
//   floors on cost 30000: contribution 30000*8500/10000 = 25500; full *9200 = 27600; target *9800 = 29400.
const okRequest: RateRequest = {
  origin_zip: "97201",
  dest_zip: "80112",
  weight_lb: 1_500,
  dims,
  accessorials: ["liftgate"],
};

describe("priceShipment — a full valid request ⇒ PRICED with floors + version pinning (REQ-027/I5)", () => {
  it("assembles freight + fsc + accessorial into the composed sell", () => {
    const r = priceShipment(okRequest, config);
    expect(r.status).toBe("PRICED");
    if (r.status !== "PRICED") return;
    expect(r.sell_cents).toBe(40_000); // 30000 freight + 7500 fsc + 2500 liftgate
    expect(r.cost_cents).toBe(30_000); // cost basis = linehaul freight
    expect(r.lines).toEqual<PricedQuote["lines"]>([
      { kind: "freight", code: "freight", amount_cents: 30_000 },
      { kind: "fsc", code: "fsc", amount_cents: 7_500 },
      { kind: "accessorial", code: "liftgate", amount_cents: 2_500 },
    ]);
  });

  it("carries all THREE floors, hand-computed from the cost basis", () => {
    const r = priceShipment(okRequest, config);
    if (r.status !== "PRICED") throw new Error("expected PRICED");
    expect(r.floors).toEqual({ contribution: 25_500, full: 27_600, target: 29_400 });
    expect(r.floors.contribution).toBeLessThanOrEqual(r.floors.full);
    expect(r.floors.full).toBeLessThanOrEqual(r.floors.target);
  });

  it("PINS every rate_config that influenced the price (min 1) — I5", () => {
    const r = priceShipment(okRequest, config);
    if (r.status !== "PRICED") throw new Error("expected PRICED");
    const ids = r.versions.rate_config_ids;
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(ids).toContain("zt-test@2026.07");
    expect(ids).toContain("fl-test@2026.07");
    expect(ids).toContain("fsc-test@2026.07");
    expect(ids).toContain("acc-test@2026.07");
    expect(ids).toHaveLength(4);
    // class_adapter is NOT used yet ⇒ never pinned.
    expect(ids.some((i) => i.includes("class"))).toBe(false);
    // de-duplicated + deterministic order (config order: tariff, floors, fsc, accessorials).
    expect([...ids]).toEqual([
      "zt-test@2026.07",
      "fl-test@2026.07",
      "fsc-test@2026.07",
      "acc-test@2026.07",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("carries the audit trace in basis (freight trace + cost + floor bps + requested accessorials)", () => {
    const r = priceShipment(okRequest, config);
    if (r.status !== "PRICED") throw new Error("expected PRICED");
    expect(r.basis).toMatchObject({
      zone: "ZA",
      rate_group_id: "grp-main",
      matched_zip_prefix: "801",
      as_rated_lb: 1_500,
      applied_cwt_cents: 2_000,
      min_charge_applied: false,
      cost_cents: 30_000,
      contribution_bps: 8_500,
      full_cost_bps: 9_200,
      target_or_bps: 9_800,
      requested_accessorials: ["liftgate"],
    });
  });

  it("sanity: target floor ≤ sell (floors sit below list sell; cost=freight < freight+fsc+accessorials)", () => {
    const r = priceShipment(okRequest, config);
    if (r.status !== "PRICED") throw new Error("expected PRICED");
    expect(r.floors.target).toBeLessThanOrEqual(r.sell_cents);
  });

  it("is deterministic: same inputs ⇒ deeply-equal quote", () => {
    expect(priceShipment(okRequest, config)).toEqual(priceShipment(okRequest, config));
  });
});

describe("priceShipment — UNKNOWN passes straight through (no price on air)", () => {
  it("missing physics ⇒ the freight UNKNOWN unchanged, with NO floors/versions", () => {
    const bad: RateRequest = { origin_zip: "97201", dest_zip: "80112", accessorials: ["liftgate"] };
    const r = priceShipment(bad, config);
    expect(r).toEqual({ status: "UNKNOWN", reason: "missing_physics" });
    expect("floors" in r).toBe(false);
    expect("versions" in r).toBe(false);
  });

  it("unserved lane ⇒ UNKNOWN/no_zone passes through", () => {
    const r = priceShipment({ ...okRequest, dest_zip: "99999" }, config);
    expect(r).toEqual({ status: "UNKNOWN", reason: "no_zone" });
  });

  it("fractional weight_lb ⇒ UNKNOWN/missing_physics (whole-pound gate; not a throw, not a fractional-pound price)", () => {
    const r = priceShipment({ ...okRequest, weight_lb: 100.5 }, config);
    expect(r).toEqual({ status: "UNKNOWN", reason: "missing_physics" });
  });
});

describe("priceShipment — no accessorials requested still PRICES (freight + fsc)", () => {
  it("omits the accessorial line but still pins all 4 configs", () => {
    // accessorials property OMITTED entirely ⇒ the `?? []` fallback fires.
    const r = priceShipment({ origin_zip: "97201", dest_zip: "80112", weight_lb: 1_500, dims }, config);
    if (r.status !== "PRICED") throw new Error("expected PRICED");
    expect(r.sell_cents).toBe(37_500); // 30000 + 7500
    expect(r.versions.rate_config_ids).toHaveLength(4);
    expect(r.basis).toMatchObject({ requested_accessorials: [] });
  });
});
