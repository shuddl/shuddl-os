import { z } from "zod";
import { SafeInt, JsonObject } from "./json.js";

// Money is signed cents; basis points are 0..10000. Both are branded so a raw number
// cannot be passed where the ledger expects a validated monetary/ratio value.
export const Cents = SafeInt.min(-999_999_999_999).max(999_999_999_999).brand<"Cents">();
export type Cents = z.infer<typeof Cents>;

export const Bps = SafeInt.min(0).max(10_000).brand<"Bps">();
export type Bps = z.infer<typeof Bps>;

// A single AR/AP invoice line as carried on the event payload. The money projection
// (Task 11) turns each of these into a money_lines row.
// I7: amount_cents is NON-NEGATIVE. An invoice line is a positive charge; a discount/credit is its own
// line kind, never negative freight. A negative line would escape the reversal projection's (and the
// sequencer's #moneyDeps') `amount_cents > 0` filter, so a void (empty reissue) would fail to reverse
// it and leave AR misstated. Mirrors the SplitComputedPayload.total_cents non-negative narrowing.
export const InvoiceLine = z
  .object({
    line_no: SafeInt.min(1),
    kind: z.enum(["freight", "fsc", "accessorial", "cod_collect", "credit_purchase"]),
    amount_cents: Cents.refine((c) => c >= 0, "invoice line amount_cents must be non-negative (I7: a line is a positive charge)"),
    gl_map: z.string().min(1),
  })
  .strict();
export type InvoiceLine = z.infer<typeof InvoiceLine>;

export const InvoiceIssuedPayload = z
  .object({
    invoice_id: z.string().min(1),
    party_id: z.string().min(1),
    division: z.string().min(1),
    lines: z.array(InvoiceLine).min(1),
  })
  .strict();
export type InvoiceIssuedPayload = z.infer<typeof InvoiceIssuedPayload>;

// I7 reversal semantics: a correction names the event it corrects and carries the
// reissue lines. An EMPTY reissue_lines array is a void (full reversal, no reissue).
export const InvoiceCorrectedPayload = z
  .object({
    invoice_id: z.string().min(1),
    corrects_event_id: z.string().min(1),
    reason: z.string().min(1),
    reissue_lines: z.array(InvoiceLine),
  })
  .strict();
export type InvoiceCorrectedPayload = z.infer<typeof InvoiceCorrectedPayload>;

export const SplitAllocation = z
  .object({ party_id: z.string().min(1), share_bps: Bps })
  .strict();
export type SplitAllocation = z.infer<typeof SplitAllocation>;

// Interline splits must allocate the whole pie: shares sum to exactly 10000 bps.
// REQ-019: the gross being apportioned is NON-NEGATIVE — a split divides gross revenue among the
// executing carriers, so a negative gross is meaningless. Corrections negate their own lines exactly
// (see invoice.corrected); they never re-allocate a negative gross. Narrowing this here also removes
// the only path by which a negative total_cents could reach allocateCents (defense in depth).
export const SplitComputedPayload = z
  .object({
    total_cents: Cents.refine((c) => c >= 0, "interline split gross must be non-negative (REQ-019)"),
    allocations: z.array(SplitAllocation).min(1),
  })
  .strict()
  .refine(
    (p) => p.allocations.reduce((sum, a) => sum + a.share_bps, 0) === 10_000,
    "split allocations must sum to exactly 10000 bps",
  );
export type SplitComputedPayload = z.infer<typeof SplitComputedPayload>;

// basis is a free-form (integer-only) object retained for money payloads that reference
// the rating basis without a typed schema yet.
export const MoneyBasis = JsonObject;
