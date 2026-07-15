import { describe, expect, it } from "vitest";
import { ZoneTariff, TransitMatrix } from "@shuddl/contracts";
import { resolveTransitDays } from "../src/index.js";

// REQ-059 — the HONEST transit window. resolveTransitDays is PURE and deterministic: it resolves BOTH zips
// to zones via the SAME longest-prefix matchZone the freight engine uses (one zone-resolution truth), then
// looks up days[originZone][destZone], falling back to default_days. THE HONEST-WINDOW LAW: an unresolvable
// lane returns UNKNOWN — NEVER a fabricated number. These are hand-checked known-answer tests.

// zip_to_zone: "800"→Z4, "8011"→ZA (the LONGER prefix wins for 8011x), "970"→Z1. rate_groups are a valid
// minimum (unused by the resolver — it only reads zip_to_zone). A zone (ZB) exists that the matrix omits.
const tariff = ZoneTariff.parse({
  kind: "zone_tariff",
  id: "zt-transit",
  version: "2026.07-t",
  zip_to_zone: { "800": "Z4", "8011": "ZA", "970": "Z1" },
  rate_groups: [
    { id: "grp", zones: ["Z1", "Z4", "ZA"], breaks: [{ min_lb: 0, cwt_cents: 5000 }], min_charge_cents: 0 },
  ],
});

// days: ZA→Z1 = 2, Z4→Z1 = 4; default 7. Note ZA has NO ZA→Z4 lane (inner-record miss → default).
const matrix = TransitMatrix.parse({
  kind: "transit_matrix",
  id: "tm-transit",
  version: "2026.07-t",
  days: { ZA: { Z1: 2 }, Z4: { Z1: 4 } },
  default_days: 7,
});

// The same matrix WITHOUT a default — an unlisted lane must then resolve UNKNOWN, never a guess.
const matrixNoDefault = TransitMatrix.parse({
  kind: "transit_matrix",
  id: "tm-nodefault",
  version: "2026.07-t",
  days: { ZA: { Z1: 2 } },
});

describe("resolveTransitDays — known lanes (zone×zone lookup)", () => {
  it("a known lane returns the PINNED days for that origin×dest zone", () => {
    // origin 97005 → Z1, dest ... wait: days[Z1] is absent → use a Z4→Z1 lane. origin 80055 → Z4, dest 97005 → Z1.
    expect(resolveTransitDays("80055", "97005", matrix, tariff)).toEqual({ status: "KNOWN", days: 4 });
  });

  it("resolves BOTH zips via the SAME longest-prefix matchZone (origin 80115 → ZA, not Z4)", () => {
    // 80115 matches both "800"→Z4 and "8011"→ZA; the LONGER prefix (ZA) must win, giving days[ZA][Z1]=2
    // (a naive "800" match would wrongly give days[Z4][Z1]=4). This proves origin uses the rater's resolver.
    expect(resolveTransitDays("80115", "97005", matrix, tariff)).toEqual({ status: "KNOWN", days: 2 });
  });
});

describe("resolveTransitDays — default fallback (an unlisted lane WITH a default)", () => {
  it("an unlisted lane falls back to default_days (origin zone present, dest lane absent)", () => {
    // origin 80115 → ZA; dest 80055 → Z4. days[ZA] has no Z4 entry → default_days = 7.
    expect(resolveTransitDays("80115", "80055", matrix, tariff)).toEqual({ status: "KNOWN", days: 7 });
  });

  it("an origin zone entirely absent from the matrix also falls back to the default", () => {
    // origin 97005 → Z1; days has no Z1 key at all → default 7.
    expect(resolveTransitDays("97005", "80055", matrix, tariff)).toEqual({ status: "KNOWN", days: 7 });
  });
});

describe("resolveTransitDays — UNKNOWN (the honest-window law: never a fabricated number)", () => {
  it("an unlisted lane with NO default_days resolves UNKNOWN, not a guess", () => {
    // origin 80055 → Z4; matrixNoDefault has no Z4 key AND no default → UNKNOWN.
    expect(resolveTransitDays("80055", "97005", matrixNoDefault, tariff)).toEqual({ status: "UNKNOWN" });
  });

  it("a dest zip that resolves to NO zone → UNKNOWN (unserved lane, no window)", () => {
    expect(resolveTransitDays("80115", "99999", matrix, tariff)).toEqual({ status: "UNKNOWN" });
  });

  it("an origin zip that resolves to NO zone → UNKNOWN", () => {
    expect(resolveTransitDays("11111", "97005", matrix, tariff)).toEqual({ status: "UNKNOWN" });
  });
});

describe("resolveTransitDays — determinism + integer purity", () => {
  it("same inputs → identical result (pure, no Date/random/I/O)", () => {
    const a = resolveTransitDays("80115", "97005", matrix, tariff);
    const b = resolveTransitDays("80115", "97005", matrix, tariff);
    expect(a).toEqual(b);
  });

  it("a KNOWN result carries a whole-number day count", () => {
    const r = resolveTransitDays("80115", "97005", matrix, tariff);
    expect(r.status).toBe("KNOWN");
    if (r.status !== "KNOWN") return;
    expect(Number.isInteger(r.days)).toBe(true);
  });
});
