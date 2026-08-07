import { describe, expect, it } from "vitest";
import {
  findAcceptableQuoteId,
  isPendingApproval,
  transitLine,
  unknownReasonMessage,
  type EventRow,
  type PricedQuoteResponse,
} from "./quote.js";

function priced(over: Partial<PricedQuoteResponse> = {}): PricedQuoteResponse {
  return { status: "PRICED", sell_cents: 148000, transit: { status: "unavailable" }, ...over };
}

describe("isPendingApproval (REQ-030 — a below-floor / anomalous quote is not a firm sell)", () => {
  it("is false for a firm authed sell (approval none, no anomaly)", () => {
    expect(isPendingApproval(priced({ approval: { approval: "none", approvals_required: 0, rule: null, required_role: null } }))).toBe(false);
  });

  it("is true when the server flags a below-floor approval", () => {
    expect(isPendingApproval(priced({ approval: { approval: "single", approvals_required: 1, rule: "below_target_or", required_role: "ops" } }))).toBe(true);
  });

  it("is true when a pricing anomaly rides the quote (REQ-040)", () => {
    expect(isPendingApproval(priced({ anomaly: { code: "over_per_lb", detail: "…" } }))).toBe(true);
  });

  it("is false for a guest preview that carries no approval field", () => {
    expect(isPendingApproval(priced())).toBe(false);
  });
});

describe("unknownReasonMessage (REQ-004 — honest, never a fabricated number)", () => {
  it("asks for weight/dims on missing physics", () => {
    expect(unknownReasonMessage("missing_physics")).toMatch(/weight and dimensions/i);
  });
  it("has an honest fallback for an unseen reason", () => {
    const msg = unknownReasonMessage("some_new_reason");
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).not.toMatch(/\d/); // no number is ever fabricated
  });
});

describe("findAcceptableQuoteId (accept binds to exactly the shown quote)", () => {
  const events: EventRow[] = [
    { id: "q-old", kind: "quote.priced", payload: { sell: 100000 } },
    { id: "other", kind: "agent.acted", payload: {} },
    { id: "q-new", kind: "quote.priced", payload: { sell: 148000 } },
  ];

  it("prefers the quote whose recorded sell matches the shown price", () => {
    expect(findAcceptableQuoteId(events, 148000)).toBe("q-new");
    expect(findAcceptableQuoteId(events, 100000)).toBe("q-old");
  });

  it("falls back to the newest quote.priced when no sell matches", () => {
    expect(findAcceptableQuoteId(events, 999999)).toBe("q-new");
  });

  it("returns null when there is no quote.priced at all", () => {
    expect(findAcceptableQuoteId([{ id: "x", kind: "agent.acted", payload: {} }], 1)).toBeNull();
  });
});

// REQ-059 §499 — the transit line must never fabricate a number.
//
// This was byte-identical in `QuotePanel.tsx` and `GuestQuote.tsx`, and asserted by neither: the portal's
// tests exercised the components, not the rule, so a drift in one copy would have changed what one customer
// surface promised while the other stayed green. One copy now lives here; these pin the clause that makes
// it load-bearing rather than cosmetic.
describe("REQ-059: the honest transit line", () => {
  const q = (transit: PricedQuoteResponse["transit"]) => ({ transit }) as PricedQuoteResponse;

  it("prints NO DIGIT for any status other than known — the whole point of the rule", () => {
    // Every non-"known" status, not just the one the UI happens to produce today: a new status added to the
    // contract must not silently start rendering a number.
    for (const status of ["unknown", "unavailable", "pending", "error"] as const) {
      const out = transitLine(q({ status } as PricedQuoteResponse["transit"]));
      expect(out, `status=${status} must print no number`).not.toMatch(/\d/);
      expect(out).toBe("TRANSIT UNAVAILABLE");
    }
  });

  it("renders a known count, singular and plural, and same-day as words", () => {
    expect(transitLine(q({ status: "known", business_days: 0 }))).toBe("TRANSIT · SAME BUSINESS DAY");
    expect(transitLine(q({ status: "known", business_days: 1 }))).toBe("TRANSIT · 1 BUSINESS DAY");
    expect(transitLine(q({ status: "known", business_days: 2 }))).toBe("TRANSIT · 2 BUSINESS DAYS");
  });
});
