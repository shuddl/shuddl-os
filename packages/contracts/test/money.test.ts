import { describe, expect, it } from "vitest";
import { InvoiceLine, InvoiceIssuedPayload, InvoiceCorrectedPayload, SplitComputedPayload } from "../src/money.js";

// WP-02 exit audit (REQ-119) — the swarm's I7 Major: `invoice.issued` with a NEGATIVE line (e.g.
// +10000 / -3000) could be issued, but the projection + the sequencer's #moneyDeps reverse only
// `amount_cents > 0` originals, so a void (empty reissue) left AR = -3000 instead of 0 — AR misstated
// "to the penny" (I7). The cheap correct fix: an invoice line is a POSITIVE charge; discounts /
// credits are their own line kinds, never a zero/negative freight line. Mirrors SplitComputedPayload.
//
// WP-06 exit audit (REQ-119): the boundary was `>= 0`, but the D1 money_lines carries CHECK(amount_cents
// != 0), so a ZERO line parsed clean HERE then POISONED projectMoneyLines (throw → DLQ). Tightened to
// `>= 1` so a zero line is unrecordable at the boundary — fail LOUD, never a silent poison downstream.
describe("Exit audit (REQ-119) I7: an invoice line amount is a POSITIVE charge at the Zod boundary", () => {
  const base = { line_no: 1, kind: "freight" as const, gl_map: "4000-REV" };
  it("accepts a positive amount_cents", () => {
    expect(InvoiceLine.parse({ ...base, amount_cents: 10_000 }).amount_cents).toBe(10_000);
  });
  it("REJECTS zero (a zero line poisons projectMoneyLines via money_lines CHECK(amount_cents != 0) → DLQ)", () => {
    expect(() => InvoiceLine.parse({ ...base, amount_cents: 0 })).toThrow();
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

// §913 — REQ-019: AN INTERLINE SPLIT MUST ALLOCATE THE WHOLE PIE.
//
// `SplitComputedPayload`'s sum-to-10000-bps refine was UNTESTED: neutralising it left all 318 contracts
// tests green. Found by mutating every refine site in the package rather than by reading, because a rule
// nobody exercises looks exactly like a rule nobody needed.
//
// It is the rule that keeps interline money whole. A short split leaves cents unapportioned; an over-
// allocated one hands out more than the gross. Both mis-state what each carrier is owed, which is the
// same class of defect as the $222,084/35-lb anomaly the executing-share floor exists to prevent.
//
// The bad sums are built from individually VALID shares (5000+4999, 5000+5001). Bps is capped at 10000,
// so a single 10001 share would be refused by Bps.max — a refusal that proves nothing about this refine
// (§906: the fixture must isolate the rule under test).
describe("REQ-019: an interline split allocates exactly 10000 bps — no more, no less", () => {
  const base = { total_cents: 120_000 };
  const alloc = (...bps: number[]) => bps.map((share_bps, i) => ({ party_id: `party-${i}`, share_bps }));

  it("accepts a split summing to exactly 10000 bps (the control)", () => {
    const ok = SplitComputedPayload.parse({ ...base, allocations: alloc(6_000, 4_000) });
    expect(ok.allocations.reduce((s, a) => s + a.share_bps, 0)).toBe(10_000);
  });
  it("REJECTS a SHORT split (9999) — cents left unapportioned between carriers", () => {
    expect(() => SplitComputedPayload.parse({ ...base, allocations: alloc(5_000, 4_999) })).toThrow(/sum to exactly 10000/);
  });
  it("REJECTS an OVER-allocated split (10001) — more than the gross handed out", () => {
    expect(() => SplitComputedPayload.parse({ ...base, allocations: alloc(5_000, 5_001) })).toThrow(/sum to exactly 10000/);
  });
  it("REJECTS a single allocation that does not take the whole pie", () => {
    expect(() => SplitComputedPayload.parse({ ...base, allocations: alloc(9_999) })).toThrow(/sum to exactly 10000/);
  });
});

// §1532 — THE CORRECTION'S STATED REASON is operator free text on the MONEY path, stored in an append-only
// event an auditor reads back. It was `z.string().min(1)` with no ceiling — the same shape as the OSD note
// and `from_ref`, and the same 2,048 human-scale bound `MessageReceivedPayload.subject` already carries.
// MEASURED at §1532: dropping the bound left contracts green, so the ceiling was a comment until this case.
describe("§1532 InvoiceCorrectedPayload — the reason is bounded (append-only operator text)", () => {
  const base = {
    invoice_id: "INV-1",
    corrects_event_id: "evt-1",
    reissue_lines: [{ line_no: 1, kind: "freight" as const, amount_cents: 1_000, gl_map: "4000-FREIGHT" }],
  };
  it("rejects an over-length reason, accepts one at the ceiling, and still rejects an empty one", () => {
    expect(() => InvoiceCorrectedPayload.parse({ ...base, reason: "x".repeat(2_049) })).toThrow();
    expect(InvoiceCorrectedPayload.parse({ ...base, reason: "x".repeat(2_048) }).reason).toHaveLength(2_048);
    expect(() => InvoiceCorrectedPayload.parse({ ...base, reason: "" })).toThrow();
    expect(InvoiceCorrectedPayload.parse({ ...base, reason: "duplicate accessorial" }).reason).toBe("duplicate accessorial");
  });
});
