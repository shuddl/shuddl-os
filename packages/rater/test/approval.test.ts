import { describe, expect, it } from "vitest";
import {
  assessApproval,
  evaluateApproval,
  executingShare,
  executingShareCents,
} from "../src/approval.js";
import type { ApprovalDecision, Leg } from "../src/approval.js";
import type { Floors } from "../src/floors.js";
import type { PricedQuote } from "../src/price.js";

// REQ-048 / REQ-040: the approval matrix (below-target ⇒ single named approval; below-contribution LOSS ⇒
// DUAL) compares the EXECUTING SHARE under interline, else the quoted/proposed sell — NEVER the gross under
// interline (CLAUDE.md Law 5, permanent; the guard against the $222,084 / 35-lb anomaly). Hand-computed
// known-answer tests; every cent is auditable. Because this WP's cost basis = freight, a LIST sell is
// always ≥ target — so the matrix is exercised with a DISCOUNTED proposed sell and an INTERLINE share, the
// only two ways a below-floor figure actually arises.

// A well-ordered floor ladder with round numbers (contribution ≤ full ≤ target). Not tied to any config —
// these are the floors a PricedQuote would already carry.
const floors: Floors = { contribution: 10_000, full: 11_000, target: 12_000 };

// A minimal PricedQuote-shaped fixture with KNOWN floors and a list sell. The approval logic reads only
// `floors` and (as a default) `sell_cents`; the other fields are carried for shape completeness.
function makeQuote(overrides?: { floors?: Floors; sell_cents?: number }): PricedQuote {
  return {
    status: "PRICED",
    sell_cents: overrides?.sell_cents ?? 15_000, // list sell, above target by construction
    lines: [{ kind: "freight", code: "freight", amount_cents: 12_000 }],
    floors: overrides?.floors ?? floors,
    cost_cents: 12_000,
    versions: { rate_config_ids: ["zt-test@2026.07"] },
    basis: {},
  };
}

describe("evaluateApproval — THE MATRIX (REQ-048): none / single / dual by floor band", () => {
  it("sell ≥ target ⇒ none (no approval, no rule/role)", () => {
    expect(evaluateApproval(15_000, floors)).toEqual({
      approval: "none",
      approvals_required: 0,
      rule: null,
      required_role: null,
    });
  });

  it("sell exactly = target ⇒ none (boundary: target is inclusive)", () => {
    expect(evaluateApproval(12_000, floors)).toEqual({
      approval: "none",
      approvals_required: 0,
      rule: null,
      required_role: null,
    });
  });

  it("contribution ≤ sell < target ⇒ single (below_target_or / ops / 1)", () => {
    expect(evaluateApproval(11_000, floors)).toEqual({
      approval: "single",
      approvals_required: 1,
      rule: "below_target_or",
      required_role: "ops",
    });
  });

  it("sell exactly = contribution ⇒ single (boundary: contribution is inclusive, still covers it)", () => {
    expect(evaluateApproval(10_000, floors)).toEqual({
      approval: "single",
      approvals_required: 1,
      rule: "below_target_or",
      required_role: "ops",
    });
  });

  it("sell < contribution ⇒ dual LOSS (below_contribution_loss / finance / 2)", () => {
    expect(evaluateApproval(9_999, floors)).toEqual({
      approval: "dual",
      approvals_required: 2,
      rule: "below_contribution_loss",
      required_role: "finance",
    });
  });

  it("guards: a negative or non-integer compared figure throws (no price on air)", () => {
    expect(() => evaluateApproval(-1, floors)).toThrow();
    expect(() => evaluateApproval(1.5, floors)).toThrow();
    expect(() => evaluateApproval(Number.NaN, floors)).toThrow();
  });
});

describe("assessApproval — DIRECT with a DISCOUNTED proposed sell (the matrix actually bites)", () => {
  it("no opts ⇒ compares the list sell (≥ target ⇒ none), share bps null", () => {
    const r = assessApproval(makeQuote());
    expect(r.approval).toBe("none");
    expect(r.evaluated_sell_cents).toBe(15_000);
    expect(r.gross_sell_cents).toBe(15_000);
    expect(r.executing_share_bps).toBeNull();
  });

  it("proposed sell below target ⇒ single (the rep negotiated under the target-OR floor)", () => {
    const r = assessApproval(makeQuote(), { proposedSellCents: 11_000 });
    expect(r).toEqual<ApprovalDecision>({
      approval: "single",
      approvals_required: 1,
      rule: "below_target_or",
      required_role: "ops",
      evaluated_sell_cents: 11_000,
      gross_sell_cents: 11_000,
      executing_share_bps: null,
    });
  });

  it("proposed sell below contribution ⇒ dual LOSS", () => {
    const r = assessApproval(makeQuote(), { proposedSellCents: 5_000 });
    expect(r).toEqual<ApprovalDecision>({
      approval: "dual",
      approvals_required: 2,
      rule: "below_contribution_loss",
      required_role: "finance",
      evaluated_sell_cents: 5_000,
      gross_sell_cents: 5_000,
      executing_share_bps: null,
    });
  });
});

