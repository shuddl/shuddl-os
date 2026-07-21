import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { emitCreditPurchase, emitCreditSettlement, GL_PLATFORM_CREDITS_AR } from "../src/credits.js";
import { periodOf, usageCreditsId } from "../src/metering.js";
import { StripeWebhookEventSchema, type StripeWebhookEvent } from "../src/billing.js";
import { applyControl } from "./helpers.js";
import { RecordingLedger } from "./recording-ledger.js";
import { checkoutEventBody, paymentSucceededBody } from "./stripe.js";

// WP-14 Task 10 · REQ-123/003/083 — the credit-purchase EMITTER, proven against a RecordingLedger that models the
// api sequencer's two contracts (id-dedup once-out + the guarded settle catch-up). Credits are money events, and
// Task 10 appends them through the REAL sequencer (SequencerPlatformLedger). The MONEY PROJECTION (the
// credit_purchase money_lines row, the invoices row, the visibility clamp) is proven against the real DO in the api
// harness (workers/api/test/platform-credit.test.ts); here we prove the emitter BUILDS the right events, is
// idempotent, and stamps usage_credits.stripe_refs — without re-running the retired D1 mirror.

const CREATED = Math.floor(Date.UTC(2026, 6, 15, 9, 0, 0) / 1000); // period "2026-07"
const PERIOD = periodOf(CREATED * 1000);

function parse(body: string): StripeWebhookEvent {
  return StripeWebhookEventSchema.parse(JSON.parse(body));
}

// The single credit line carried on a recorded invoice.issued event's payload (the projection turns it into the
// money_lines row — asserted against the REAL projection in the api harness).
function creditLine(led: RecordingLedger): { kind: string; amount_cents: number; gl_map: string; party_id: string } {
  const inv = led.eventsOf("invoice.issued")[0]!;
  const payload = inv.payload as { party_id: string; lines: Array<{ kind: string; amount_cents: number; gl_map: string }> };
  return { ...payload.lines[0]!, party_id: payload.party_id };
}

beforeAll(async () => {
  await applyControl(env.CONTROL_DB); // usage_credits — the stripe_refs stamp target
});

describe("REQ-003/123 — a credit-pack sale is an invoice.issued carrying a credit_purchase line (appended, not written)", () => {
  it("emits EXACTLY ONE invoice.issued whose payload carries one credit_purchase line on the platform stream", async () => {
    const led = new RecordingLedger();
    const event = parse(checkoutEventBody({ eventId: "evt_sale_1", tenant: "tenant-a", amountCents: 500_00, pi: "pi_sale_1", createdSec: CREATED }));
    const { invoiceId } = await emitCreditPurchase(led, env.CONTROL_DB, event);

    expect(led.count("invoice.issued")).toBe(1);
    // the sale is appended on a per-purchase CREDIT stream (never a customer shipment stream) — billing-level isolation.
    expect(led.appendCalls[0]!.streamId).toMatch(/^s:credit-/);

    const line = creditLine(led);
    expect(line.kind).toBe("credit_purchase");
    expect(line.amount_cents).toBe(500_00);
    expect(line.party_id).toBe("tenant-a"); // the buyer tenant is the AR party on the platform ledger
    expect(line.gl_map).toBe(GL_PLATFORM_CREDITS_AR);

    // prepaid ⇒ settled at completion (finding A): the emitter runs settleCredit, which the ledger flips to paid.
    expect(led.count("payment.received")).toBe(1);
    expect(led.paid.has(invoiceId)).toBe(true);
  });

  it("stamps usage_credits.stripe_refs on the buyer's <tenant>:<period> row", async () => {
    const led = new RecordingLedger();
    const event = parse(checkoutEventBody({ eventId: "evt_sale_2", tenant: "tenant-a", amountCents: 250_00, pi: "pi_sale_2", createdSec: CREATED }));
    const { invoiceId } = await emitCreditPurchase(led, env.CONTROL_DB, event);

    const row = await env.CONTROL_DB.prepare("SELECT metered, stripe_refs FROM usage_credits WHERE id = ?").bind(usageCreditsId("tenant-a", PERIOD)).first<{ metered: string; stripe_refs: string }>();
    expect(row).not.toBeNull();
    const refs = JSON.parse(row!.stripe_refs) as Record<string, unknown>;
    expect(refs["credit_invoice"]).toBe(invoiceId);
    expect(refs["payment_intent"]).toBe("pi_sale_2");
    expect(refs["credit_cents"]).toBe(250_00);
  });

  it("stamps stripe_refs WITHOUT clobbering `metered` the sweep owns (json_patch merge)", async () => {
    await env.CONTROL_DB
      .prepare("INSERT OR REPLACE INTO usage_credits (id, tenant_id, period, metered, stripe_refs) VALUES (?, 'tenant-a', ?, ?, '{}')")
      .bind(usageCreditsId("tenant-a", PERIOD), PERIOD, JSON.stringify({ rater: 7 }))
      .run();

    const led = new RecordingLedger();
    const event = parse(checkoutEventBody({ eventId: "evt_sale_3", tenant: "tenant-a", amountCents: 100_00, pi: "pi_sale_3", createdSec: CREATED }));
    await emitCreditPurchase(led, env.CONTROL_DB, event);

    const row = await env.CONTROL_DB.prepare("SELECT metered, stripe_refs FROM usage_credits WHERE id = ?").bind(usageCreditsId("tenant-a", PERIOD)).first<{ metered: string; stripe_refs: string }>();
    expect(JSON.parse(row!.metered)).toEqual({ rater: 7 }); // preserved — never clobbered
    expect((JSON.parse(row!.stripe_refs) as Record<string, unknown>)["payment_intent"]).toBe("pi_sale_3");
  });
});

