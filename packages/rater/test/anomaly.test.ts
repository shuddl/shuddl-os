import { describe, expect, it } from "vitest";
import { ZoneTariff, FloorsConfig, FscConfig, AccessorialSchedule } from "@shuddl/contracts";
import { detectAnomaly, DEFAULT_MAX_CENTS_PER_LB } from "../src/anomaly.js";
import type { AnomalyFlag } from "../src/anomaly.js";
import { executingShareCents } from "../src/approval.js";
import type { Leg } from "../src/approval.js";
import { priceShipment } from "../src/price.js";
import type { RateRequest, TenantRatingConfig } from "../src/price.js";
import fixtureRaw from "../../../fixtures/anomaly/the-222084-case.json?raw";

// ============================================================================================
// PERMANENT REGRESSION — DO NOT DELETE OR WEAKEN (REQ-040 / CLAUDE.md Law 5).
// "The $222,084/35-lb anomaly regression is permanent." A 35-lb shipment priced at $222,084
// (~$6,345/lb) is absurd and MUST flag at pricing — forever. The fixture is encoded in-repo from
// the QA case DESCRIPTION only: synthetic party ids (carrier-a/carrier-b), NO engagement-workspace
// data, no real names (REQ-167). If this test ever goes green-by-deletion, the guard is gone.
// ============================================================================================

// The vendored fixture, replayed verbatim (bytes hash-pinned by fixtures/manifest.json).
interface AnomalyFixture {
  case: string;
  weight_lb: number;
  sell_cents: number;
  expect: { flags: boolean; code: string };
  interline_demo: {
    gross_sell_cents: number;
    legs: Leg[];
    executing_party: string;
    expect_share_cents: number;
    expect_share_flags: boolean;
  };
}
const fixture = JSON.parse(fixtureRaw) as AnomalyFixture;

describe("detectAnomaly — the PERMANENT $222,084 / 35-lb case flags at pricing (REQ-040)", () => {
  it("the 35-lb $222,084 quote flags over_per_lb — forever", () => {
    const flag = detectAnomaly({ sell_cents: fixture.sell_cents, weight_lb: fixture.weight_lb });
    expect(flag).not.toBeNull();
    expect(flag?.code).toBe("over_per_lb");
    // ~$6,345/lb = 634,526¢/lb, well past the safety cap.
    expect(flag?.per_lb_cents).toBeGreaterThan(DEFAULT_MAX_CENTS_PER_LB);
    expect(flag?.cap_cents_per_lb).toBe(DEFAULT_MAX_CENTS_PER_LB);
    expect(flag?.detail).toContain(String(fixture.sell_cents));
  });

  it("the fixture's own stated expectation matches (the encoded QA case)", () => {
    expect(fixture.case).toBe("anomaly-222084-35lb");
    expect(fixture.weight_lb).toBe(35);
    expect(fixture.sell_cents).toBe(22_208_400);
    const flag = detectAnomaly({ sell_cents: fixture.sell_cents, weight_lb: fixture.weight_lb });
    expect(flag !== null).toBe(fixture.expect.flags);
    expect(flag?.code).toBe(fixture.expect.code);
  });
});

describe("detectAnomaly — the cap does NOT false-flag legitimate freight (the safe band)", () => {
  it("a 1-lb shipment at a realistic ~$115 min charge does NOT flag (min-charge freight is REAL)", () => {
    // 11,500¢ / 1 lb = 11,500¢/lb ≈ $115/lb — real min-charge freight; the cap sits far above it.
    expect(detectAnomaly({ sell_cents: 11_500, weight_lb: 1 })).toBeNull();
  });

  it("a normal LTL per-lb (a few dollars per lb) does NOT flag", () => {
    // $30,000 (3,000,000¢) on 1,500 lb = 2,000¢/lb ($20/lb) — ordinary freight. No flag.
    expect(detectAnomaly({ sell_cents: 3_000_000, weight_lb: 1_500 })).toBeNull();
  });

  it("a price sitting exactly AT the cap is not an anomaly (strict >)", () => {
    // sell = cap × weight exactly ⇒ per-lb == cap ⇒ NOT over.
    expect(detectAnomaly({ sell_cents: DEFAULT_MAX_CENTS_PER_LB * 10, weight_lb: 10 })).toBeNull();
    // one cent over the cap ⇒ flags.
    expect(detectAnomaly({ sell_cents: DEFAULT_MAX_CENTS_PER_LB * 10 + 1, weight_lb: 10 })?.code).toBe(
      "over_per_lb",
    );
  });
});

