import { describe, expect, it } from "vitest";
import { FloorsConfig } from "@shuddl/contracts";
import { computeFloors } from "../src/floors.js";
import type { Floors } from "../src/floors.js";

// REQ-027: every priced result carries its three floors. These are HAND-COMPUTED known-answer tests for
// computeFloors — each floor is round_half_up(cost × bps / 10000) via the shared mulDivHalfUp, so every
// cent below is auditable. The floor LADDER (contribution ≤ full ≤ target) must hold on the RESULT; a
// misordered FloorsConfig must fail LOUDLY (a non-monotonic ladder would break the approval matrix).

// A well-ordered floors config parsed through the Task-1 schema (computeFloors is only ever fed a valid
// config): contribution 85% ≤ full 92% ≤ target 98%.
const floors = FloorsConfig.parse({
  kind: "floors",
  id: "fl-test",
  version: "2026.07",
  contribution_bps: 8_500,
  full_cost_bps: 9_200,
  target_or_bps: 9_800,
});

describe("computeFloors — three floors as fractions of the cost basis (REQ-027)", () => {
  it("exact case: cost 100000, bps 8500/9200/9800 ⇒ 85000/92000/98000, ladder holds", () => {
    // 100000 * 8500 / 10000 = 85000; * 9200 = 92000; * 9800 = 98000 (all exact, no rounding).
    const r = computeFloors(100_000, floors);
    expect(r).toEqual<Floors>({ contribution: 85_000, full: 92_000, target: 98_000 });
    expect(r.contribution).toBeLessThanOrEqual(r.full);
    expect(r.full).toBeLessThanOrEqual(r.target);
  });

  it("rounds each floor half-up (round_half_up(cost × bps / 10000)): cost 12345", () => {
    // 12345 * 8500 / 10000 = 10493.25 → 10493
    // 12345 * 9200 / 10000 = 11357.40 → 11357
    // 12345 * 9800 / 10000 = 12098.10 → 12098
    const r = computeFloors(12_345, floors);
    expect(r).toEqual<Floors>({ contribution: 10_493, full: 11_357, target: 12_098 });
    expect(r.contribution).toBeLessThanOrEqual(r.full);
    expect(r.full).toBeLessThanOrEqual(r.target);
  });

  it("cost 0 ⇒ all floors 0 (a zero cost basis still yields a valid, monotonic ladder)", () => {
    const r = computeFloors(0, floors);
    expect(r).toEqual<Floors>({ contribution: 0, full: 0, target: 0 });
  });
});

describe("computeFloors — a misordered FloorsConfig fails loudly (never emits an unusable ladder)", () => {
  it("contribution_bps > target_or_bps ⇒ THROWS (ladder not monotonic)", () => {
    // A schema-valid but MISCONFIGURED floors: contribution 99% > full 92% > target 85%.
    const bad = FloorsConfig.parse({
      kind: "floors",
      id: "fl-bad",
      version: "2026.07",
      contribution_bps: 9_900,
      full_cost_bps: 9_200,
      target_or_bps: 8_500,
    });
    // cost 100000: contribution 99000 > full 92000 > target 85000 → out of order → throw.
    expect(() => computeFloors(100_000, bad)).toThrow(/monoton|ladder|contribution/i);
  });

  it("only full is out of order (contribution ≤ target but full > target) ⇒ THROWS", () => {
    const bad = FloorsConfig.parse({
      kind: "floors",
      id: "fl-bad2",
      version: "2026.07",
      contribution_bps: 8_000,
      full_cost_bps: 9_900,
      target_or_bps: 9_000,
    });
    expect(() => computeFloors(100_000, bad)).toThrow(/monoton|ladder|full/i);
  });
});

describe("computeFloors — costCents guard (non-negative integer, fails loudly)", () => {
  it("rejects a non-integer cost", () => {
    expect(() => computeFloors(1.5, floors)).toThrow();
  });
  it("rejects a negative cost", () => {
    expect(() => computeFloors(-1, floors)).toThrow();
  });
  it("rejects NaN", () => {
    expect(() => computeFloors(Number.NaN, floors)).toThrow();
  });
});
