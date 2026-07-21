import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { emitCreditPurchase, emitCreditSettlement, GL_PLATFORM_CREDITS_AR } from "../src/credits.js";
import { D1PlatformLedger } from "../src/platform-ledger.js";
import { periodOf, usageCreditsId } from "../src/metering.js";
import { StripeWebhookEventSchema, type StripeWebhookEvent } from "../src/billing.js";
import { applyPlatform, applyControl, applyTenant } from "./helpers.js";
import { checkoutEventBody, paymentSucceededBody } from "./stripe.js";

// WP-14 Task 7 · REQ-123/003/083 — the credit-purchase EMITTER + the credit_purchase money-event mapping,
// PROVEN against the reserved platform tenant's D1 (the tested interim; the live append-through-sequencer for
// `_platform` is wired in Task 10). Credits are money events, PROJECTED — never a direct money_lines write.

const CREATED = Math.floor(Date.UTC(2026, 6, 15, 9, 0, 0) / 1000); // period "2026-07"
const PERIOD = periodOf(CREATED * 1000);

function parse(body: string): StripeWebhookEvent {
  return StripeWebhookEventSchema.parse(JSON.parse(body));
}
function ledger(): D1PlatformLedger {
  return new D1PlatformLedger(env.PLATFORM_TENANT_DB);
}

async function countEvents(kind: string): Promise<number> {
  const row = await env.PLATFORM_TENANT_DB.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = ?").bind(kind).first<{ n: number }>();
  return row?.n ?? 0;
}

beforeAll(async () => {
  await applyPlatform(env.PLATFORM_TENANT_DB);
  await applyControl(env.CONTROL_DB);
  // The customer tenant D1s carry the ledger schema too, so the REQ-025 isolation assertions can query them.
  await applyTenant(env.TENANT_A_DB);
  await applyTenant(env.TENANT_B_DB);
});

describe("REQ-003/123 — a credit-pack sale is an invoice.issued carrying a credit_purchase money line (PROJECTED)", () => {
  it("emits EXACTLY ONE invoice.issued with a credit_purchase money_lines row on the platform tenant", async () => {
    const event = parse(checkoutEventBody({ eventId: "evt_sale_1", tenant: "tenant-a", amountCents: 500_00, pi: "pi_sale_1", createdSec: CREATED }));
    const { invoiceEventId, invoiceId } = await emitCreditPurchase(ledger(), env.CONTROL_DB, event);

    expect(await countEvents("invoice.issued")).toBe(1);

    // The money_lines row is a PROJECTION of the invoice.issued event (its event_id points back at it) — NOT a
    // direct write. Exactly one, kind credit_purchase, direction ar, amount = the pack cents.
    const lines = (await env.PLATFORM_TENANT_DB.prepare("SELECT * FROM money_lines WHERE kind = 'credit_purchase'").all()).results as Array<Record<string, unknown>>;
    expect(lines.length).toBe(1);
    const line = lines[0]!;
    expect(line["event_id"]).toBe(invoiceEventId); // projected FROM the event (I1), not written directly
    expect(line["direction"]).toBe("ar");
    expect(line["amount_cents"]).toBe(500_00);
    expect(line["party_id"]).toBe("tenant-a"); // the buyer tenant is the AR party on the platform ledger
    expect(line["gl_map"]).toBe(GL_PLATFORM_CREDITS_AR);

    // The invoices projection row exists, totals the pack, and is PAID — a paid checkout is prepaid, so it
    // settles at completion (finding A). The credit line above stays the single AR record either way.
    const inv = await env.PLATFORM_TENANT_DB.prepare("SELECT status, total_cents, party_id FROM invoices WHERE id = ?").bind(invoiceId).first<{ status: string; total_cents: number; party_id: string }>();
    expect(inv).not.toBeNull();
    expect(inv!.status).toBe("paid");
    expect(inv!.total_cents).toBe(500_00);
    expect(inv!.party_id).toBe("tenant-a");
  });

  it("stamps usage_credits.stripe_refs on the buyer's <tenant>:<period> row", async () => {
    const event = parse(checkoutEventBody({ eventId: "evt_sale_2", tenant: "tenant-a", amountCents: 250_00, pi: "pi_sale_2", createdSec: CREATED }));
    const { invoiceId } = await emitCreditPurchase(ledger(), env.CONTROL_DB, event);

    const row = await env.CONTROL_DB.prepare("SELECT metered, stripe_refs FROM usage_credits WHERE id = ?").bind(usageCreditsId("tenant-a", PERIOD)).first<{ metered: string; stripe_refs: string }>();
    expect(row).not.toBeNull();
    const refs = JSON.parse(row!.stripe_refs) as Record<string, unknown>;
    expect(refs["credit_invoice"]).toBe(invoiceId);
    expect(refs["payment_intent"]).toBe("pi_sale_2");
    expect(refs["credit_cents"]).toBe(250_00);
  });

  it("stamps stripe_refs WITHOUT clobbering `metered` the sweep owns (json_patch merge)", async () => {
    // The metering sweep already stamped this (tenant, period)'s metered blob.
    await env.CONTROL_DB
      .prepare("INSERT INTO usage_credits (id, tenant_id, period, metered, stripe_refs) VALUES (?, 'tenant-a', ?, ?, '{}')")
      .bind(usageCreditsId("tenant-a", PERIOD), PERIOD, JSON.stringify({ rater: 7 }))
      .run();

    const event = parse(checkoutEventBody({ eventId: "evt_sale_3", tenant: "tenant-a", amountCents: 100_00, pi: "pi_sale_3", createdSec: CREATED }));
    await emitCreditPurchase(ledger(), env.CONTROL_DB, event);

    const row = await env.CONTROL_DB.prepare("SELECT metered, stripe_refs FROM usage_credits WHERE id = ?").bind(usageCreditsId("tenant-a", PERIOD)).first<{ metered: string; stripe_refs: string }>();
    expect(JSON.parse(row!.metered)).toEqual({ rater: 7 }); // preserved — never clobbered
    expect((JSON.parse(row!.stripe_refs) as Record<string, unknown>)["payment_intent"]).toBe("pi_sale_3");
  });
});