describe("detectAnomaly — a negative sell is a price that cannot exist", () => {
  it("negative sell ⇒ code negative", () => {
    const flag = detectAnomaly({ sell_cents: -1, weight_lb: 35 });
    expect(flag?.code).toBe("negative");
    expect(flag?.detail).toContain("-1");
  });

  it("a per-tenant cap override can be supplied (production reads it from tenant policy)", () => {
    // A tighter $50/lb (5,000¢/lb) cap flags a $60/lb shipment that the default $2,000/lb cap would pass.
    expect(detectAnomaly({ sell_cents: 6_000, weight_lb: 1 })).toBeNull();
    expect(
      detectAnomaly({ sell_cents: 6_000, weight_lb: 1 }, { max_cents_per_lb: 5_000 })?.code,
    ).toBe("over_per_lb");
  });

  it("a MALFORMED cap throws — never silently disables the net or flags every price (Task 10 seam)", () => {
    // NaN cap: `sell > NaN` is always false ⇒ the permanent net would silently no-op. Must throw.
    expect(() => detectAnomaly({ sell_cents: 100, weight_lb: 1 }, { max_cents_per_lb: Number.NaN })).toThrow();
    // Zero / negative cap: would flag every price. Must throw.
    expect(() => detectAnomaly({ sell_cents: 100, weight_lb: 1 }, { max_cents_per_lb: 0 })).toThrow();
    expect(() => detectAnomaly({ sell_cents: 100, weight_lb: 1 }, { max_cents_per_lb: -5_000 })).toThrow();
  });

  it("a non-positive/non-integer weight is a caller error (per-lb undefined) ⇒ throws, never divides by zero", () => {
    expect(() => detectAnomaly({ sell_cents: 100, weight_lb: 0 })).toThrow();
    expect(() => detectAnomaly({ sell_cents: 100, weight_lb: -5 })).toThrow();
    expect(() => detectAnomaly({ sell_cents: 100, weight_lb: 1.5 })).toThrow();
  });
});

describe("interline gross-vs-share — the executing-share rule keeps the sane path sane (REQ-040)", () => {
  const demo = fixture.interline_demo;

  it("the GROSS attributed to the 35-lb leg flags; the tenant's SHARE does NOT", () => {
    // GROSS ($222,084 on 35 lb) is the anomaly.
    expect(detectAnomaly({ sell_cents: demo.gross_sell_cents, weight_lb: fixture.weight_lb })?.code).toBe(
      "over_per_lb",
    );

    // The executing-share rule (Task 6) attributes only carrier-a's leg. Same primitive Task 6 ships.
    const share = executingShareCents(demo.gross_sell_cents, demo.legs, demo.executing_party);
    expect(share).toBe(demo.expect_share_cents); // 22,208,400 × 30 / 10,000 = 66,625

    // The share on the same 35 lb is a sane per-lb ⇒ NO flag. Gross flags, share doesn't — the whole point.
    const shareFlag = detectAnomaly({ sell_cents: share, weight_lb: fixture.weight_lb });
    expect(shareFlag).toBeNull();
    expect(shareFlag === null).toBe(!demo.expect_share_flags);
  });

  it("PROOF the share rule changed the outcome: gross flags, share is null on the identical weight", () => {
    const grossFlag = detectAnomaly({ sell_cents: demo.gross_sell_cents, weight_lb: fixture.weight_lb });
    const share = executingShareCents(demo.gross_sell_cents, demo.legs, demo.executing_party);
    const shareFlag = detectAnomaly({ sell_cents: share, weight_lb: fixture.weight_lb });
    expect(grossFlag).not.toBeNull();
    expect(shareFlag).toBeNull();
  });
});

// A small SCHEMA-VALID config so priceShipment produces a real PRICED quote carrying the anomaly field.
const config: TenantRatingConfig = {
  zone_tariff: ZoneTariff.parse({
    kind: "zone_tariff",
    id: "zt-anom",
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
  }),
  floors: FloorsConfig.parse({
    kind: "floors",
    id: "fl-anom",
    version: "2026.07",
    contribution_bps: 8_500,
    full_cost_bps: 9_200,
    target_or_bps: 9_800,
  }),
  fsc: FscConfig.parse({ kind: "fsc", id: "fsc-anom", version: "2026.07", pct_bps: 2_500 }),
  accessorials: AccessorialSchedule.parse({
    kind: "accessorials",
    id: "acc-anom",
    version: "2026.07",
    items: { liftgate: 2_500 },
  }),
};

