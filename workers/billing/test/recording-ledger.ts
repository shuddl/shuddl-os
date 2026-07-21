import type { EventInput } from "@shuddl/contracts";
import type { PlatformLedger } from "../src/platform-ledger.js";

// A RECORDING PlatformLedger that FAITHFULLY MODELS the api sequencer's two contracts the billing emitter depends
// on, so the emitter (credits.ts) is proven in isolation WITHOUT the real cross-worker sequencer:
//   · id-dedup — the sequencer returns the ORIGINAL event on a re-append of the same id (twice in = once out), so
//     this dedups by `input.id`. `count(kind)` therefore counts DISTINCT committed events (the "once out" oracle).
//   · the settle catch-up — the api credit-settle route flips the invoice to 'paid' ONLY when a covering
//     payment.received is already committed, so this flips only when a matching payment.received was appended.
// The MONEY PROJECTION itself (the credit_purchase money_lines row, the invoices upsert, the visibility clamp, the
// hash chain, tenant isolation) is the SEQUENCER's job — proven against the REAL DO in the api harness
// (workers/api/test/platform-credit.test.ts). This fake never re-implements it (that would resurrect the retired
// D1 mirror); it records the emitter's CALLS.
export class RecordingLedger implements PlatformLedger {
  /** Committed events, deduped by event id — models the sequencer's once-out contract. */
  readonly events = new Map<string, EventInput>();
  /** Every append CALL, in order (includes redelivered duplicates the sequencer would dedup). */
  readonly appendCalls: Array<{ streamId: string; input: EventInput }> = [];
  /** Every settle CALL, in order. */
  readonly settleCalls: Array<{ invoiceId: string; paymentEventId: string; amountCents: number }> = [];
  /** Credit invoices flipped to paid by a covering, committed payment.received. */
  readonly paid = new Set<string>();

  async append({ streamId, input }: { streamId: string; input: EventInput }): Promise<{ id: string }> {
    this.appendCalls.push({ streamId, input });
    if (!this.events.has(input.id)) this.events.set(input.id, input);
    return { id: input.id };
  }

  async settleCreditInvoice({ invoiceId, paymentEventId, amountCents }: { invoiceId: string; paymentEventId: string; amountCents: number }): Promise<void> {
    this.settleCalls.push({ invoiceId, paymentEventId, amountCents });
    // The api credit-settle route runs `UPDATE invoices SET status='paid' WHERE id=? AND status='issued'` only
    // after verifying the covering payment.received exists — so a flip needs BOTH a committed payment.received AND
    // a committed invoice.issued for this invoice (an invoice exists as 'issued' only once its event commits). Both
    // preconditions are what make the out-of-order `unpaid` gap (finding A) observable: a settlement that lands
    // BEFORE its invoice cannot flip, so ONLY the later sale's own catch-up can — which the unpaid branch skipped.
    const paymentCommitted = [...this.events.values()].some((e) => e.id === paymentEventId && e.kind === "payment.received");
    const invoiceIssued = [...this.events.values()].some(
      (e) => e.kind === "invoice.issued" && (e.payload as { invoice_id?: unknown }).invoice_id === invoiceId,
    );
    if (paymentCommitted && invoiceIssued) this.paid.add(invoiceId);
  }

  /** Count of DISTINCT committed events of a kind (the once-out oracle). */
  count(kind: string): number {
    let n = 0;
    for (const e of this.events.values()) if (e.kind === kind) n += 1;
    return n;
  }

  /** The distinct committed events of a kind. */
  eventsOf(kind: string): EventInput[] {
    return [...this.events.values()].filter((e) => e.kind === kind);
  }
}
