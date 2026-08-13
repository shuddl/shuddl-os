import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { handleStripeWebhook } from "../src/webhook.js";
import type { BillingEnv } from "../src/tenants.js";
import { applyControl } from "./helpers.js";
import { RecordingLedger } from "./recording-ledger.js";
import {
  TEST_WEBHOOK_SECRET,
  signStripe,
  checkoutEventBody,
  paymentSucceededBody,
  unhandledEventBody,
  webhookRequest,
} from "./stripe.js";

// WP-14 Task 10 · REQ-123/154 — the idempotent, fail-closed Stripe webhook, driven end-to-end. As of Task 10 the
// credit money events append onto `_platform` through the REAL api sequencer (SequencerPlatformLedger). These
// suites inject a RecordingLedger (modeling the sequencer's once-out + settle contracts) so the webhook's dispatch
// + fail-closed behavior is proven without the cross-worker sequencer; the real append/projection is proven in the
// api harness (workers/api/test/platform-credit.test.ts). The worker.fetch route (health/404/DARK) is unchanged.

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

beforeAll(async () => {
  await applyControl(env.CONTROL_DB); // usage_credits — the emitter's stripe_refs stamp target
});

describe("DARK — a webhook does NOTHING until a secret is bound (nothing charges/emits)", () => {
  it("a (signed) checkout webhook to a DARK env is rejected 503 and appends NOTHING", async () => {
    const led = new RecordingLedger();
    const body = checkoutEventBody({ eventId: "evt_dark", tenant: "tenant-a", amountCents: 500_00, pi: "pi_dark", createdSec: CREATED });
    const res = await handleStripeWebhook(webhookRequest(body, await signStripe(body)), darkEnv(), led);
    expect(res.status).toBe(503);
    expect(led.count("invoice.issued")).toBe(0); // verify fails first — the ledger is never reached
  });

  it("drives through the worker.fetch route (POST /webhooks/stripe) — DARK ⇒ 503", async () => {
    const body = checkoutEventBody({ eventId: "evt_dark2", tenant: "tenant-a", amountCents: 500_00, pi: "pi_dark2", createdSec: CREATED });
    const res = await worker.fetch(webhookRequest(body, await signStripe(body)), darkEnv(), ctx());
    expect(res.status).toBe(503); // signature verification is DARK before any ledger construction
  });
});

describe("fail-closed — unsigned / bad-signature webhooks are rejected", () => {
  it("an UNSIGNED webhook (no Stripe-Signature) is rejected 400, appends nothing", async () => {
    const led = new RecordingLedger();
    const body = checkoutEventBody({ eventId: "evt_unsigned", tenant: "tenant-a", amountCents: 500_00, pi: "pi_unsigned", createdSec: CREATED });
    const res = await handleStripeWebhook(webhookRequest(body, null), liveEnv(), led);
    expect(res.status).toBe(400);
    expect(led.count("invoice.issued")).toBe(0);
  });

  it("a BAD-signature webhook (wrong secret) is rejected 400, appends nothing", async () => {
    const led = new RecordingLedger();
    const body = checkoutEventBody({ eventId: "evt_bad", tenant: "tenant-a", amountCents: 500_00, pi: "pi_bad", createdSec: CREATED });
    const badSig = await signStripe(body, "whsec_wrong");
    const res = await handleStripeWebhook(webhookRequest(body, badSig), liveEnv(), led);
    expect(res.status).toBe(400);
    expect(led.count("invoice.issued")).toBe(0);
  });
});

