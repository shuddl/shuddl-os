import { describe, expect, it } from "vitest";
import {
  findAcceptableQuoteId,
  isPendingApproval,
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
