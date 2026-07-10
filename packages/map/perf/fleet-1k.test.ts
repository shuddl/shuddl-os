import { describe, it, expect } from "vitest";
import { fleet1k, generateFleet } from "./fleet-1k.js";

// The 1,000-entity perf fixture (REQ-079) is the DoD's "1K entities 60fps/30fps" input. It must be
// deterministic (seeded mulberry32, NO Date.now / Math.random) so the perf harness and the canonical
// screenshots are byte-stable, CONUS-bounded, and carry the three-tier state grammar in the right
// proportions: a calm healthy majority, ~12% at-risk with varied risk kinds, and exactly ONE
// exception (the alarm is singular — REQ-077).

// Continental-US bounding box (a hair outside the generator's interior so a rounded coord still fits).
const CONUS = { minLng: -125, maxLng: -66.5, minLat: 24, maxLat: 49.5 } as const;
const RISK_KINDS = new Set(["DWELL", "ETA", "DETENTION", "HOS", "CREDIT"]);

describe("fleet1k — deterministic 1,000-entity perf fixture (REQ-079)", () => {
  it("returns exactly 1,000 entities", () => {
    expect(fleet1k()).toHaveLength(1000);
  });

  it("is byte-identical across two calls (no Date.now / Math.random)", () => {
    expect(JSON.stringify(fleet1k())).toBe(JSON.stringify(fleet1k()));
  });

  it("places every entity inside the CONUS bounding box", () => {
    for (const e of fleet1k()) {
      expect(e.lng).toBeGreaterThanOrEqual(CONUS.minLng);
      expect(e.lng).toBeLessThanOrEqual(CONUS.maxLng);
      expect(e.lat).toBeGreaterThanOrEqual(CONUS.minLat);
      expect(e.lat).toBeLessThanOrEqual(CONUS.maxLat);
    }
  });

  it("carries exactly one exception (the alarm is singular — REQ-077)", () => {
    expect(fleet1k().filter((e) => e.status === "exception")).toHaveLength(1);
  });

  it("marks ~12% at-risk, every one naming a valid, varied risk kind", () => {
    const atRisk = fleet1k().filter((e) => e.status === "at-risk");
    expect(atRisk.length).toBeGreaterThanOrEqual(80); // ≥ 8%
    expect(atRisk.length).toBeLessThanOrEqual(160); // ≤ 16%
    for (const e of atRisk) {
      expect(e.risk).toBeDefined();
      expect(RISK_KINDS.has(e.risk ?? "")).toBe(true);
    }
    const kinds = new Set(atRisk.map((e) => e.risk));
    expect(kinds.size).toBeGreaterThanOrEqual(3); // varied, not a single kind
  });

  it("leaves the calm majority healthy (the mix sums to the whole fleet)", () => {
    const items = fleet1k();
    const healthy = items.filter((e) => e.status === "healthy").length;
    const atRisk = items.filter((e) => e.status === "at-risk").length;
    const exception = items.filter((e) => e.status === "exception").length;
    expect(healthy + atRisk + exception).toBe(1000);
    expect(healthy).toBeGreaterThan(800);
  });

  it("gives every entity a heading in [0,360) and a stable string id (targets to glide toward)", () => {
    const ids = new Set<string>();
    for (const e of fleet1k()) {
      expect(e.bearing).toBeGreaterThanOrEqual(0);
      expect(e.bearing).toBeLessThan(360);
      expect(typeof e.id).toBe("string");
      ids.add(e.id);
    }
    expect(ids.size).toBe(1000); // ids are unique
  });
});

describe("generateFleet — the reusable seeded generator behind the fixture", () => {
  it("scales to any count and stays deterministic for a fixed seed", () => {
    expect(generateFleet({ count: 10, seed: 1 })).toHaveLength(10);
    expect(JSON.stringify(generateFleet({ count: 25, seed: 7 }))).toBe(
      JSON.stringify(generateFleet({ count: 25, seed: 7 })),
    );
  });

  it("produces a DIFFERENT fleet for a different seed", () => {
    expect(JSON.stringify(generateFleet({ count: 25, seed: 1 }))).not.toBe(
      JSON.stringify(generateFleet({ count: 25, seed: 2 })),
    );
  });
});