describe("assessApproval — INTERLINE: compare the EXECUTING SHARE, never gross (REQ-040 anti-$222K)", () => {
  // Floors on the FULL move; the tenant executes only 30% of the revenue.
  const interlineFloors: Floors = { contribution: 18_000, full: 19_000, target: 20_000 };
  // Gross clears the target floor outright (would be `none` on gross). The tenant ("carrier-0") executes
  // one 30% leg; a partner executes the other 70%. Tenant share = 50000 * 3000 / 10000 = 15000 < 18000.
  const gross = 50_000;
  const legs: readonly Leg[] = [
    { kind: "delivery", executor: "carrier-0", split_bps: 3_000 },
    { kind: "linehaul", executor: "carrier-x", split_bps: 7_000 },
  ];

  it("the tenant's 30% share falls below contribution ⇒ DUAL, on the share not the gross", () => {
    const quote = makeQuote({ floors: interlineFloors, sell_cents: gross });
    const r = assessApproval(quote, { legs, tenantParty: "carrier-0" });
    expect(r.approval).toBe("dual");
    expect(r.rule).toBe("below_contribution_loss");
    expect(r.required_role).toBe("finance");
    expect(r.approvals_required).toBe(2);
    expect(r.executing_share_bps).toBe(3_000);
    expect(r.evaluated_sell_cents).toBe(15_000); // the tenant's revenue share
    expect(r.gross_sell_cents).toBe(50_000); // the full gross, carried for audit, NEVER compared
  });

  it("PROOF the executing-share rule changed the outcome: gross alone would have been `none` (REQ-040)", () => {
    // Had the matrix (wrongly) used the gross, 50000 ≥ target 20000 ⇒ none. The share rule flips it to dual.
    expect(evaluateApproval(gross, interlineFloors).approval).toBe("none");
    const r = assessApproval(makeQuote({ floors: interlineFloors, sell_cents: gross }), {
      legs,
      tenantParty: "carrier-0",
    });
    expect(r.approval).toBe("dual");
    expect(r.approval).not.toBe(evaluateApproval(gross, interlineFloors).approval);
  });

  it("a DISCOUNTED proposed sell prorates too: the share is taken from the proposed, not the list, sell", () => {
    // proposed 40000 instead of the 50000 list ⇒ share 40000*3000/10000 = 12000, still < contribution 18000.
    const r = assessApproval(makeQuote({ floors: interlineFloors, sell_cents: gross }), {
      proposedSellCents: 40_000,
      legs,
      tenantParty: "carrier-0",
    });
    expect(r.evaluated_sell_cents).toBe(12_000);
    expect(r.gross_sell_cents).toBe(40_000);
    expect(r.approval).toBe("dual");
  });

  it("a share landing in the SINGLE band (contribution ≤ share < target) ⇒ single", () => {
    // gross 63000, tenant 3000 bps ⇒ share 63000*3000/10000 = 18900; 18000 ≤ 18900 < 20000 ⇒ single.
    const r = assessApproval(makeQuote({ floors: interlineFloors, sell_cents: 63_000 }), {
      legs,
      tenantParty: "carrier-0",
    });
    expect(r.approval).toBe("single");
    expect(r.rule).toBe("below_target_or");
    expect(r.required_role).toBe("ops");
    expect(r.approvals_required).toBe(1);
    expect(r.evaluated_sell_cents).toBe(18_900);
    expect(r.executing_share_bps).toBe(3_000);
    expect(r.gross_sell_cents).toBe(63_000);
  });

  it("sums MULTIPLE tenant legs through assessApproval (the audit executing_share_bps path)", () => {
    // carrier-0 executes two legs (2000 + 1000 = 3000 bps); the audited share bps must be the SUM, and the
    // compared share must be pro-rated from that same sum — single-sourced, never a separate recomputation.
    const multi: readonly Leg[] = [
      { kind: "pickup", executor: "carrier-0", split_bps: 2_000 },
      { kind: "delivery", executor: "carrier-0", split_bps: 1_000 },
      { kind: "linehaul", executor: "carrier-x", split_bps: 7_000 },
    ];
    const r = assessApproval(makeQuote({ floors: interlineFloors, sell_cents: gross }), {
      legs: multi,
      tenantParty: "carrier-0",
    });
    expect(r.executing_share_bps).toBe(3_000); // 2000 + 1000
    expect(r.evaluated_sell_cents).toBe(15_000); // 50000 * 3000 / 10000
    expect(r.approval).toBe("dual"); // 15000 < contribution 18000
  });

  it("PARTIAL interline input FAILS LOUD — legs without tenantParty (never falls through to gross)", () => {
    const quote = makeQuote({ floors: interlineFloors, sell_cents: gross });
    expect(() => assessApproval(quote, { legs })).toThrow(/tenantParty|REQ-040/i);
  });

  it("PARTIAL interline input FAILS LOUD — tenantParty without legs", () => {
    const quote = makeQuote({ floors: interlineFloors, sell_cents: gross });
    expect(() => assessApproval(quote, { tenantParty: "carrier-0" })).toThrow(/legs|REQ-040/i);
  });

  it("PARTIAL interline input FAILS LOUD — EMPTY legs with a tenantParty (empty ⇒ not provided)", () => {
    const quote = makeQuote({ floors: interlineFloors, sell_cents: gross });
    expect(() => assessApproval(quote, { legs: [], tenantParty: "carrier-0" })).toThrow(/legs|REQ-040/i);
  });
});

