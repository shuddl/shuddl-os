import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  billingFor,
  StripeBilling,
  NotConfiguredBilling,
  BillingNotConfiguredError,
  BillingSignatureError,
} from "../src/billing.js";
import type { BillingEnv } from "../src/tenants.js";
import { TEST_WEBHOOK_SECRET, signStripe, checkoutEventBody } from "./stripe.js";

// WP-14 Task 7 · REQ-123/154 — the Stripe billing CLIENT: the DARK/NotConfigured gate + the constant-time raw
// signature verify. No network, no D1 here — this is the pure verification boundary.

const SAMPLE_BODY = checkoutEventBody({ eventId: "evt_1", tenant: "tenant-a", amountCents: 500_00, pi: "pi_abc" });

describe("REQ-154 — the composition root selects DARK by default, live only when the secret is bound", () => {
  it("billingFor with NO secret → NotConfiguredBilling (DARK)", () => {
    const { STRIPE_WEBHOOK_SECRET: _omit, ...dark } = env; // the secret key absent — the real DARK shape
    void _omit;
    expect(billingFor(dark)).toBeInstanceOf(NotConfiguredBilling);
  });

  it("billingFor with an empty secret is still DARK (an unset `wrangler secret` reads as '')", () => {
    const dark: BillingEnv = { ...env, STRIPE_WEBHOOK_SECRET: "" };
    expect(billingFor(dark)).toBeInstanceOf(NotConfiguredBilling);
  });

  it("billingFor with a bound secret → StripeBilling (the live client)", () => {
    const live: BillingEnv = { ...env, STRIPE_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET };
    expect(billingFor(live)).toBeInstanceOf(StripeBilling);
  });
});

describe("DARK — NotConfiguredBilling rejects loudly (a silent no-op is forbidden)", () => {
  it("verify() rejects with BillingNotConfiguredError, never resolves", async () => {
    const billing = new NotConfiguredBilling();
    await expect(billing.verify()).rejects.toBeInstanceOf(BillingNotConfiguredError);
  });

  it("the rejection names the missing secret + the R4/wrangler-secret remedy (actionable, not silent)", async () => {
    const billing = new NotConfiguredBilling();
    await expect(billing.verify()).rejects.toThrow(/STRIPE_WEBHOOK_SECRET/);
    await expect(billing.verify()).rejects.toThrow(/DARK until R4/);
  });
});

describe("REQ-154 — StripeBilling verifies the raw Stripe signature (constant-time), fail-closed", () => {
  it("accepts a validly-signed body and returns the typed event", async () => {
    const billing = new StripeBilling(TEST_WEBHOOK_SECRET);
    const sig = await signStripe(SAMPLE_BODY);
    const event = await billing.verify(SAMPLE_BODY, sig);
    expect(event.id).toBe("evt_1");
    expect(event.type).toBe("checkout.session.completed");
    expect(event.data.object["payment_intent"]).toBe("pi_abc");
  });

  it("rejects a MISSING signature header (unsigned ⇒ fail-closed)", async () => {
    const billing = new StripeBilling(TEST_WEBHOOK_SECRET);
    await expect(billing.verify(SAMPLE_BODY, null)).rejects.toBeInstanceOf(BillingSignatureError);
    await expect(billing.verify(SAMPLE_BODY, "")).rejects.toBeInstanceOf(BillingSignatureError);
  });

  it("rejects a malformed signature header (no t/v1)", async () => {
    const billing = new StripeBilling(TEST_WEBHOOK_SECRET);
    await expect(billing.verify(SAMPLE_BODY, "garbage")).rejects.toBeInstanceOf(BillingSignatureError);
  });

  it("rejects a signature made with the WRONG secret (MAC mismatch)", async () => {
    const billing = new StripeBilling(TEST_WEBHOOK_SECRET);
    const sig = await signStripe(SAMPLE_BODY, "whsec_the_wrong_secret");
    await expect(billing.verify(SAMPLE_BODY, sig)).rejects.toBeInstanceOf(BillingSignatureError);
  });

  it("rejects a TAMPERED body (signature valid for the original, not the received bytes)", async () => {
    const billing = new StripeBilling(TEST_WEBHOOK_SECRET);
    const sig = await signStripe(SAMPLE_BODY); // signed over SAMPLE_BODY
    const tampered = SAMPLE_BODY.replace("50000", "999999999");
    await expect(billing.verify(tampered, sig)).rejects.toBeInstanceOf(BillingSignatureError);
  });

  it("rejects a STALE timestamp outside the tolerance (replay window)", async () => {
    // `now` fixed far in the future so a fresh signature's t is way outside the 300s window.
    const future = Date.now() + 3_600_000;
    const billing = new StripeBilling(TEST_WEBHOOK_SECRET, { now: () => future, toleranceSec: 300 });
    const sig = await signStripe(SAMPLE_BODY); // t ≈ real now
    await expect(billing.verify(SAMPLE_BODY, sig)).rejects.toBeInstanceOf(BillingSignatureError);
  });

  it("accepts when now matches the signed timestamp (the same clock injected)", async () => {
    const fixed = Date.UTC(2026, 6, 15, 9, 0, 0);
    const billing = new StripeBilling(TEST_WEBHOOK_SECRET, { now: () => fixed });
    const sig = await signStripe(SAMPLE_BODY, TEST_WEBHOOK_SECRET, Math.floor(fixed / 1000));
    const event = await billing.verify(SAMPLE_BODY, sig);
    expect(event.id).toBe("evt_1");
  });
});