describe("REQ-123 — idempotency: twice in = once out (the emitter re-derives the SAME event ids)", () => {
  it("a re-emitted sale (same payment) commits NOTHING more (the ledger dedups by the deterministic event id)", async () => {
    const led = new RecordingLedger();
    const event = parse(checkoutEventBody({ eventId: "evt_sale_dup", tenant: "tenant-b", amountCents: 300_00, pi: "pi_dup", createdSec: CREATED }));
    await emitCreditPurchase(led, env.CONTROL_DB, event);
    await emitCreditPurchase(led, env.CONTROL_DB, event); // redelivery / duplicate

    expect(led.count("invoice.issued")).toBe(1); // once out
    expect(led.count("payment.received")).toBe(1);
    // the emitter re-derived the SAME invoice-event id both times (which is WHY the sequencer dedups it).
    const invoiceAppendIds = led.appendCalls.filter((c) => c.input.kind === "invoice.issued").map((c) => c.input.id);
    expect(invoiceAppendIds.length).toBe(2); // called twice (redelivery)
    expect(new Set(invoiceAppendIds).size).toBe(1); // with ONE deterministic id
  });
});

describe("REQ-083 — settlement flips the credit invoice to paid (the shipped AR projection, unchanged)", () => {
  it("a payment.received covering the credit invoice flips it to paid; appends NO extra credit line", async () => {
    const led = new RecordingLedger();
    const sale = parse(checkoutEventBody({ eventId: "evt_s", tenant: "tenant-a", amountCents: 500_00, pi: "pi_settle", createdSec: CREATED }));
    const { invoiceId } = await emitCreditPurchase(led, env.CONTROL_DB, sale);
    expect(led.paid.has(invoiceId)).toBe(true); // prepaid ⇒ paid at completion (finding A)

    const paid = parse(paymentSucceededBody({ eventId: "evt_p", tenant: "tenant-a", amountCents: 500_00, pi: "pi_settle", createdSec: CREATED }));
    await emitCreditSettlement(led, env.CONTROL_DB, paid);

    expect(led.paid.has(invoiceId)).toBe(true); // still paid (idempotent AR flip)
    // ONE payment.received (checkout + settlement share the correlation id → same deterministic event id → deduped);
    // exactly ONE invoice.issued carrying exactly ONE credit_purchase line (no extra line from the payment).
    expect(led.count("payment.received")).toBe(1);
    expect(led.count("invoice.issued")).toBe(1);
    expect((led.eventsOf("invoice.issued")[0]!.payload as { lines: unknown[] }).lines.length).toBe(1);

    const row = await env.CONTROL_DB.prepare("SELECT stripe_refs FROM usage_credits WHERE id = ?").bind(usageCreditsId("tenant-a", PERIOD)).first<{ stripe_refs: string }>();
    const refs = JSON.parse(row!.stripe_refs) as Record<string, unknown>;
    expect(refs["settled"]).toBe(true);
    expect(refs["credit_invoice"]).toBe(invoiceId); // the sale's ref survived the settlement merge
  });

  it("settlement is idempotent — a redelivered payment does not re-append", async () => {
    const led = new RecordingLedger();
    const sale = parse(checkoutEventBody({ eventId: "evt_s2", tenant: "tenant-a", amountCents: 500_00, pi: "pi_settle2", createdSec: CREATED }));
    await emitCreditPurchase(led, env.CONTROL_DB, sale);
    const paid = parse(paymentSucceededBody({ eventId: "evt_p2", tenant: "tenant-a", amountCents: 500_00, pi: "pi_settle2", createdSec: CREATED }));
    await emitCreditSettlement(led, env.CONTROL_DB, paid);
    await emitCreditSettlement(led, env.CONTROL_DB, paid); // redelivery

    expect(led.count("payment.received")).toBe(1);
  });
});

