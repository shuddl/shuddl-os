import { describe, expect, it } from "vitest";
import {
  ZoneTariff,
  FloorsConfig,
  FscConfig,
  AccessorialSchedule,
  ClassAdapter,
  TransitMatrix,
  RateConfig,
} from "../src/rating.js";

// doc 10 §17: rate_config(kind, version, payload, effective). These schemas model the PAYLOAD
// shape per kind — ZERO hardcoded tenant data, all money as INTEGER cents (Cents), all percentages
// as basis points (Bps, 0..10000). transit_matrix is deliberately absent (it lands in WP-08 booking).

const zoneTariff = {
  kind: "zone_tariff" as const,
  id: "zt-1",
  version: "2026.07",
  zip_to_zone: { "800": "Z4", "97201": "Z1" },
  rate_groups: [
    {
      id: "grp-a",
      zones: ["Z1", "Z4"],
      breaks: [
        { min_lb: 0, cwt_cents: 4200 },
        { min_lb: 500, cwt_cents: 3800 },
      ],
      min_charge_cents: 9500,
    },
  ],
};

describe("ZoneTariff", () => {
  it("parses a valid zone tariff", () => {
    const p = ZoneTariff.parse(zoneTariff);
    expect(p.kind).toBe("zone_tariff");
    expect(p.zip_to_zone["800"]).toBe("Z4");
    expect(p.rate_groups[0]?.breaks[0]?.cwt_cents).toBe(4200);
  });
  it("rejects an unknown top-level key (.strict)", () => {
    expect(() => ZoneTariff.parse({ ...zoneTariff, surcharge: 1 })).toThrow();
  });
  it("rejects an unknown key inside a break (.strict)", () => {
    expect(() =>
      ZoneTariff.parse({
        ...zoneTariff,
        rate_groups: [
          {
            ...zoneTariff.rate_groups[0],
            breaks: [{ min_lb: 0, cwt_cents: 4200, extra: 1 }],
          },
        ],
      }),
    ).toThrow();
  });
  it("rejects a float cwt_cents (integer-only Cents)", () => {
    expect(() =>
      ZoneTariff.parse({
        ...zoneTariff,
        rate_groups: [
          {
            ...zoneTariff.rate_groups[0],
            breaks: [{ min_lb: 0, cwt_cents: 42.5 }],
          },
        ],
      }),
    ).toThrow();
  });
  it("rejects an empty rate_groups array (min 1)", () => {
    expect(() => ZoneTariff.parse({ ...zoneTariff, rate_groups: [] })).toThrow();
  });
  it("rejects an empty breaks array (min 1)", () => {
    expect(() =>
      ZoneTariff.parse({
        ...zoneTariff,
        rate_groups: [{ ...zoneTariff.rate_groups[0], breaks: [] }],
      }),
    ).toThrow();
  });
  it("rejects an empty id / version (min 1)", () => {
    expect(() => ZoneTariff.parse({ ...zoneTariff, id: "" })).toThrow();
    expect(() => ZoneTariff.parse({ ...zoneTariff, version: "" })).toThrow();
  });
  it("rejects a zip_to_zone key that is not 3-5 digits", () => {
    expect(() => ZoneTariff.parse({ ...zoneTariff, zip_to_zone: { ab: "Z4" } })).toThrow();
    expect(() => ZoneTariff.parse({ ...zoneTariff, zip_to_zone: { "12": "Z4" } })).toThrow();
    expect(() => ZoneTariff.parse({ ...zoneTariff, zip_to_zone: { "123456": "Z4" } })).toThrow();
  });
  it("rejects a NEGATIVE cwt_cents (a cwt rate is a charge, never a credit — a negative crashes the engine)", () => {
    expect(() =>
      ZoneTariff.parse({
        ...zoneTariff,
        rate_groups: [
          { ...zoneTariff.rate_groups[0], breaks: [{ min_lb: 0, cwt_cents: -4200 }] },
        ],
      }),
    ).toThrow();
  });
  it("rejects a NEGATIVE min_charge_cents (a min charge is a floor, never a credit)", () => {
    expect(() =>
      ZoneTariff.parse({
        ...zoneTariff,
        rate_groups: [{ ...zoneTariff.rate_groups[0], min_charge_cents: -1 }],
      }),
    ).toThrow();
  });
});

// §1517 — THE FIXTURE THE ENGINE WOULD HAVE THROWN ON. This read `target 1500 / full 8500 / contribution 500`
// — full ABOVE target — and called itself "a valid floors config". `computeFloors` rejects exactly that
// ordering (`contribution > full || full > target`), so this file's "valid" and the rater's "misconfigured"
// were the same shape, and nothing noticed because the contracts test only PARSED and the rater test only
// COMPUTED. Corrected to a real ladder (5% / 85% / 98%) alongside the schema refinement that now makes the
// disagreement impossible.
const floors = {
  kind: "floors" as const,
  id: "fl-1",
  version: "2026.07",
  target_or_bps: 9800,
  full_cost_bps: 8500,
  contribution_bps: 500,
};