describe("REQ-123 — idempotency: twice in = once out", () => {
  it("a re-emitted sale (same payment) emits NOTHING more (dedup by the deterministic invoice event id)", async () => {
    const event = parse(checkoutEventBody({ eventId: "evt_sale_dup", tenant: "tenant-b", amountCents: 300_00, pi: "pi_dup", createdSec: CREATED }));
    await emitCreditPurchase(ledger(), env.CONTROL_DB, event);
    await emitCreditPurchase(ledger(), env.CONTROL_DB, event); // redelivery / duplicate

    expect(await countEvents("invoice.issued")).toBe(1);
    const n = await env.PLATFORM_TENANT_DB.prepare("SELECT COUNT(*) AS n FROM money_lines WHERE kind = 'credit_purchase'").first<{ n: number }>();
    expect(n?.n).toBe(1);
  });
});

describe("REQ-083 — settlement flips the credit invoice to paid (the shipped AR projection, unchanged)", () => {
  it("a payment.received covering the credit invoice flips it to paid; posts NO extra money line", async () => {
    const sale = parse(checkoutEventBody({ eventId: "evt_s", tenant: "tenant-a", amountCents: 500_00, pi: "pi_settle", createdSec: CREATED }));
    const { invoiceId } = await emitCreditPurchase(ledger(), env.CONTROL_DB, sale);
    // Prepaid ⇒ paid at completion (finding A). A subsequent explicit settlement webhook is then idempotent.
    expect((await env.PLATFORM_TENANT_DB.prepare("SELECT status FROM invoices WHERE id = ?").bind(invoiceId).first<{ status: string }>())!.status).toBe("paid");

    const paid = parse(paymentSucceededBody({ eventId: "evt_p", tenant: "tenant-a", amountCents: 500_00, pi: "pi_settle", createdSec: CREATED }));
    await emitCreditSettlement(ledger(), env.CONTROL_DB, paid);

    // Still paid after the redundant settlement (the AR flip is idempotent).
    expect((await env.PLATFORM_TENANT_DB.prepare("SELECT status FROM invoices WHERE id = ?").bind(invoiceId).first<{ status: string }>())!.status).toBe("paid");
    // ONE payment.received event (checkout + the settlement webhook share the payment-intent correlation id →
    // the same deterministic event id → deduped); method 'stripe' posts NO money_line (only the AR flip) — so
    // credit_purchase is still the ONLY money line.
    expect(await countEvents("payment.received")).toBe(1);
    const mlCount = await env.PLATFORM_TENANT_DB.prepare("SELECT COUNT(*) AS n FROM money_lines").first<{ n: number }>();
    expect(mlCount?.n).toBe(1);

    // stripe_refs now records the settlement too (merged, not clobbering the sale's refs).
    const row = await env.CONTROL_DB.prepare("SELECT stripe_refs FROM usage_credits WHERE id = ?").bind(usageCreditsId("tenant-a", PERIOD)).first<{ stripe_refs: string }>();
    const refs = JSON.parse(row!.stripe_refs) as Record<string, unknown>;
    expect(refs["settled"]).toBe(true);
    expect(refs["credit_invoice"]).toBe(invoiceId); // the sale's ref survived the settlement merge
  });

  it("settlement is idempotent — a redelivered payment does not re-flip or double-append", async () => {
    const sale = parse(checkoutEventBody({ eventId: "evt_s2", tenant: "tenant-a", amountCents: 500_00, pi: "pi_settle2", createdSec: CREATED }));
    await emitCreditPurchase(ledger(), env.CONTROL_DB, sale);
    const paid = parse(paymentSucceededBody({ eventId: "evt_p2", tenant: "tenant-a", amountCents: 500_00, pi: "pi_settle2", createdSec: CREATED }));
    await emitCreditSettlement(ledger(), env.CONTROL_DB, paid);
    await emitCreditSettlement(ledger(), env.CONTROL_DB, paid); // redelivery

    expect(await countEvents("payment.received")).toBe(1);
  });
});

