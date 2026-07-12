import { describe, expect, it } from "vitest";
import { ZoneTariff, FloorsConfig, FscConfig, AccessorialSchedule } from "@shuddl/contracts";
import { priceShipment } from "../src/price.js";
import type { RateRequest, TenantRatingConfig } from "../src/price.js";
import { ParityCase, runParity, verifyParityPins } from "../../../tools/rater/parity.js";

// Proves the PARITY RUNNER LOGIC with a SYNTHETIC stand-in — NOT the real 48-tests/504-sweep/tenant-0
// fixtures (those live in the engagement workspace and are `pending` in fixtures/manifest.json). These
// cases live INLINE here, never under fixtures/, so they can never masquerade as vendored engagement data.
// The point: prove runParity actually CATCHES a divergence (wrong sell_cents, wrong status), not merely that
// it rubber-stamps a match. The self-consistent cases compute their `expect` by calling priceShipment, so
// a green here means "the comparison agrees with the engine", never a hand-fabricated "48 tests pass".

// Same shape as packages/rater/test/price.test.ts — small, hand-auditable, schema-valid, NOT SEED-1.
const zone_tariff = ZoneTariff.parse({
  kind: "zone_tariff",
  id: "zt-parity",
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
const floors = FloorsConfig.parse({
  kind: "floors",
  id: "fl-parity",
  version: "2026.07",
  contribution_bps: 8_500,
  full_cost_bps: 9_200,
  target_or_bps: 9_800,
});
const fsc = FscConfig.parse({ kind: "fsc", id: "fsc-parity", version: "2026.07", pct_bps: 2_500 });
const accessorials = AccessorialSchedule.parse({
  kind: "accessorials",
  id: "acc-parity",
  version: "2026.07",
  items: { liftgate: 2_500, residential: 4_000 },
});
const config: TenantRatingConfig = { zone_tariff, floors, fsc, accessorials };

const dims = { l_in: 48, w_in: 40, h_in: 48, pieces: 1 };

// Build a PRICED case whose `expect` is derived by actually calling priceShipment — self-consistent by
// construction, so a green proves the comparison agrees with the engine (not with a guessed number).
function pricedCaseFrom(name: string, request: RateRequest): ParityCase {
  const q = priceShipment(request, config);
  if (q.status !== "PRICED") throw new Error(`fixture setup: expected PRICED for ${name}`);
  return ParityCase.parse({
    name,
    request,
    expect: { status: "PRICED", sell_cents: q.sell_cents, floors: q.floors },
  });
}

const okRequest: RateRequest = {
  origin_zip: "97201",
  dest_zip: "80112",
  weight_lb: 1_500,
  dims,
  accessorials: ["liftgate"],
};
const noAccessorialRequest: RateRequest = {
  origin_zip: "97201",
  dest_zip: "80112",
  weight_lb: 1_500,
  dims,
};

describe("runParity — self-consistent cases all match (passed === total, zero mismatches)", () => {
  it("passes every case whose expect was computed from the engine (status + sell + floors)", () => {
    const cases: ParityCase[] = [
      pricedCaseFrom("liftgate-1500lb", okRequest),
      pricedCaseFrom("no-accessorial-1500lb", noAccessorialRequest),
      ParityCase.parse({
        name: "missing-physics-unknown",
        request: { origin_zip: "97201", dest_zip: "80112" },
        expect: { status: "UNKNOWN", reason: "missing_physics" },
      }),
    ];
    const r = runParity(cases, config);
    expect(r.total).toBe(3);
    expect(r.passed).toBe(3);
    expect(r.mismatches).toEqual([]);
  });
});

describe("runParity — CATCHES a real divergence (not a rubber stamp)", () => {
  it("reports exactly a sell_cents mismatch when expect.sell_cents is deliberately wrong", () => {
    const correct = priceShipment(okRequest, config);
    if (correct.status !== "PRICED") throw new Error("expected PRICED");
    const wrong = ParityCase.parse({
      name: "wrong-sell",
      request: okRequest,
      // deliberately off by one cent from the engine's real 40_000
      expect: { status: "PRICED", sell_cents: correct.sell_cents + 1 },
    });
    const r = runParity([wrong], config);
    expect(r.total).toBe(1);
    expect(r.passed).toBe(0);
    expect(r.mismatches).toEqual([
      {
        name: "wrong-sell",
        field: "sell_cents",
        expected: correct.sell_cents + 1,
        actual: correct.sell_cents,
      },
    ]);
  });

  it("reports a floors mismatch when an expected floor is wrong", () => {
    const correct = priceShipment(okRequest, config);
    if (correct.status !== "PRICED") throw new Error("expected PRICED");
    const wrong = ParityCase.parse({
      name: "wrong-floor",
      request: okRequest,
      expect: {
        status: "PRICED",
        sell_cents: correct.sell_cents,
        floors: { ...correct.floors, target: correct.floors.target + 100 },
      },
    });
    const r = runParity([wrong], config);
    expect(r.passed).toBe(0);
    expect(r.mismatches).toEqual([
      {
        name: "wrong-floor",
        field: "floors.target",
        expected: correct.floors.target + 100,
        actual: correct.floors.target,
      },
    ]);
  });

  it("catches a PRICED-vs-UNKNOWN status divergence and does not compare downstream fields", () => {
    // The engine PRICES this request, but the case expects UNKNOWN.
    const wrong = ParityCase.parse({
      name: "expected-unknown-but-prices",
      request: okRequest,
      expect: { status: "UNKNOWN", reason: "no_zone" },
    });
    const r = runParity([wrong], config);
    expect(r.passed).toBe(0);
    // exactly one mismatch: the status; no reason/sell comparison across a status change.
    expect(r.mismatches).toEqual([
      { name: "expected-unknown-but-prices", field: "status", expected: "UNKNOWN", actual: "PRICED" },
    ]);
  });

  it("catches an UNKNOWN reason mismatch when both are UNKNOWN", () => {
    const wrong = ParityCase.parse({
      name: "wrong-reason",
      request: { origin_zip: "97201", dest_zip: "80112" }, // missing physics ⇒ missing_physics
      expect: { status: "UNKNOWN", reason: "no_zone" },
    });
    const r = runParity([wrong], config);
    expect(r.passed).toBe(0);
    expect(r.mismatches).toEqual([
      { name: "wrong-reason", field: "reason", expected: "no_zone", actual: "missing_physics" },
    ]);
  });

  it("defense-in-depth: a PRICED expect with NO sell_cents is a mismatch, not a status-only pass", () => {
    // Constructed WITHOUT ParityCase.parse (whose refine would reject it) — proves runParity itself, being
    // exported, never blesses a hollow PRICED expect that a hand-built caller might pass. Inline request
    // literal (not the RateRequest const) so its inferred type matches the case schema exactly.
    const hollowRequest = { origin_zip: "97201", dest_zip: "80112", weight_lb: 1_500, dims };
    const hollow: ParityCase = {
      name: "hollow-priced",
      request: hollowRequest,
      expect: { status: "PRICED" }, // sell_cents deliberately absent
    };
    const correct = priceShipment(hollowRequest, config);
    if (correct.status !== "PRICED") throw new Error("expected PRICED");
    const r = runParity([hollow], config);
    expect(r.passed).toBe(0);
    expect(r.mismatches).toEqual([
      { name: "hollow-priced", field: "sell_cents", expected: undefined, actual: correct.sell_cents },
    ]);
  });
});

describe("verifyParityPins — vendored + hash-pin gate (no self-consistent false green, REQ-027/REQ-165)", () => {
  // The three parity fixtures the gate governs, with a synthetic pinned hash per path. hashFn/existsFn are
  // injected so no real filesystem is touched — the point is the DECISION: a present set greens ONLY when
  // all three rows are vendored, carry a non-null sha256, and the on-disk bytes hash to that exact pin.
  type Row = { id: string; status: string; path: string; sha256: string | null };
  const PIN: Record<string, string> = {
    "fixtures/rater/48-tests/": "a".repeat(64),
    "fixtures/rater/504-sweep/": "b".repeat(64),
    "fixtures/tariff/": "c".repeat(64),
  };
  const hashFn = (p: string): string => {
    const h = PIN[p];
    if (h === undefined) throw new Error(`unexpected path hashed: ${p}`);
    return h;
  };
  const existsAll = (): boolean => true;
  const vendoredRows = (): Row[] => [
    { id: "rater-48-tests", status: "vendored", path: "fixtures/rater/48-tests/", sha256: PIN["fixtures/rater/48-tests/"]! },
    { id: "rater-504-sweep", status: "vendored", path: "fixtures/rater/504-sweep/", sha256: PIN["fixtures/rater/504-sweep/"]! },
    { id: "zone-tariff-v1", status: "vendored", path: "fixtures/tariff/", sha256: PIN["fixtures/tariff/"]! },
  ];

  it("all three vendored with matching on-disk hashes ⇒ NO problems (the gate activates and may green)", () => {
    expect(verifyParityPins(vendoredRows(), hashFn, existsAll)).toEqual([]);
  });

  it("a row left status:pending ⇒ flagged NOT vendored (present files + a pending manifest is NEVER a pass)", () => {
    // This is the exact fabrication vector: self-consistent files dropped in with the manifest still pending.
    const rows = vendoredRows();
    rows[0] = { ...rows[0]!, status: "pending" };
    const problems = verifyParityPins(rows, hashFn, existsAll);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("rater-48-tests");
    expect(problems[0]).toContain("NOT vendored");
  });

  it("a vendored row with a null sha256 ⇒ flagged unpinned (a vendored fixture must carry its hash)", () => {
    const rows = vendoredRows();
    rows[1] = { ...rows[1]!, sha256: null };
    const problems = verifyParityPins(rows, hashFn, existsAll);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("rater-504-sweep");
    expect(problems[0]).toContain("no pinned sha256");
  });

  it("on-disk bytes that don't match the pin ⇒ hash mismatch (a dropped-in synthetic set fails)", () => {
    const rows = vendoredRows();
    const tampered = (p: string): string => (p === "fixtures/tariff/" ? "d".repeat(64) : hashFn(p));
    const problems = verifyParityPins(rows, tampered, existsAll);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("zone-tariff-v1");
    expect(problems[0]).toContain("hash mismatch");
  });

  it("a vendored+pinned row whose path is missing on disk ⇒ flagged", () => {
    const rows = vendoredRows();
    const missingTariff = (p: string): boolean => p !== "fixtures/tariff/";
    const problems = verifyParityPins(rows, hashFn, missingTariff);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("zone-tariff-v1");
    expect(problems[0]).toContain("missing on disk");
  });

  it("a missing manifest row ⇒ flagged (all three parity fixtures are required)", () => {
    const rows = vendoredRows().filter((r) => r.id !== "zone-tariff-v1");
    const problems = verifyParityPins(rows, hashFn, existsAll);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("zone-tariff-v1");
    expect(problems[0]).toContain("no manifest row");
  });
});

describe("ParityCase — the vendored case format parses (and rejects a hollow PRICED case)", () => {
  it("parses a well-formed PRICED case, keeping unknown request keys (passthrough forward-compat)", () => {
    const parsed = ParityCase.parse({
      name: "with-extra-key",
      request: { origin_zip: "97201", dest_zip: "80112", weight_lb: 1_500, engine_line_ref: "v1.1:c17" },
      expect: { status: "PRICED", sell_cents: 37_500 },
    });
    expect(parsed.name).toBe("with-extra-key");
    // passthrough preserves the extra key that a real engine export might carry.
    expect((parsed.request as Record<string, unknown>).engine_line_ref).toBe("v1.1:c17");
  });

  it("rejects a PRICED case with no expected sell_cents (a hollow expect is malformed, not a pass)", () => {
    expect(() =>
      ParityCase.parse({ name: "hollow", request: { origin_zip: "1", dest_zip: "2" }, expect: { status: "PRICED" } }),
    ).toThrow();
  });
});
