// WP-13 Task 9 (REQ-108) — THE CONFIRM-BEFORE-MONEY GATE, a MutationCheck in the chokepoint chain (gate.ts).
//
// book_shipment is THE money commitment (it accepts a priced quote, which triggers the gated Booking agent). A
// money-moving mutation must carry an EXPLICIT, STRUCTURED human confirmation matching the quoted amount, enforced
// SERVER-SIDE — the model cannot self-authorize money movement. So book_shipment MUST carry
// `args.confirm = { intent: "book", amount_cents }` where `amount_cents` EQUALS the SERVER-RECORDED accepted
// quote's sell. A MISSING confirm → refused (confirm_required); a WRONG intent / non-integer amount / an amount
// that ≠ the server sell → refused (confirm_mismatch). All refusals are MutationBlocked (fail-closed) BEFORE the
// accept-quote write. Read tools (quote/track/document) and the approve decision carry no confirm — this fires
// ONLY for book_shipment.
//
// ── THE SERVER SELL IS AUTHORITY, NEVER THE CLIENT'S CLAIMED PRICE ─────────────────────────────────────────────
// `confirm.amount_cents` is compared to the sell READ FROM the quote.priced event server-side (loadAcceptedQuote),
// not trusted as the price. A caller that confirms a cheap amount for an expensive booking is refused — the confirm
// is a HUMAN acknowledgement of the real amount, not an input that sets it. This SHARES the single accepted-quote
// lookup (loadAcceptedQuote, exported from caps.ts), MEMOIZED on ctx (ctx.acceptedQuoteMemo). confirm runs FIRST
// (gate order [confirm, caps], exit-audit F1a — so caps never reserves ahead of a confirm refusal): confirm
// populates the memo, caps reads it, and the quote.priced event is read exactly once per call.
//
// ── SCOPE: book_shipment ONLY; approve-confirm is DEFERRED (a REQ-108 follow-up) ──────────────────────────────
// The `approve` decision (approve.ts) records approved/denied on a shipment's OPEN below-floor approval. It does NOT
// itself commit money — the money commitment is the later accept-quote (book_shipment), which IS confirm-gated here.
// There is no clean, server-recorded "amount this approval releases" to confirm against: the api selects the open
// approval by shipment and the tool carries no quote/amount for it, so any confirm amount would be a GUESSED
// money-materiality signal. Per REQ-108's guidance ("do not guess a signal that isn't there"), Task 9's confirm is
// scoped to book_shipment; an approve-confirm (once an approval carries a materialized amount) is a follow-up. The
// pass-through test asserts approve is NOT confirm-gated, so this decision is pinned in code.
import { MutationBlocked, type MutationCheck } from "./gate.js";
import type { ToolCtx, ToolDef } from "./tools/registry.js";
import { loadAcceptedQuote } from "./caps.js";

/** ONLY book_shipment is confirm-gated — the money-moving mutation that accepts a priced quote. */
const BOOK_TOOL = "book_shipment";

/**
 * THE confirm check. A pass-through for every tool except book_shipment; for a booking it REQUIRES a structured
 * confirm whose amount_cents equals the SERVER-RECORDED accepted quote's sell. Every failure is fail-closed
 * (MutationBlocked) — a missing/malformed/mismatched confirm refuses the write, it never defaults to allow.
 */
async function runConfirmCheck(ctx: ToolCtx, tool: ToolDef, args: unknown): Promise<void> {
  if (tool.name !== BOOK_TOOL) return; // only the money commitment carries a confirm

  // Read ONLY the fields this gate needs from the (Zod-validated) booking args — never a client price.
  const a = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;

  // 1. A STRUCTURED confirm MUST be present. This is enforced HERE (the gate is the authority the money-commitment
  //    carries a human confirm), not by the tool's Zod (where `confirm` is optional so a missing one lands as a
  //    MutationBlocked "confirm_required", not a generic Zod 400).
  const confirmRaw = a.confirm;
  if (typeof confirmRaw !== "object" || confirmRaw === null) {
    throw new MutationBlocked(
      "confirm_required",
      "book_shipment requires an explicit confirm { intent: 'book', amount_cents } equal to the quoted sell",
    );
  }
  const confirm = confirmRaw as Record<string, unknown>;

  // 2. Intent must be the booking intent (defense-in-depth; the tool's strict Zod also pins intent === "book").
  if (confirm.intent !== "book") {
    throw new MutationBlocked("confirm_mismatch", "confirm.intent must be 'book' to commit a booking");
  }

  // 3. The confirmed amount must be a clean non-negative integer cents (matches the quote's integer-cents sell).
  const claimed = confirm.amount_cents;
  if (typeof claimed !== "number" || !Number.isInteger(claimed) || claimed < 0) {
    throw new MutationBlocked("confirm_mismatch", "confirm.amount_cents must be a non-negative integer equal to the quoted sell");
  }

  // 4. Resolve the shipment + quote the confirm is FOR. Absent ⇒ the confirm cannot be validated ⇒ refuse (a
  //    strict tool schema already requires both; this is belt-and-suspenders for the direct-check path).
  const shipmentId = typeof a.shipment_id === "string" ? a.shipment_id : undefined;
  const quoteEventId = typeof a.quote_event_id === "string" ? a.quote_event_id : undefined;
  if (shipmentId === undefined || quoteEventId === undefined) {
    throw new MutationBlocked("confirm_required", "booking is missing shipment_id/quote_event_id; confirm cannot be validated (fail-closed)");
  }

  // 5. Compare the confirmed amount to the SERVER-RECORDED sell (loadAcceptedQuote — memoized on ctx, so no
  //    double-fetch with caps). The sell is the server's, NEVER the client's claimed price.
  const { spendCents } = await loadAcceptedQuote(ctx, shipmentId, quoteEventId);
  if (claimed !== spendCents) {
    throw new MutationBlocked(
      "confirm_mismatch",
      `confirm.amount_cents (${claimed}) does not equal the accepted quote's sell (${spendCents}); booking refused`,
    );
  }
}

/** The composable check registered into gate.ts DEFAULT_MUTATION_CHECKS at the marked line (Task 9). */
export const confirmCheck: MutationCheck = {
  name: "confirm",
  check: runConfirmCheck,
};
