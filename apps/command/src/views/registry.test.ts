import { describe, expect, it } from "vitest";
import { CANONICAL_VIEWS, KPI_DRILL_VIEW, MAX_CANONICAL_VIEWS, assertViewBudget, kpiFormat, kpiScale } from "./registry.js";

// WP-10 Task 12 (REQ-084) — the ≤12-canonical-view budget is a HARD invariant. The command surface organizes
// EXISTING views (genesis/10); it never invents a 13th (no report builder). The ⌘K copilot is the "+copilot"
// surface and is deliberately NOT in this list.
describe("canonical view budget (REQ-084)", () => {
  it("stays within the 12-view budget and never invents a 13th", () => {
    expect(CANONICAL_VIEWS.length).toBeLessThanOrEqual(MAX_CANONICAL_VIEWS);
    expect(() => assertViewBudget()).not.toThrow();
  });

  it("names are unique (no accidental duplicate that hides an over-budget add)", () => {
    expect(new Set(CANONICAL_VIEWS).size).toBe(CANONICAL_VIEWS.length);
  });

  it("every KPI metric drills to a real canonical view (never a fabricated destination)", () => {
    for (const view of Object.values(KPI_DRILL_VIEW)) {
      expect(CANONICAL_VIEWS).toContain(view);
    }
  });
});

// The KPI presentation law: money is integer cents, a percentage is whole (bps→percent), never a fabricated value.
describe("KPI formatting (REQ-083)", () => {
  it("scales bps to a whole percent and leaves other units as-is", () => {
    expect(kpiScale("bps", 9800)).toBe(98);
    expect(kpiScale("cents", 250000)).toBe(250000);
    expect(kpiScale("days", 38)).toBe(38);
  });

  it("formats each unit honestly (integer-cents money, whole percent, minutes, days, count)", () => {
    expect(kpiFormat("count")(3)).toBe("3");
    expect(kpiFormat("bps")(98)).toBe("98%");
    expect(kpiFormat("min")(47)).toBe("47M");
    expect(kpiFormat("cents")(250000)).toBe("$2,500.00");
    expect(kpiFormat("days")(38)).toBe("38D");
  });
});
