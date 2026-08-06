// WP-14 Task 7 · REQ-123/154/003 — THE CREDIT-PURCHASE EMITTER (money-as-events on the PLATFORM tenant).
//
// A Stripe credit-pack sale becomes a MONEY EVENT on the reserved `_platform` revenue tenant, projected — never
// a direct money_lines write (REQ-003):
//   · checkout.session.completed (the sale)        → an invoice.issued carrying a money_lines row kind='credit_purchase'
//   · invoice.paid / payment_intent.succeeded (paid) → a payment.received → the SHIPPED AR projection flips the
//                                                       credit invoice to 'paid' (REQ-083, unchanged).
// credit_purchase rides the DORMANT-but-valid money_lines.kind — the 35 event kinds and the money kinds are
// FROZEN; this adds neither. It is DISTINCT from credit.checked (customer creditworthiness) — different concept.
//
// IDEMPOTENCY ("twice in = once out"): the ledger event id and the credit invoice number are derived
// DETERMINISTICALLY from the Stripe PAYMENT-INTENT correlation id (carried on every event for one payment) — not
// the ephemeral Stripe EVENT id. This is strictly stronger than event-id dedup: it collapses BOTH a redelivery
// (same event id) AND a duplicate-distinct event for the same payment to a single ledger record, and it is what
// links the settlement's payment.received back to the sale's invoice.issued (they share the correlation id).
//
// STRIPE_REFS: each phase stamps the SAME `<tenant>:<period>` control row the metering sweep owns
// (usage_credits), MERGING into stripe_refs (json_patch) so issue and settlement both contribute and neither
// clobbers `metered`. The sweep OVERWRITES only `metered` on conflict; this OVERWRITES only `stripe_refs`. The
// two never fork (metering.ts owns the row identity; both key it the same way).
import { z, EventInput } from "@shuddl/contracts";
import { periodOf, usageCreditsId } from "./metering.js";
import type { PlatformLedger } from "./platform-ledger.js";
import type { StripeWebhookEvent } from "./billing.js";

// The GL account platform credit revenue posts to. This is the PLATFORM ledger's chart — NOT the CUSTOMER
// canonical chart (CANONICAL_GL_ACCOUNTS, guarded by tools/checks/gl-accounts-parity.test.ts), which the
// _platform tenant's credit_purchase lines never reach (no customer QB/journal export runs over `_platform`).
// It registers into a platform chart if/when platform credits ever journal-export.
export const GL_PLATFORM_CREDITS_AR = "4300-PLATFORM-CREDITS-AR";
// The credit ledger's division tag on the platform tenant (money_lines/invoices carry a division, REQ-057).
const CREDIT_DIVISION = "platform";
// The server-controlled actor sentinel (mirrors the Biller's "agent:biller"). No user, no device.
const CREDIT_ACTOR_PARTY = "agent:billing";