describe("REQ-123/083 — finding A: a prepaid credit pack settles at checkout completion, any webhook order", () => {
  it("(iii) checkout.session.completed[paid] ALONE → the invoice is issued AND settled at completion", async () => {
    const led = new RecordingLedger();
    const sale = parse(checkoutEventBody({ eventId: "evt_alone", tenant: "tenant-a", amountCents: 500_00, pi: "pi_alone", createdSec: CREATED }));
    const { invoiceId } = await emitCreditPurchase(led, env.CONTROL_DB, sale);
    expect(led.paid.has(invoiceId)).toBe(true);
    expect(led.count("payment.received")).toBe(1); // the settlement rides the same flow
  });

  it("(i) payment_intent.succeeded delivered BEFORE checkout → after both, the invoice is paid", async () => {
    const led = new RecordingLedger();
    // The PI settlement lands FIRST — no issued invoice exists yet; the payment.received is committed, no flip.
    const paid = parse(paymentSucceededBody({ eventId: "evt_pi_first", tenant: "tenant-a", amountCents: 500_00, pi: "pi_ooo", createdSec: CREATED }));
    await emitCreditSettlement(led, env.CONTROL_DB, paid);

    // The sale lands SECOND — issuing the invoice AND (re-runnable settle) flipping it to paid.
    const sale = parse(checkoutEventBody({ eventId: "evt_sale_after", tenant: "tenant-a", amountCents: 500_00, pi: "pi_ooo", createdSec: CREATED }));
    const { invoiceId } = await emitCreditPurchase(led, env.CONTROL_DB, sale);

    expect(led.paid.has(invoiceId)).toBe(true); // covered ⇒ paid whatever the order (finding A)
    expect(led.count("payment.received")).toBe(1); // still exactly one payment (same correlation id)
  });

  it("(ii) exact-redelivery of both, in either order → exactly one credit line + one paid invoice", async () => {
    const led = new RecordingLedger();
    const sale = parse(checkoutEventBody({ eventId: "evt_r_sale", tenant: "tenant-b", amountCents: 600_00, pi: "pi_redel", createdSec: CREATED }));
    const paid = parse(paymentSucceededBody({ eventId: "evt_r_paid", tenant: "tenant-b", amountCents: 600_00, pi: "pi_redel", createdSec: CREATED }));
    await emitCreditSettlement(led, env.CONTROL_DB, paid);
    await emitCreditPurchase(led, env.CONTROL_DB, sale);
    await emitCreditPurchase(led, env.CONTROL_DB, sale); // redelivery
    await emitCreditSettlement(led, env.CONTROL_DB, paid); // redelivery

    expect(led.count("invoice.issued")).toBe(1); // one credit sale
    expect(led.count("payment.received")).toBe(1); // one payment
    const invId = (led.eventsOf("invoice.issued")[0]!.payload as { invoice_id: string }).invoice_id;
    expect(led.paid.has(invId)).toBe(true); // one paid invoice, no double-anything
  });
});

describe("REQ-025 — the emitter appends ONLY to the platform ledger port (never a customer D1 handle)", () => {
  it("every append rides a `_platform` credit stream — the emitter never holds a customer tenant handle", async () => {
    const led = new RecordingLedger();
    const event = parse(checkoutEventBody({ eventId: "evt_iso", tenant: "tenant-a", amountCents: 500_00, pi: "pi_iso", createdSec: CREATED }));
    await emitCreditPurchase(led, env.CONTROL_DB, event);
    // The emitter has ONE port (the platform ledger) and every append is on the per-purchase credit stream. The
    // physical "credit events land on _platform ONLY, never a customer tenant D1" law is proven against the real
    // sequencer in the api harness (platform-credit.test.ts) — this asserts the emitter can't target anything else.
    expect(led.appendCalls.length).toBeGreaterThan(0);
    for (const call of led.appendCalls) expect(call.streamId).toMatch(/^s:credit-/);
  });
});