describe("REQ-123 — a verified checkout webhook appends EXACTLY ONE credit_purchase sale; redelivery appends nothing more", () => {
  it("a verified checkout.session.completed appends one credit_purchase invoice.issued through the ledger", async () => {
    const led = new RecordingLedger();
    const body = checkoutEventBody({ eventId: "evt_ok", tenant: "tenant-a", amountCents: 500_00, pi: "pi_ok", createdSec: CREATED });
    const res = await handleStripeWebhook(webhookRequest(body, await signStripe(body)), liveEnv(), led);
    expect(res.status).toBe(200);

    expect(led.count("invoice.issued")).toBe(1);
    const inv = led.eventsOf("invoice.issued")[0]!;
    const payload = inv.payload as { party_id: string; lines: Array<{ kind: string; amount_cents: number }> };
    expect(payload.lines[0]!.kind).toBe("credit_purchase");
    expect(payload.lines[0]!.amount_cents).toBe(500_00);
    expect(payload.party_id).toBe("tenant-a");
  });

  // §1290 — A PROCESSING FAULT MUST NOT BE ACKed. Verification and dispatch are pinned above; the third
  // outcome — the emitter itself throwing (a transient D1 fault, a projection abort) — was not. Measured:
  // changing that branch's 500 to a 200 left workers/billing at 60/60 GREEN.
  //
  // The status IS the retry protocol. Stripe redelivers on 5xx and STOPS on 2xx, so ACKing a failed emit
  // discards the delivery permanently: the customer's card is charged and the credits are never issued, with
  // no error anywhere because the webhook "succeeded". The handler's own comment states the contract — "Return
  // 500 so Stripe redelivers — the emitter is idempotent, so re-driving is safe end to end" — and idempotency
  // is what makes 500 the SAFE answer rather than merely the loud one.
  it("§1290: a throwing emitter returns 500 (Stripe redelivers) and never ACKs the delivery", async () => {
    const led = new RecordingLedger();
    // A ledger that faults exactly the way a transient D1 error would, after verification has succeeded.
    const faulting: typeof led = Object.assign(Object.create(Object.getPrototypeOf(led) as object) as typeof led, led, {
      append: async () => {
        throw new Error("D1_ERROR: transient");
      },
    });
    const body = checkoutEventBody({ eventId: "evt_fault", tenant: "tenant-a", amountCents: 500_00, pi: "pi_fault", createdSec: CREATED });
    const res = await handleStripeWebhook(webhookRequest(body, await signStripe(body)), liveEnv(), faulting);
    expect(res.status, "a failed emit must NOT be acknowledged — 200 tells Stripe to stop retrying").toBe(500);
    // PREMISE: the fault happened after verification, so this is the processing branch and not the 400 path.
    expect(await res.text()).toContain("processing failed");
  });

  it("a REDELIVERED webhook (same Stripe event) appends NOTHING more (idempotent, once-out)", async () => {
    const led = new RecordingLedger();
    const body = checkoutEventBody({ eventId: "evt_redeliver", tenant: "tenant-b", amountCents: 400_00, pi: "pi_redeliver", createdSec: CREATED });
    const sig = await signStripe(body);
    const r1 = await handleStripeWebhook(webhookRequest(body, sig), liveEnv(), led);
    const r2 = await handleStripeWebhook(webhookRequest(body, sig), liveEnv(), led); // Stripe redelivers
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(led.count("invoice.issued")).toBe(1);
  });

  it("the full acceptance path — sale then settlement flips the credit invoice to paid", async () => {
    const led = new RecordingLedger();
    const saleBody = checkoutEventBody({ eventId: "evt_e2e_sale", tenant: "tenant-a", amountCents: 750_00, pi: "pi_e2e", createdSec: CREATED });
    const sres = await handleStripeWebhook(webhookRequest(saleBody, await signStripe(saleBody)), liveEnv(), led);
    expect(sres.status).toBe(200);

    const paidBody = paymentSucceededBody({ eventId: "evt_e2e_paid", tenant: "tenant-a", amountCents: 750_00, pi: "pi_e2e", createdSec: CREATED });
    const pres = await handleStripeWebhook(webhookRequest(paidBody, await signStripe(paidBody)), liveEnv(), led);
    expect(pres.status).toBe(200);

    const invId = (led.eventsOf("invoice.issued")[0]!.payload as { invoice_id: string }).invoice_id;
    expect(led.paid.has(invId)).toBe(true);
  });
});

describe("verified but unhandled event types are ACKed (200) and append nothing", () => {
  it("an unhandled type returns 200 and appends no ledger event", async () => {
    const led = new RecordingLedger();
    const body = unhandledEventBody("evt_unhandled");
    const res = await handleStripeWebhook(webhookRequest(body, await signStripe(body)), liveEnv(), led);
    expect(res.status).toBe(200);
    expect(led.count("invoice.issued")).toBe(0);
    expect(led.count("payment.received")).toBe(0);
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
