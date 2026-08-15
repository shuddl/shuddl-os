import { describe, expect, it } from "vitest";
import { ZoneTariff, FloorsConfig, FscConfig, AccessorialSchedule } from "@shuddl/contracts";
import { brokerageTemplate, assetTemplate } from "../src/tariff-templates.js";
import type { BrokerageTemplateParams, ColdStartBundle } from "../src/tariff-templates.js";
import { priceShipment } from "../src/price.js";
import type { RateRequest, TenantRatingConfig } from "../src/price.js";

// REQ-151 (WP-14 Task 4) — the RATING COLD-START templates. `brokerageTemplate` turns a market rate + margin
// into a VALID rate_config bundle that prices IMMEDIATELY for a priceable load; `assetTemplate` is a documented
// scaffold that fabricates NO tariff (an asset-mode tenant with no tariff ⇒ the engine returns UNKNOWN — the
// "no price on air" law, REQ-004). These are PURE data builders (no I/O). The 504-sweep + engine tests are
// unaffected — this only ADDS a config factory the seed/builder materialize.

// Parse the input-typed bundle through the REAL @shuddl/contracts schemas → a TenantRatingConfig the engine
// consumes. This ALSO proves the template output is schema-valid (a bad field would throw here).
function toRatingConfig(bundle: ColdStartBundle): TenantRatingConfig {
  return {
    zone_tariff: ZoneTariff.parse(bundle.zone_tariff),
    floors: FloorsConfig.parse(bundle.floors),
    fsc: FscConfig.parse(bundle.fsc),
    accessorials: AccessorialSchedule.parse(bundle.accessorials),
  };
}

const PARAMS: BrokerageTemplateParams = {
  marketRateCentsPerCwt: 3500, // $35.00 / cwt market linehaul (the broker's carrier-cost proxy)
  marginBps: 1800, // 18% gross-margin markup → sell
  minChargeCents: 12_000, // $120 small-shipment floor
  fscPctBps: 2400, // 24% fuel surcharge
  idPrefix: "cold-test",
};

const DIMS = { l_in: 48, w_in: 40, h_in: 48, pieces: 2 };

