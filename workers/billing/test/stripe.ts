// WP-14 Task 7 — Stripe webhook test helpers: sign a payload the way Stripe does (so StripeBilling.verify
// accepts it) and build the minimal checkout/settlement event fixtures the emitter reads. A FAKE test secret —
// never a real key (REQ-134/154). No Stripe SDK; this mirrors the raw scheme billing.ts verifies.

// A fake endpoint secret (whsec_ prefix, like Stripe's) — a test literal, not a credential.
export const TEST_WEBHOOK_SECRET = "whsec_test_shuddl_billing_task7_do_not_use";

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Build a valid `Stripe-Signature` header (`t=…,v1=…`) over the exact body bytes with the given secret. Defaults
// the timestamp to now so it sits inside StripeBilling's tolerance.
export async function signStripe(body: string, secret: string = TEST_WEBHOOK_SECRET, tsSec?: number): Promise<string> {
  const t = tsSec ?? Math.floor(Date.now() / 1000);
  const v1 = await hmacSha256Hex(secret, `${t}.${body}`);
  return `t=${t},v1=${v1}`;
}

// A checkout.session.completed event body (the credit-pack SALE). `pi` correlates the later settlement.
export function checkoutEventBody(opts: {
  eventId: string;
  tenant: string;
  amountCents: number;
  pi: string;
  sessionId?: string;
  createdSec?: number;
}): string {
  return JSON.stringify({
    id: opts.eventId,
    type: "checkout.session.completed",
    created: opts.createdSec ?? Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: opts.sessionId ?? `cs_test_${opts.pi}`,
        object: "checkout.session",
        payment_intent: opts.pi,
        amount_total: opts.amountCents,
        currency: "usd",
        payment_status: "paid",
        metadata: { tenant: opts.tenant },
      },
    },
  });
}

// A payment_intent.succeeded event body (the SETTLEMENT). Same `pi` correlation id as its checkout.
export function paymentSucceededBody(opts: {
  eventId: string;
  tenant: string;
  amountCents: number;
  pi: string;
  createdSec?: number;
}): string {
  return JSON.stringify({
    id: opts.eventId,
    type: "payment_intent.succeeded",
    created: opts.createdSec ?? Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: opts.pi,
        object: "payment_intent",
        amount_received: opts.amountCents,
        currency: "usd",
        status: "succeeded",
        metadata: { tenant: opts.tenant },
      },
    },
  });
}

// A bare webhook body of an unhandled type (verified, but the worker ignores it → 200, emits nothing).
export function unhandledEventBody(eventId: string): string {
  return JSON.stringify({
    id: eventId,
    type: "customer.created",
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: "cus_test_1", object: "customer" } },
  });
}

// Build a POST Request to the worker's webhook route with a (optionally overridden) signature header.
export function webhookRequest(body: string, signature: string | null): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (signature !== null) headers["Stripe-Signature"] = signature;
  return new Request("https://billing.example.com/webhooks/stripe", { method: "POST", headers, body });
}