describe("REQ-123/083 — finding A: a prepaid credit pack settles at checkout completion, any webhook order", () => {
  it("(iii) checkout.session.completed[paid] ALONE → the invoice is issued AND paid (settled at completion)", async () => {
    const sale = parse(checkoutEventBody({ eventId: "evt_alone", tenant: "tenant-a", amountCents: 500_00, pi: "pi_alone", createdSec: CREATED }));
    const { invoiceId } = await emitCreditPurchase(ledger(), env.CONTROL_DB, sale);

    const inv = await env.PLATFORM_TENANT_DB.prepare("SELECT status FROM invoices WHERE id = ?").bind(invoiceId).first<{ status: string }>();
    expect(inv!.status).toBe("paid"); // prepaid ⇒ paid at completion (RED before the fix: stays 'issued')
    expect(await countEvents("payment.received")).toBe(1); // the settlement rides the same flow
  });

  it("(i) payment_intent.succeeded delivered BEFORE checkout → after both, the invoice is paid", async () => {
    // The PI settlement lands FIRST — no issued invoice exists yet, so nothing flips at this point.
    const paid = parse(paymentSucceededBody({ eventId: "evt_pi_first", tenant: "tenant-a", amountCents: 500_00, pi: "pi_ooo", createdSec: CREATED }));
    await emitCreditSettlement(ledger(), env.CONTROL_DB, paid);

    // The sale lands SECOND — issuing the invoice AND (re-runnable settle) flipping it to paid.
    const sale = parse(checkoutEventBody({ eventId: "evt_sale_after", tenant: "tenant-a", amountCents: 500_00, pi: "pi_ooo", createdSec: CREATED }));
    const { invoiceId } = await emitCreditPurchase(ledger(), env.CONTROL_DB, sale);

    const inv = await env.PLATFORM_TENANT_DB.prepare("SELECT status FROM invoices WHERE id = ?").bind(invoiceId).first<{ status: string }>();
    expect(inv!.status).toBe("paid"); // RED before the fix: stuck 'issued' forever (no _platform recon sweep)
    expect(await countEvents("payment.received")).toBe(1); // still exactly one payment (same correlation id)
  });

  it("(ii) exact-redelivery of both, in either order → exactly one credit_purchase + one paid invoice", async () => {
    const sale = parse(checkoutEventBody({ eventId: "evt_r_sale", tenant: "tenant-b", amountCents: 600_00, pi: "pi_redel", createdSec: CREATED }));
    const paid = parse(paymentSucceededBody({ eventId: "evt_r_paid", tenant: "tenant-b", amountCents: 600_00, pi: "pi_redel", createdSec: CREATED }));
    // Interleaved + redelivered in mixed order.
    await emitCreditSettlement(ledger(), env.CONTROL_DB, paid);
    await emitCreditPurchase(ledger(), env.CONTROL_DB, sale);
    await emitCreditPurchase(ledger(), env.CONTROL_DB, sale); // redelivery
    await emitCreditSettlement(ledger(), env.CONTROL_DB, paid); // redelivery

    const lines = await env.PLATFORM_TENANT_DB.prepare("SELECT COUNT(*) AS n FROM money_lines WHERE kind = 'credit_purchase'").first<{ n: number }>();
    expect(lines?.n).toBe(1); // one credit line
    expect(await countEvents("payment.received")).toBe(1); // one payment event
    const paidCount = await env.PLATFORM_TENANT_DB.prepare("SELECT COUNT(*) AS n FROM invoices WHERE party_id = 'tenant-b' AND status = 'paid'").first<{ n: number }>();
    expect(paidCount?.n).toBe(1); // one paid invoice, no double-anything
  });
});

describe("REQ-025 — platform-tenant isolation: credit events land on _platform ONLY", () => {
  it("no credit event/money line touches a customer tenant's D1", async () => {
    const event = parse(checkoutEventBody({ eventId: "evt_iso", tenant: "tenant-a", amountCents: 500_00, pi: "pi_iso", createdSec: CREATED }));
    await emitCreditPurchase(ledger(), env.CONTROL_DB, event);

    // The customer tenant D1s carry NOTHING from this credit flow (the emitter only ever holds the platform D1).
    for (const db of [env.TENANT_A_DB, env.TENANT_B_DB]) {
      const ev = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'invoice.issued'").first<{ n: number }>();
      const ml = await db.prepare("SELECT COUNT(*) AS n FROM money_lines WHERE kind = 'credit_purchase'").first<{ n: number }>();
      expect(ev?.n ?? 0).toBe(0);
      expect(ml?.n ?? 0).toBe(0);
    }
    // …and the platform D1 DOES carry it.
    expect(await countEvents("invoice.issued")).toBe(1);
  });
});