// ---- deterministic ids (no Date, no random — a redelivery/duplicate must reproduce them exactly) ----
async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A DETERMINISTIC v4-variant UUID from a domain-tagged seed (the same shaping the Biller's uuidFromSeed uses),
// so the platform ledger's id-dedup returns the ORIGINAL event on a redelivery/duplicate.
async function uuidFromSeed(seed: string): Promise<string> {
  const h = (await sha256Hex(seed)).slice(0, 32);
  const variant = ((parseInt(h.slice(16, 17) || "0", 16) & 0x3) | 0x8).toString(16); // 8/9/a/b
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// The three ids all key off the payment CORRELATION id (the Stripe payment_intent for a purchase). The invoice
// number and the sale/settlement event ids share it, so the settlement's payment.received names the sale's
// invoice and the AR projection flips it (REQ-083).
async function creditInvoiceIdFor(correlationId: string): Promise<string> {
  return `credit_${(await sha256Hex(`billing:credit-doc:${correlationId}`)).slice(0, 16)}`;
}
async function invoiceEventIdFor(correlationId: string): Promise<string> {
  return uuidFromSeed(`billing:credit-invoice:${correlationId}`);
}
async function paymentEventIdFor(correlationId: string): Promise<string> {
  return uuidFromSeed(`billing:credit-payment:${correlationId}`);
}

// The credit ledger stream on the platform tenant — one stream PER PURCHASE (keyed on the correlation id), so
// the sale's invoice.issued and its settlement's payment.received chain on the SAME stream regardless of any
// month boundary. `s:credit-<correlation>` matches LedgerEvent's stream_id regex (s:[\w-]+; payment_intent ids
// are [\w] so the underscore is fine), and shipment_id = `credit-<correlation>` satisfies the events CHECK
// (stream_id = 's:'||shipment_id). The platform tenant has no real shipments; this synthetic id is the credit
// order's handle, traceable on the money_lines it projects.
function creditStream(correlationId: string): { streamId: string; shipmentId: string } {
  const shipmentId = `credit-${correlationId}`;
  return { streamId: `s:${shipmentId}`, shipmentId };
}

// ---- the control-row stripe_refs stamp (preserve `metered`; MERGE stripe_refs) ----------------------
// INSERT the row if the metering sweep has not created it yet (metered = '{}', the sweep overwrites it later);
// on conflict MERGE the new refs into stripe_refs (json_patch — RFC 7386) and leave `metered` untouched. So the
// order of (a credit stamp, a metering sweep) never matters: metered is the sweep's, stripe_refs is billing's.
const STRIPE_REFS_STAMP_SQL =
  "INSERT INTO usage_credits (id, tenant_id, period, metered, stripe_refs) VALUES (?, ?, ?, '{}', ?) " +
  "ON CONFLICT(id) DO UPDATE SET stripe_refs = json_patch(usage_credits.stripe_refs, excluded.stripe_refs)";

async function stampStripeRefs(
  control: D1Database,
  tenant: string,
  period: string,
  refs: Record<string, unknown>,
): Promise<void> {
  await control
    .prepare(STRIPE_REFS_STAMP_SQL)
    .bind(usageCreditsId(tenant, period), tenant, period, JSON.stringify(refs))
    .run();
}

// ---- Stripe object boundaries (Zod; the body is already signature-verified) -------------------------
// A one-time Checkout credit pack: metadata.tenant is the BUYER (set when the Checkout Session is created);
// amount_total is the pack price in cents; payment_intent correlates the later settlement (falls back to the
// session id when a session somehow carries no PI).
const CheckoutSessionCompleted = z
  .object({
    id: z.string().min(1),
    payment_intent: z.string().min(1).optional(),
    amount_total: z.number().int().positive(),
    // 'paid' | 'unpaid' | 'no_payment_required'. A one-time credit pack completes 'paid' — that completion IS the
    // settlement (prepaid). 'unpaid' (async payment method) issues only; the later paid event settles.
    payment_status: z.string().optional(),
    metadata: z.object({ tenant: z.string().min(1) }).loose(),
  })
  .loose();

// The settlement object (invoice.paid → Invoice, payment_intent.succeeded → PaymentIntent). The correlation id
// is the PI: `payment_intent` on an Invoice, `id` on a PaymentIntent. The paid amount is amount_paid (Invoice)
// or amount_received (PaymentIntent). metadata.tenant is the buyer.
const SettlementObject = z
  .object({
    id: z.string().min(1),
    payment_intent: z.string().min(1).optional(),
    amount_paid: z.number().int().positive().optional(),
    amount_received: z.number().int().positive().optional(),
    metadata: z.object({ tenant: z.string().min(1) }).loose(),
  })
  .loose();

// ---- the settlement primitive (shared by the sale-at-completion path AND the settlement webhook) -----
// Appends the payment.received (idempotent) THEN runs the re-runnable settle catch-up. Called by BOTH
// emitCreditPurchase (prepaid completion) and emitCreditSettlement (the paid webhook), so the credit invoice
// flips to 'paid' whichever webhook lands SECOND — the out-of-order fix (finding A). Returns the derived ids.
async function settleCredit(
  ledger: PlatformLedger,
  correlationId: string,
  tenant: string,
  amount: number,
  tsMs: number,
): Promise<{ paymentEventId: string; invoiceId: string }> {
  const invoiceId = await creditInvoiceIdFor(correlationId);
  const paymentEventId = await paymentEventIdFor(correlationId);
  const { streamId, shipmentId } = creditStream(correlationId);

  const input = EventInput.parse({
    id: paymentEventId,
    shipment_id: shipmentId,
    ts: tsMs,
    actor: { party: CREDIT_ACTOR_PARTY },
    party_refs: [],
    evidence: [],
    source: "native",
    confidence: 10_000,
    kind: "payment.received",
    // method 'stripe' (not 'cod') → the projection posts NO money_line, only the AR settle flip (REQ-083).
    payload: { invoice_id: invoiceId, amount_cents: amount, method: "stripe", party_id: tenant },
  });
  await ledger.append({ streamId, input });
  // Re-runnable catch-up: flips the invoice even when the append above deduped (the payment.received was already
  // committed by an earlier/out-of-order webhook) — the append's own batch projection would have skipped it.
  await ledger.settleCreditInvoice({ invoiceId, paymentEventId, amountCents: amount });
  return { paymentEventId, invoiceId };
}

// ---- the emitters -----------------------------------------------------------------------------------

/**
 * checkout.session.completed → the credit-pack SALE. Appends an invoice.issued carrying ONE money_lines row
 * kind='credit_purchase' on the platform tenant (projected, never a direct write). A one-time credit pack is
 * PREPAID, so a completion with payment_status='paid' IS the settlement: it also runs settleCredit in the SAME
 * flow, so the invoice is never left 'issued' when the payment is covered — even if payment_intent.succeeded is
 * delivered out of order (finding A): settleCredit's catch-up flips a payment.received a prior settlement already
 * recorded. Then stamps the buyer's usage_credits.stripe_refs. Idempotent: a redelivery/duplicate re-derives the
 * same ids and the platform ledger dedups them.
 */
export async function emitCreditPurchase(
  ledger: PlatformLedger,
  control: D1Database,
  event: StripeWebhookEvent,
): Promise<{ invoiceEventId: string; invoiceId: string; tenant: string; period: string }> {
  const session = CheckoutSessionCompleted.parse(event.data.object);
  // 2026-08-01 convergence audit: the sale and settlement emitters MUST derive the SAME correlation id,
  // and the settlement side can only ever see the payment intent — so a session with no PI (a credit
  // pack misconfigured as subscription/setup mode) must REFUSE loudly (the webhook 500s and Stripe
  // retries/alerts) rather than fall back to the session id and mint a sale invoice the settlement can
  // never find (a phantom stream stuck 'issued' forever, invisible to any sweep).
  if (session.payment_intent === undefined || session.payment_intent === null) {
    throw new Error(`CREDIT_SALE_NO_PAYMENT_INTENT: checkout session ${session.id} carries no payment_intent — a one-time credit pack always does; refusing an unlinkable sale (fix the Stripe product mode)`);
  }
  const correlationId = session.payment_intent;
    // THE TENANT BINDING IS SET OUTSIDE THIS REPOSITORY (audit §403). The Zod shape above requires
    // `metadata.tenant` to be a non-empty string, and Stripe's signature covers it — so it cannot be
    // forged in transit. Neither fact establishes that the value names the RIGHT tenant: it is whatever
    // was written at Checkout Session creation, and **no code in this repository creates one** (grep:
    // the only `checkout.session` references are consumers). The creating surface is a go-live item
    // (PROVISIONING_ENABLED / Stripe keys, GO-LIVE-CHECKLIST).
    //
    // REQUIREMENT FOR WHOEVER BUILDS IT: `metadata.tenant` MUST be stamped from a server-known slug —
    // the authenticated session's tenant, as `routes/events.ts` stamps `override.by` from `session.sub`
    // — and MUST NEVER come from a client parameter (a pricing-page query string, a form field). If it
    // does, a buyer credits any tenant they can name, and every check downstream still passes: the
    // signature verifies, the Zod parse succeeds, and the credit lands on the wrong account.
    const tenant = session.metadata.tenant;
  const tsMs = event.created * 1000;
  const period = periodOf(tsMs);
  const invoiceId = await creditInvoiceIdFor(correlationId);
  const invoiceEventId = await invoiceEventIdFor(correlationId);
  const { streamId, shipmentId } = creditStream(correlationId);

  // Parse-to-brand at the boundary (confidence is a branded Bps; EventInput.parse validates + brands).
  const input = EventInput.parse({
    id: invoiceEventId,
    shipment_id: shipmentId,
    ts: tsMs,
    actor: { party: CREDIT_ACTOR_PARTY },
    party_refs: [],
    evidence: [],
    source: "native",
    confidence: 10_000,
    kind: "invoice.issued",
    payload: {
      invoice_id: invoiceId,
      party_id: tenant, // the buyer tenant is the AR party on the platform ledger
      division: CREDIT_DIVISION,
      lines: [{ line_no: 1, kind: "credit_purchase", amount_cents: session.amount_total, gl_map: GL_PLATFORM_CREDITS_AR }],
    },
  });
  await ledger.append({ streamId, input });

  // Prepaid ('paid') ⇒ paid at completion: settle in the same flow (finding A). ASYNC ('unpaid', e.g. ACH) ⇒ the
  // settlement webhook (payment_intent.succeeded) arrives separately, so DON'T append a payment here — but STILL run
  // the SAFE re-runnable catch-up alone: if that covering payment already landed OUT OF ORDER (before this sale),
  // the catch-up flips the now-issued invoice; otherwise it is a no-op (the api route verifies the payment.received
  // exists first). Skipping it on the unpaid branch is exactly what left a paid invoice stuck 'issued' (finding A),
  // and no `_platform` AR reconciliation sweep would ever catch it.
  const settled = session.payment_status === "paid";
  if (settled) {
    await settleCredit(ledger, correlationId, tenant, session.amount_total, tsMs);
  } else {
    const paymentEventId = await paymentEventIdFor(correlationId);
    await ledger.settleCreditInvoice({ invoiceId, paymentEventId, amountCents: session.amount_total });
  }

  await stampStripeRefs(control, tenant, period, {
    credit_invoice: invoiceId,
    payment_intent: correlationId,
    checkout_session: session.id,
    credit_cents: session.amount_total,
    sold_event: event.id,
    // NEVER stamp `settled: false` (2026-08-01 audit): webhook delivery is unordered and the purchase
    // leg is redeliverable for days — a late unpaid-snapshot replay would json_patch-overwrite the
    // settlement's `settled: true` and the reconciliation blob would misreport forever. The unpaid
    // branch simply does not claim; only a positive settlement fact is ever written.
    ...(settled ? { settled: true } : {}),
  });
  return { invoiceEventId, invoiceId, tenant, period };
}

/**
 * invoice.paid / payment_intent.succeeded → the SETTLEMENT webhook. Runs settleCredit: appends the
 * payment.received naming the sale's credit invoice AND runs the re-runnable settle flip (REQ-083). Order-safe
 * (finding A): if this settlement lands BEFORE its sale, the payment.received records but the flip finds no
 * 'issued' invoice yet — a no-op; the LATER emitCreditPurchase's own settleCredit then flips it (the
 * payment.received it re-appends deduplicates, and its catch-up does the flip). So a covering payment can never
 * leave a credit invoice stuck 'issued'. Then stamps usage_credits.stripe_refs.
 */
export async function emitCreditSettlement(
  ledger: PlatformLedger,
  control: D1Database,
  event: StripeWebhookEvent,
): Promise<{ paymentEventId: string; invoiceId: string; tenant: string; period: string }> {
  const object = SettlementObject.parse(event.data.object);
  const correlationId = object.payment_intent ?? object.id;
  const tenant = object.metadata.tenant;
  const amount = object.amount_paid ?? object.amount_received;
  if (amount === undefined) {
    throw new Error(`credit settlement ${event.id}: no amount_paid/amount_received on the Stripe object — cannot record a payment`);
  }
  const tsMs = event.created * 1000;
  const period = periodOf(tsMs);
  const { paymentEventId, invoiceId } = await settleCredit(ledger, correlationId, tenant, amount, tsMs);

  await stampStripeRefs(control, tenant, period, {
    settled_invoice: invoiceId,
    payment_intent: correlationId,
    amount_paid_cents: amount,
    paid_event: event.id,
    settled: true,
  });
  return { paymentEventId, invoiceId, tenant, period };
}