describe("FloorsConfig", () => {
  it("parses a valid floors config", () => {
    const p = FloorsConfig.parse(floors);
    expect(p.target_or_bps).toBe(9800);
    expect(p.full_cost_bps).toBe(8500);
    expect(p.contribution_bps).toBe(500);
  });
  it("rejects an unknown key (.strict)", () => {
    expect(() => FloorsConfig.parse({ ...floors, extra: 1 })).toThrow();
  });
  it("rejects a bps above 10000 (Bps range)", () => {
    expect(() => FloorsConfig.parse({ ...floors, full_cost_bps: 10_001 })).toThrow();
  });
  it("rejects a negative bps (Bps range)", () => {
    expect(() => FloorsConfig.parse({ ...floors, contribution_bps: -1 })).toThrow();
  });
  // §1517 — THE RELATIONSHIP, not only each field's range. Every value below is a valid `Bps`; only the ORDER
  // is wrong, and that ordering made `computeFloors` throw on every quote priced against it — measured as an
  // HTTP 500 on the UNAUTHENTICATED `/pub/quote`, for every visitor, until someone noticed. Same idiom as
  // `SplitComputedPayload`'s bps-sum refinement: a money schema asserts how its fields RELATE.
  it("rejects a misordered ladder (each bps valid, the ORDER wrong) — §1517's anonymous 500", () => {
    expect(() => FloorsConfig.parse({ ...floors, contribution_bps: 9_800, full_cost_bps: 9_200, target_or_bps: 8_500 })).toThrow();
    expect(() => FloorsConfig.parse({ ...floors, full_cost_bps: 9_900 })).toThrow(); // full above target only
    expect(() => FloorsConfig.parse({ ...floors, contribution_bps: 8_600 })).toThrow(); // contribution above full only
    // …and EQUALITY is legal at both rungs — a flat ladder is degenerate, not misordered.
    expect(FloorsConfig.parse({ ...floors, contribution_bps: 8_500, full_cost_bps: 8_500, target_or_bps: 8_500 }).full_cost_bps).toBe(8_500);
  });
  it("rejects a float bps (integer-only)", () => {
    expect(() => FloorsConfig.parse({ ...floors, target_or_bps: 15.5 })).toThrow();
  });
});

const fsc = { kind: "fsc" as const, id: "fsc-1", version: "2026.07", pct_bps: 3200 };

describe("FscConfig", () => {
  it("parses a valid fsc config", () => {
    expect(FscConfig.parse(fsc).pct_bps).toBe(3200);
  });
  it("rejects an unknown key (.strict)", () => {
    expect(() => FscConfig.parse({ ...fsc, extra: 1 })).toThrow();
  });
  it("rejects a pct_bps above 10000 (Bps range)", () => {
    expect(() => FscConfig.parse({ ...fsc, pct_bps: 12_000 })).toThrow();
  });
});

const accessorials = {
  kind: "accessorials" as const,
  id: "acc-1",
  version: "2026.07",
  items: { liftgate: 2500, residential: 1800 },
};

describe("AccessorialSchedule", () => {
  it("parses a valid accessorial schedule", () => {
    const p = AccessorialSchedule.parse(accessorials);
    expect(p.items.liftgate).toBe(2500);
  });
  it("rejects an unknown key (.strict)", () => {
    expect(() => AccessorialSchedule.parse({ ...accessorials, extra: 1 })).toThrow();
  });
  it("rejects a float item value (integer-only Cents)", () => {
    expect(() =>
      AccessorialSchedule.parse({ ...accessorials, items: { liftgate: 25.5 } }),
    ).toThrow();
  });
  it("rejects a NEGATIVE item value (an accessorial is a charge — a negative could silently reduce a valid price)", () => {
    expect(() =>
      AccessorialSchedule.parse({ ...accessorials, items: { liftgate: -2500 } }),
    ).toThrow();
  });
});

const classAdapter = {
  kind: "class_adapter" as const,
  id: "cls-1",
  version: "2026.07",
  class_to_density_pcf: { "50": 50, "70": 15, "92.5": 10.5 },
};

