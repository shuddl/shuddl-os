import { describe, expect, it } from "vitest";
import { parseRegister } from "./register.js";
import { checkPrText } from "./check-pr.js";
import { findOrphans } from "./orphans.js";

describe("register parser", () => {
  it("parses all rows of genesis/09 with exactly 8 fields each (no silent drops)", () => {
    const rows = parseRegister();
    expect(rows.length).toBeGreaterThanOrEqual(167); // append-only: the register grows, never shrinks (167 at WP-01 start)
    expect(rows[0]?.req_id).toBe("REQ-001");
  });
});

describe("REQ-118: PR gate", () => {
  it("DoD: a dummy PR without a REQ-ID fails", () => {
    const r = checkPrText("Adds a thing. No requirement referenced.");
    expect(r.ok).toBe(false);
  });
  it("passes with a valid REQ-ID", () => {
    expect(checkPrText("## REQ-IDs\nREQ-118").ok).toBe(true);
  });
  it("fails on a REQ-ID that is not in the register", () => {
    const r = checkPrText("REQ-999 does not exist");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("REQ-999");
  });
});

describe("REQ-118: orphan detector, both directions", () => {
  it("direction A: an active-WP REQ with no annotation anywhere is an orphan", () => {
    const orphans = findOrphans({ activeWps: ["WP-01"], sourceAnnotations: new Set(["REQ-118"]) });
    expect(orphans.specdButUnbuilt.length).toBeGreaterThan(0);
    expect(orphans.specdButUnbuilt).toContain("REQ-025");
  });
  it("direction B: an annotation citing an unregistered REQ is an orphan", () => {
    const orphans = findOrphans({ activeWps: [], sourceAnnotations: new Set(["REQ-999"]) });
    expect(orphans.builtButUnspecd).toContain("REQ-999");
  });
});
