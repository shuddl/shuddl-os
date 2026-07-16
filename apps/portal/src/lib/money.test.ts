import { describe, expect, it } from "vitest";
import { formatCents } from "./money.js";

describe("formatCents (REQ-085 — integer-cents money, no float math)", () => {
  it("formats whole dollars with a two-digit cent remainder", () => {
    expect(formatCents(148000)).toBe("$1,480.00");
    expect(formatCents(224000)).toBe("$2,240.00");
  });

  it("keeps the exact cent remainder", () => {
    expect(formatCents(148099)).toBe("$1,480.99");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(0)).toBe("$0.00");
  });

  it("groups thousands", () => {
    expect(formatCents(123456789)).toBe("$1,234,567.89");
  });

  it("preserves a negative (a credit/reversal line)", () => {
    expect(formatCents(-2500)).toBe("-$25.00");
  });
});