describe("ClassAdapter", () => {
  it("parses a valid class adapter with fractional density", () => {
    const p = ClassAdapter.parse(classAdapter);
    expect(p.class_to_density_pcf["70"]).toBe(15);
    expect(p.class_to_density_pcf["92.5"]).toBe(10.5);
  });
  it("rejects an unknown key (.strict)", () => {
    expect(() => ClassAdapter.parse({ ...classAdapter, extra: 1 })).toThrow();
  });
  it("rejects a zero / negative / Infinity density (bounds the density→dim-weight division)", () => {
    expect(() =>
      ClassAdapter.parse({ ...classAdapter, class_to_density_pcf: { "50": 0 } }),
    ).toThrow();
    expect(() =>
      ClassAdapter.parse({ ...classAdapter, class_to_density_pcf: { "50": -15 } }),
    ).toThrow();
    expect(() =>
      ClassAdapter.parse({ ...classAdapter, class_to_density_pcf: { "50": Infinity } }),
    ).toThrow();
    expect(() =>
      ClassAdapter.parse({ ...classAdapter, class_to_density_pcf: { "50": NaN } }),
    ).toThrow();
  });
  it("still accepts a fractional positive density", () => {
    const p = ClassAdapter.parse({ ...classAdapter, class_to_density_pcf: { "70": 15.5 } });
    expect(p.class_to_density_pcf["70"]).toBe(15.5);
  });
});

const transitMatrix = {
  kind: "transit_matrix" as const,
  id: "tm-1",
  version: "2026.07",
  days: {
    Z1: { Z1: 1, Z4: 3 },
    Z4: { Z1: 3, Z4: 2 },
  },
  default_days: 5,
};

describe("TransitMatrix (REQ-059)", () => {
  it("parses a valid transit matrix and reads a zone×zone lane", () => {
    const p = TransitMatrix.parse(transitMatrix);
    expect(p.kind).toBe("transit_matrix");
    expect(p.days["Z1"]?.["Z4"]).toBe(3);
    expect(p.default_days).toBe(5);
  });
  it("parses WITHOUT default_days (it is optional)", () => {
    const { default_days: _omit, ...noDefault } = transitMatrix;
    const p = TransitMatrix.parse(noDefault);
    expect(p.default_days).toBeUndefined();
    expect(p.days["Z4"]?.["Z1"]).toBe(3);
  });
  it("rejects an unknown top-level key (.strict)", () => {
    expect(() => TransitMatrix.parse({ ...transitMatrix, surcharge: 1 })).toThrow();
  });
  it("rejects a FLOAT day (integer-only SafeInt — no fractional transit days)", () => {
    expect(() => TransitMatrix.parse({ ...transitMatrix, days: { Z1: { Z4: 2.5 } } })).toThrow();
    expect(() => TransitMatrix.parse({ ...transitMatrix, default_days: 3.5 })).toThrow();
  });
  it("rejects a NEGATIVE day (a transit standard is a count, never negative)", () => {
    expect(() => TransitMatrix.parse({ ...transitMatrix, days: { Z1: { Z4: -1 } } })).toThrow();
    expect(() => TransitMatrix.parse({ ...transitMatrix, default_days: -1 })).toThrow();
  });
  it("accepts a ZERO-day lane (same-zone next-hour transit is a legitimate 0 business days)", () => {
    const p = TransitMatrix.parse({ ...transitMatrix, days: { Z1: { Z1: 0 } } });
    expect(p.days["Z1"]?.["Z1"]).toBe(0);
  });
  it("rejects an empty id / version (min 1 — version-pinned like every rate_config)", () => {
    expect(() => TransitMatrix.parse({ ...transitMatrix, id: "" })).toThrow();
    expect(() => TransitMatrix.parse({ ...transitMatrix, version: "" })).toThrow();
  });
});

describe("RateConfig discriminated union", () => {
  it("discriminates a zone_tariff payload to ZoneTariff", () => {
    const p = RateConfig.parse(zoneTariff);
    expect(p.kind).toBe("zone_tariff");
    // narrow on the discriminant
    if (p.kind === "zone_tariff") {
      expect(p.rate_groups[0]?.min_charge_cents).toBe(9500);
    }
  });
  it("discriminates each of the six kinds", () => {
    expect(RateConfig.parse(floors).kind).toBe("floors");
    expect(RateConfig.parse(fsc).kind).toBe("fsc");
    expect(RateConfig.parse(accessorials).kind).toBe("accessorials");
    expect(RateConfig.parse(classAdapter).kind).toBe("class_adapter");
    expect(RateConfig.parse(transitMatrix).kind).toBe("transit_matrix");
  });
  it("throws on an unknown kind", () => {
    expect(() => RateConfig.parse({ ...floors, kind: "bogus" })).toThrow();
  });
  it("discriminates a transit_matrix payload to TransitMatrix (rejects a floors-shaped body under that kind)", () => {
    const p = RateConfig.parse(transitMatrix);
    expect(p.kind).toBe("transit_matrix");
    if (p.kind === "transit_matrix") expect(p.days["Z1"]?.["Z4"]).toBe(3);
    // a floors payload wearing the transit_matrix kind fails (missing `days`, extra floors keys under .strict)
    expect(() => RateConfig.parse({ ...floors, kind: "transit_matrix" })).toThrow();
  });
});
