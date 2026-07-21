// WP-14 Task 7 · REQ-123/154 — THE STRIPE WEBHOOK HANDLER (fail-closed, idempotent).
//
// The ONE public surface the Billing worker exposes (Stripe-authed via the signature, NOT customer-authed). It:
//   1. VERIFIES the signature (billingFor → StripeBilling when a secret is bound; NotConfiguredBilling when DARK).
//      Unsigned / mismatched / stale ⇒ reject (400). DARK ⇒ reject (503), process NOTHING.
//   2. Dispatches the verified event to the credit emitter on the PLATFORM tenant (resolved SERVER-SIDE via
//      resolvePlatformTenantDb — no customer path, no slug input). The emitter is IDEMPOTENT (redelivery/duplicate
//      → once out), so a re-POST of the same Stripe event emits nothing more.
//
// The response contract mirrors Stripe's expectations: a 2xx ACKs (Stripe stops retrying); a non-2xx tells Stripe
// to retry. So a *processing* fault (a transient D1 error) returns 500 → Stripe redelivers → the idempotent
// emitter is safe. A verification failure returns 4xx/503 (no retry helps an unsigned/forged/DARK request).
import { billingFor, BillingNotConfiguredError } from "./billing.js";
import { emitCreditPurchase, emitCreditSettlement } from "./credits.js";
import { D1PlatformLedger } from "./platform-ledger.js";
import { resolvePlatformTenantDb, type BillingEnv } from "./tenants.js";

export async function handleStripeWebhook(request: Request, env: BillingEnv): Promise<Response> {
  const billing = billingFor(env);
  // Read the RAW body ONCE — the signature is over the exact bytes; never re-serialize before verifying.
  const rawBody = await request.text();
  const signature = request.headers.get("Stripe-Signature");

  // ---- verify (fail-closed) ----
  let event;
  try {
    event = await billing.verify(rawBody, signature);
  } catch (err) {
    if (err instanceof BillingNotConfiguredError) {
      // DARK — no secret bound. Nothing charges/emits. 503 (not 4xx): the request may be legitimate; the SERVER
      // is not configured. Loud, never silent.
      console.error(`billing webhook: DARK (not configured) — nothing processed: ${err.message}`);
      return new Response("billing not configured", { status: 503 });
    }
    // Unsigned / malformed / stale / MAC mismatch — a forged or replayed request. Reject; emit nothing.
    console.error(`billing webhook: signature verification failed — rejected: ${err instanceof Error ? err.message : String(err)}`);
    return new Response("signature verification failed", { status: 400 });
  }

  // ---- dispatch (idempotent emitter on the platform tenant) ----
  const ledger = new D1PlatformLedger(resolvePlatformTenantDb(env));
  try {
    switch (event.type) {
      case "checkout.session.completed":
        await emitCreditPurchase(ledger, env.CONTROL_DB, event);
        break;
      case "invoice.paid":
      case "payment_intent.succeeded":
        await emitCreditSettlement(ledger, env.CONTROL_DB, event);
        break;
      default:
        // An event type this worker does not handle. ACK so Stripe stops retrying — verified but ignored.
        console.log(`billing webhook: ignoring unhandled event type ${event.type} (${event.id})`);
        break;
    }
  } catch (err) {
    // A PROCESSING fault (transient D1, a projection abort). Return 500 so Stripe redelivers — the emitter is
    // idempotent (the ledger dedups by event id), so re-driving is safe end to end. Loud.
    console.error(`billing webhook: processing failed for ${event.type} ${event.id} (Stripe will redeliver; the emitter is idempotent):`, err);
    return new Response("processing failed", { status: 500 });
  }

  return new Response("ok", { status: 200 });
}