describe("brokerageTemplate — market rate + margin → an immediately-rateable rate_config (REQ-151)", () => {
  it("emits a schema-VALID bundle for all four required kinds (parses against @shuddl/contracts)", () => {
    const bundle = brokerageTemplate(PARAMS);
    expect(() => toRatingConfig(bundle)).not.toThrow();
    expect(bundle.zone_tariff.kind).toBe("zone_tariff");
    expect(bundle.floors.kind).toBe("floors");
    expect(bundle.fsc.kind).toBe("fsc");
    expect(bundle.accessorials.kind).toBe("accessorials");
    // version-pinned, DISTINCT ids per kind (I5: quotes pin id@version; a shared id would collide on the PK)
    const ids = [bundle.zone_tariff.id, bundle.floors.id, bundle.fsc.id, bundle.accessorials.id];
    expect(new Set(ids).size).toBe(4);
  });

  it("PRICES a real sell for a priceable load (weight present) — brokerage cold start (REQ-151)", () => {
    const config = toRatingConfig(brokerageTemplate(PARAMS));
    const request: RateRequest = { origin_zip: "97201", dest_zip: "80012", weight_lb: 1000, dims: DIMS };
    const quote = priceShipment(request, config);
    expect(quote.status).toBe("PRICED");
    if (quote.status !== "PRICED") throw new Error("unreachable");
    expect(quote.sell_cents).toBeGreaterThan(0);
    // the sell was priced against the template's own pinned zone tariff (I5)
    expect(quote.versions.rate_config_ids).toContain(`${config.zone_tariff.id}@${config.zone_tariff.version}`);
    // sane price — nowhere near the $2,000/lb anomaly cap
    expect(quote.anomaly).toBeNull();
  });

  it("prices ANY US destination zip — the national cold-start zone map has no coverage holes", () => {
    const config = toRatingConfig(brokerageTemplate(PARAMS));
    for (const dest of ["00501", "10001", "33101", "60601", "90210", "99801"]) {
      const quote = priceShipment({ origin_zip: "97201", dest_zip: dest, weight_lb: 500, dims: DIMS }, config);
      expect(quote.status).toBe("PRICED");
    }
  });

  it("missing weight → UNKNOWN even WITH a brokerage tariff (the physics gate is unchanged, REQ-004)", () => {
    const config = toRatingConfig(brokerageTemplate(PARAMS));
    const noWeight: RateRequest = { origin_zip: "97201", dest_zip: "80012", dims: DIMS };
    const quote = priceShipment(noWeight, config);
    expect(quote.status).toBe("UNKNOWN");
    if (quote.status !== "UNKNOWN") throw new Error("unreachable");
    expect(quote.reason).toBe("missing_physics");
  });

  it("missing dims → UNKNOWN even WITH a brokerage tariff (no price on air, REQ-004)", () => {
    const config = toRatingConfig(brokerageTemplate(PARAMS));
    const noDims: RateRequest = { origin_zip: "97201", dest_zip: "80012", weight_lb: 1000 };
    const quote = priceShipment(noDims, config);
    expect(quote.status).toBe("UNKNOWN");
  });

  it("the sell reflects the margin markup — a higher margin yields a higher freight linehaul", () => {
    const lo = toRatingConfig(brokerageTemplate({ ...PARAMS, marginBps: 1000 }));
    const hi = toRatingConfig(brokerageTemplate({ ...PARAMS, marginBps: 4000 }));
    const req: RateRequest = { origin_zip: "97201", dest_zip: "80012", weight_lb: 5000, dims: DIMS };
    const loQ = priceShipment(req, lo);
    const hiQ = priceShipment(req, hi);
    if (loQ.status !== "PRICED" || hiQ.status !== "PRICED") throw new Error("both must price");
    expect(hiQ.sell_cents).toBeGreaterThan(loQ.sell_cents);
  });

  it("the derived floors are a valid, monotonic ladder (contribution ≤ full ≤ target)", () => {
    const floors = FloorsConfig.parse(brokerageTemplate(PARAMS).floors);
    expect(floors.contribution_bps).toBeLessThanOrEqual(floors.full_cost_bps);
    expect(floors.full_cost_bps).toBeLessThanOrEqual(floors.target_or_bps);
    expect(floors.target_or_bps).toBeLessThanOrEqual(10_000);
  });

  // §1504 (REQ-151/118) — EACH PARAM GUARD NAMED, because a bare `.toThrow()` cannot say WHICH layer threw.
  //
  // MEASURED at §1504: neutering `assertNonNegInt` and `assertPosInt` — deleting their throws outright — left
  // this suite 168/168 green, the bare-`toThrow()` case below included. Something else downstream rejected the
  // same inputs, so the case passed for a reason unrelated to the guard it appears to cover: §1500's shape in
  // a pure package, where two layers produce the same observable and the assertion cannot tell them apart.
  //
  // The message IS the discriminator — each helper names itself and its parameter — so these assertions now
  // fail if the param guard stops firing, even when a later layer still throws. `minChargeCents` had no case
  // at all, which is why `assertNonNegInt` had no watcher of any kind.
  it("fails LOUDLY on nonsense params, each at ITS OWN guard (a pure builder never emits a mispricing config)", () => {
    // assertPosInt — the market rate must be a positive integer (a zero or negative cwt rate is a mispricing).
    expect(() => brokerageTemplate({ ...PARAMS, marketRateCentsPerCwt: -1 })).toThrow(/marketRateCentsPerCwt must be a positive integer/);
    expect(() => brokerageTemplate({ ...PARAMS, marketRateCentsPerCwt: 3500.5 })).toThrow(/marketRateCentsPerCwt must be a positive integer/);
    expect(() => brokerageTemplate({ ...PARAMS, marketRateCentsPerCwt: 0 })).toThrow(/marketRateCentsPerCwt must be a positive integer/);
    // assertBps — margin and FSC are basis points, 0..10000 inclusive.
    expect(() => brokerageTemplate({ ...PARAMS, marginBps: 20_000 })).toThrow(/marginBps must be an integer basis point/);
    expect(() => brokerageTemplate({ ...PARAMS, fscPctBps: -5 })).toThrow(/fscPctBps must be an integer basis point/);
    // assertNonNegInt — the minimum charge may be zero but never negative or fractional. NO case existed.
    expect(() => brokerageTemplate({ ...PARAMS, minChargeCents: -1 })).toThrow(/minChargeCents must be a non-negative integer/);
    expect(() => brokerageTemplate({ ...PARAMS, minChargeCents: 12.5 })).toThrow(/minChargeCents must be a non-negative integer/);
    // …and zero IS allowed, so the guard is not merely "reject everything unusual".
    expect(() => brokerageTemplate({ ...PARAMS, minChargeCents: 0 })).not.toThrow();
    expect(() => brokerageTemplate({ ...PARAMS, idPrefix: "" })).toThrow(/idPrefix must be non-empty/);
  });
});

describe("assetTemplate — NO fabricated tariff; asset mode without a tariff = UNKNOWN (REQ-151/004)", () => {
  it("returns a documented scaffold that seeds NOTHING (seed is null — never a fabricated rate)", () => {
    const t = assetTemplate();
    expect(t.mode).toBe("asset");
    expect(t.seed).toBeNull();
    // it names the four required kinds a real tariff (built/imported) must supply
    expect(t.requiredKinds).toEqual(["zone_tariff", "floors", "fsc", "accessorials"]);
    expect(typeof t.guidance).toBe("string");
  });
});
