import { describe, expect, it } from "vitest";
import { InvoiceLine, InvoiceIssuedPayload } from "../src/money.js";

// WP-02 exit audit (REQ-119) — the swarm's I7 Major: `invoice.issued` with a NEGATIVE line (e.g.
// +10000 / -3000) could be issued, but the projection + the sequencer's #moneyDeps reverse only
// `amount_cents > 0` originals, so a void (empty reissue) left AR = -3000 instead of 0 — AR misstated
// "to the penny" (I7). The cheap correct fix: an invoice line is a non-negative charge; discounts /
// credits are their own line kinds, never negative freight. Mirrors SplitComputedPayload.total_cents.
describe("Exit audit (REQ-119) I7: an invoice line amount is non-negative at the Zod boundary", () => {
  const base = { line_no: 1, kind: "freight" as const, gl_map: "4000-REV" };
  it("accepts a positive amount_cents", () => {
    expect(InvoiceLine.parse({ ...base, amount_cents: 10_000 }).amount_cents).toBe(10_000);
  });
  it("accepts zero (a zero-cent money_line is separately blocked by CHECK(amount_cents != 0))", () => {
    expect(InvoiceLine.parse({ ...base, amount_cents: 0 }).amount_cents).toBe(0);
  });
  it("REJECTS a negative amount_cents (a negative line escapes the >0 reversal filter → void leaves AR ≠ 0)", () => {
    expect(() => InvoiceLine.parse({ ...base, amount_cents: -3_000 })).toThrow();
  });
  it("rejects a negative line nested inside InvoiceIssuedPayload", () => {
    expect(() =>
      InvoiceIssuedPayload.parse({
        invoice_id: "inv-1",
        party_id: "party-bill",
        division: "main",
        lines: [
          { ...base, amount_cents: 10_000 },
          { line_no: 2, kind: "accessorial", amount_cents: -3_000, gl_map: "4200-ACC" },
        ],
      }),
    ).toThrow();
  });
  it("still accepts an all-positive InvoiceIssuedPayload (the shipped fixture stays valid)", () => {
    const ok = InvoiceIssuedPayload.parse({
      invoice_id: "inv-1",
      party_id: "party-bill",
      division: "main",
      lines: [{ line_no: 1, kind: "freight", amount_cents: 120_000, gl_map: "4000-REV" }],
    });
    expect(ok.lines[0]?.amount_cents).toBe(120_000);
  });
});