describe("priceShipment carries the anomaly flag on every PRICED quote (REQ-040 wired at pricing)", () => {
  it("a normal SEED-style quote prices with anomaly: null", () => {
    // 1,500 lb → freight 30,000 + fsc 7,500 = 37,500; 37,500 / 1,500 = 25¢/lb — ordinary, no flag.
    const req: RateRequest = { origin_zip: "97201", dest_zip: "80112", weight_lb: 1_500, dims: { l_in: 48, w_in: 40, h_in: 48, pieces: 1 } };
    const r = priceShipment(req, config);
    if (r.status !== "PRICED") throw new Error("expected PRICED");
    expect(r.sell_cents).toBe(37_500);
    expect(r.anomaly).toBeNull();
  });

  it("the PRICED quote always has the anomaly key present (null or a flag), never absent", () => {
    const req: RateRequest = { origin_zip: "97201", dest_zip: "80112", weight_lb: 1_500, dims: { l_in: 48, w_in: 40, h_in: 48, pieces: 1 } };
    const r = priceShipment(req, config);
    if (r.status !== "PRICED") throw new Error("expected PRICED");
    expect("anomaly" in r).toBe(true);
  });

  it("FULL PATH — an absurd quote flags THROUGH priceShipment, proving the flag reaches PricedQuote.anomaly", () => {
    // A hand-built config whose min_charge_cents ($250,000 = 25,000,000¢) far exceeds the 200,000¢/lb cap.
    // On a 1-lb shipment the min charge dominates the freight, so the composed sell is ~$250k on 1 lb —
    // a genuine over_per_lb that priceShipment must surface in `anomaly`. This exercises the ACTUAL wiring
    // (composed sell over the request weight); a hardcoded null, swapped args, or wrong denominator fails HERE.
    const absurdConfig: TenantRatingConfig = {
      zone_tariff: ZoneTariff.parse({
        kind: "zone_tariff",
        id: "zt-absurd",
        version: "2026.07",
        zip_to_zone: { "801": "ZA" },
        rate_groups: [
          {
            id: "grp-absurd",
            zones: ["ZA"],
            breaks: [{ min_lb: 0, cwt_cents: 5_000 }],
            min_charge_cents: 25_000_000, // $250,000 min charge — dominates on a 1-lb piece
          },
        ],
      }),
      floors: FloorsConfig.parse({
        kind: "floors",
        id: "fl-absurd",
        version: "2026.07",
        contribution_bps: 8_500,
        full_cost_bps: 9_200,
        target_or_bps: 9_800,
      }),
      fsc: FscConfig.parse({ kind: "fsc", id: "fsc-absurd", version: "2026.07", pct_bps: 2_500 }),
      accessorials: AccessorialSchedule.parse({
        kind: "accessorials",
        id: "acc-absurd",
        version: "2026.07",
        items: { liftgate: 2_500 },
      }),
    };
    const req: RateRequest = { origin_zip: "97201", dest_zip: "80112", weight_lb: 1, dims: { l_in: 12, w_in: 12, h_in: 12, pieces: 1 } };
    const r = priceShipment(req, absurdConfig);
    expect(r.status).toBe("PRICED");
    if (r.status !== "PRICED") throw new Error("expected PRICED");
    expect(r.anomaly).not.toBeNull();
    expect(r.anomaly?.code).toBe("over_per_lb");
    // the flagged per-lb is the composed sell over the 1-lb request weight — the quote's OWN output.
    expect(r.anomaly?.per_lb_cents).toBe(r.sell_cents);
  });

  it("defensive: a synthetically-forced absurd sell WOULD flag (the net that guards the price)", () => {
    // priceShipment's own SEED-style configs can't produce $6,345/lb, so also exercise the net directly with
    // the forced absurd figure — the same call priceShipment makes on its output.
    const forced: AnomalyFlag | null = detectAnomaly({ sell_cents: 22_208_400, weight_lb: 35 });
    expect(forced?.code).toBe("over_per_lb");
  });
});
