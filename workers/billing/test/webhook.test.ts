import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { handleStripeWebhook } from "../src/webhook.js";
import type { BillingEnv } from "../src/tenants.js";
import { applyPlatform, applyControl } from "./helpers.js";
import {
  TEST_WEBHOOK_SECRET,
  signStripe,
  checkoutEventBody,
  paymentSucceededBody,
  unhandledEventBody,
  webhookRequest,
} from "./stripe.js";

// WP-14 Task 7 · REQ-123/154 — the idempotent, fail-closed Stripe webhook, driven end-to-end.

const CREATED = Math.floor(Date.UTC(2026, 6, 15, 9, 0, 0) / 1000);

// A live env (secret bound) vs the DARK env (no secret). billingFor reads only STRIPE_WEBHOOK_SECRET.
function liveEnv(): BillingEnv {
  return { ...env, STRIPE_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET };
}
function darkEnv(): BillingEnv {
  const { STRIPE_WEBHOOK_SECRET: _omit, ...rest } = env; // the secret key absent — the real DARK shape
  void _omit;
  return rest;
}
function ctx(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
}
async function countEvents(kind: string): Promise<number> {
  const row = await env.PLATFORM_TENANT_DB.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = ?").bind(kind).first<{ n: number }>();
  return row?.n ?? 0;
}

beforeAll(async () => {
  await applyPlatform(env.PLATFORM_TENANT_DB);
  await applyControl(env.CONTROL_DB);
});

describe("DARK — a webhook does NOTHING until a secret is bound (nothing charges/emits)", () => {
  it("a (signed) checkout webhook to a DARK env is rejected 503 and emits NOTHING", async () => {
    const body = checkoutEventBody({ eventId: "evt_dark", tenant: "tenant-a", amountCents: 500_00, pi: "pi_dark", createdSec: CREATED });
    const res = await handleStripeWebhook(webhookRequest(body, await signStripe(body)), darkEnv());
    expect(res.status).toBe(503);
    expect(await countEvents("invoice.issued")).toBe(0);
  });

  it("drives through the worker.fetch route (POST /webhooks/stripe) — DARK ⇒ 503, nothing emitted", async () => {
    const body = checkoutEventBody({ eventId: "evt_dark2", tenant: "tenant-a", amountCents: 500_00, pi: "pi_dark2", createdSec: CREATED });
    const res = await worker.fetch(webhookRequest(body, await signStripe(body)), darkEnv(), ctx());
    expect(res.status).toBe(503);
    expect(await countEvents("invoice.issued")).toBe(0);
  });
});

describe("fail-closed — unsigned / bad-signature webhooks are rejected", () => {
  it("an UNSIGNED webhook (no Stripe-Signature) is rejected 400, emits nothing", async () => {
    const body = checkoutEventBody({ eventId: "evt_unsigned", tenant: "tenant-a", amountCents: 500_00, pi: "pi_unsigned", createdSec: CREATED });
    const res = await handleStripeWebhook(webhookRequest(body, null), liveEnv());
    expect(res.status).toBe(400);
    expect(await countEvents("invoice.issued")).toBe(0);
  });

  it("a BAD-signature webhook (wrong secret) is rejected 400, emits nothing", async () => {
    const body = checkoutEventBody({ eventId: "evt_bad", tenant: "tenant-a", amountCents: 500_00, pi: "pi_bad", createdSec: CREATED });
    const badSig = await signStripe(body, "whsec_wrong");
    const res = await handleStripeWebhook(webhookRequest(body, badSig), liveEnv());
    expect(res.status).toBe(400);
    expect(await countEvents("invoice.issued")).toBe(0);
  });
});

describe("REQ-123 — a verified checkout webhook emits EXACTLY ONE credit_purchase invoice; redelivery emits nothing more", () => {
  it("a verified checkout.session.completed emits one credit_purchase invoice.issued on the platform tenant", async () => {
    const body = checkoutEventBody({ eventId: "evt_ok", tenant: "tenant-a", amountCents: 500_00, pi: "pi_ok", createdSec: CREATED });
    const res = await handleStripeWebhook(webhookRequest(body, await signStripe(body)), liveEnv());
    expect(res.status).toBe(200);

    expect(await countEvents("invoice.issued")).toBe(1);
    const line = await env.PLATFORM_TENANT_DB.prepare("SELECT kind, amount_cents, party_id FROM money_lines WHERE kind = 'credit_purchase'").first<{ kind: string; amount_cents: number; party_id: string }>();
    expect(line).not.toBeNull();
    expect(line!.amount_cents).toBe(500_00);
    expect(line!.party_id).toBe("tenant-a");
  });

  it("a REDELIVERED webhook (same Stripe event) emits NOTHING more (idempotent)", async () => {
    const body = checkoutEventBody({ eventId: "evt_redeliver", tenant: "tenant-b", amountCents: 400_00, pi: "pi_redeliver", createdSec: CREATED });
    const sig = await signStripe(body);
    const r1 = await handleStripeWebhook(webhookRequest(body, sig), liveEnv());
    const r2 = await handleStripeWebhook(webhookRequest(body, sig), liveEnv()); // Stripe redelivers
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(await countEvents("invoice.issued")).toBe(1);
  });

  it("drives the full acceptance path through worker.fetch: sale then settlement flips to paid", async () => {
    const saleBody = checkoutEventBody({ eventId: "evt_e2e_sale", tenant: "tenant-a", amountCents: 750_00, pi: "pi_e2e", createdSec: CREATED });
    const sres = await worker.fetch(webhookRequest(saleBody, await signStripe(saleBody)), liveEnv(), ctx());
    expect(sres.status).toBe(200);

    const paidBody = paymentSucceededBody({ eventId: "evt_e2e_paid", tenant: "tenant-a", amountCents: 750_00, pi: "pi_e2e", createdSec: CREATED });
    const pres = await worker.fetch(webhookRequest(paidBody, await signStripe(paidBody)), liveEnv(), ctx());
    expect(pres.status).toBe(200);

    const inv = await env.PLATFORM_TENANT_DB.prepare("SELECT status FROM invoices WHERE party_id = 'tenant-a' AND total_cents = 75000").first<{ status: string }>();
    expect(inv!.status).toBe("paid");
  });
});

describe("verified but unhandled event types are ACKed (200) and emit nothing", () => {
  it("an unhandled type returns 200 and appends no ledger event", async () => {
    const body = unhandledEventBody("evt_unhandled");
    const res = await handleStripeWebhook(webhookRequest(body, await signStripe(body)), liveEnv());
    expect(res.status).toBe(200);
    expect(await countEvents("invoice.issued")).toBe(0);
    expect(await countEvents("payment.received")).toBe(0);
  });
});

describe("the health probe + 404 surface are unchanged", () => {
  it("GET /health → 200 ok", async () => {
    const res = await worker.fetch(new Request("https://billing.example.com/health"), liveEnv(), ctx());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("an unknown path 404s", async () => {
    const res = await worker.fetch(new Request("https://billing.example.com/nope"), liveEnv(), ctx());
    expect(res.status).toBe(404);
  });

  it("GET on the webhook path (wrong method) 404s", async () => {
    const res = await worker.fetch(new Request("https://billing.example.com/webhooks/stripe"), liveEnv(), ctx());
    expect(res.status).toBe(404);
  });
});