describe("executingShareCents — the tenant's revenue share, with the split=10000 guard (REQ-040)", () => {
  const legs: readonly Leg[] = [
    { kind: "delivery", executor: "carrier-0", split_bps: 3_000 },
    { kind: "linehaul", executor: "carrier-x", split_bps: 7_000 },
  ];

  it("computes the correct share for the tenant's legs", () => {
    expect(executingShareCents(50_000, legs, "carrier-0")).toBe(15_000); // 50000 * 3000 / 10000
    expect(executingShareCents(50_000, legs, "carrier-x")).toBe(35_000); // 50000 * 7000 / 10000
  });

  it("executingShare returns BOTH the share cents and the bps it was derived from (single source)", () => {
    expect(executingShare(50_000, legs, "carrier-0")).toEqual({ shareCents: 15_000, tenantBps: 3_000 });
    // the cents wrapper is exactly executingShare(...).shareCents — they can never diverge.
    expect(executingShareCents(50_000, legs, "carrier-0")).toBe(
      executingShare(50_000, legs, "carrier-0").shareCents,
    );
  });

  it("sums MULTIPLE tenant legs before prorating", () => {
    const multi: readonly Leg[] = [
      { kind: "pickup", executor: "carrier-0", split_bps: 2_000 },
      { kind: "delivery", executor: "carrier-0", split_bps: 1_000 },
      { kind: "linehaul", executor: "carrier-x", split_bps: 7_000 },
    ];
    expect(executingShareCents(50_000, multi, "carrier-0")).toBe(15_000); // (2000+1000) of 50000
  });

  it("rounds the share half-up (BigInt-safe): 12345 * 3000 / 10000 = 3703.5 → 3704", () => {
    expect(executingShareCents(12_345, legs, "carrier-0")).toBe(3_704);
  });

  it("a split set that does NOT total 10000 ⇒ THROWS (malformed interline, never misprice)", () => {
    const bad: readonly Leg[] = [
      { kind: "delivery", executor: "carrier-0", split_bps: 3_000 },
      { kind: "linehaul", executor: "carrier-x", split_bps: 6_000 }, // totals 9000, not 10000
    ];
    expect(() => executingShareCents(50_000, bad, "carrier-0")).toThrow(/10000|total|malformed/i);
  });

  it("an over-100% split set ⇒ THROWS too", () => {
    const over: readonly Leg[] = [
      { kind: "delivery", executor: "carrier-0", split_bps: 4_000 },
      { kind: "linehaul", executor: "carrier-x", split_bps: 7_000 }, // totals 11000
    ];
    expect(() => executingShareCents(50_000, over, "carrier-0")).toThrow(/10000|total|malformed/i);
  });

  it("a tenant that executes NO legs ⇒ share 0 (split still valid at 10000)", () => {
    expect(executingShareCents(50_000, legs, "carrier-nobody")).toBe(0);
  });

  it("guards a negative/non-integer gross", () => {
    expect(() => executingShareCents(-1, legs, "carrier-0")).toThrow();
    expect(() => executingShareCents(1.5, legs, "carrier-0")).toThrow();
  });
});
