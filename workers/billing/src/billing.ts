// WP-14 Task 7 · REQ-123/154 — THE STRIPE BILLING CLIENT (DARK until R4).
//
// This is the money-facing boundary: it VERIFIES a Stripe webhook signature and returns the typed event, or it
// REJECTS loudly. It never charges and never emits — the credit flow (credits.ts) runs only AFTER a signature
// verifies. Mirrors the EvidenceSender port discipline (packages/agents/src/biller/sender.ts):
//   · NotConfiguredBilling is the DEFAULT when no Stripe secret is bound. A silent no-op is forbidden (an
//     operator must never believe a webhook was processed when nothing is wired), so it REJECTS loudly. DARK
//     posture: nothing charges/emits until an operator binds STRIPE_WEBHOOK_SECRET at R4.
//   · StripeBilling is the live adapter, selected by billingFor() ONLY when the secret is bound. The secret is
//     operator-injected via `wrangler secret` — NEVER in wrangler.toml (REQ-154/134).
//
// The signature check is the RAW Stripe scheme (no Stripe SDK in the repo — none is added): the `Stripe-Signature`
// header carries `t=<unix-seconds>,v1=<hex-hmac>[,v1=...]`; the signed payload is `${t}.${rawBody}`; the MAC is
// HMAC-SHA256 keyed by the FULL endpoint secret string (`whsec_...`), compared CONSTANT-TIME against every v1.
// A timestamp-tolerance check (default 5 min) closes the replay window (idempotency in credits.ts is the second
// line). Unsigned / malformed / mismatched / stale ⇒ reject; only a verified body is parsed and returned.
import { z } from "@shuddl/contracts";
import type { BillingEnv } from "./tenants.js";

// The minimal Stripe webhook envelope the worker consumes. Stripe sends far more; unknown keys are dropped.
// `data.object` stays an opaque record — the per-type emitter (credits.ts) parses the fields it needs with Zod.
export const StripeWebhookEventSchema = z
  .object({
    id: z.string().min(1), // evt_… — the redelivery-stable event id
    type: z.string().min(1), // "checkout.session.completed" | "invoice.paid" | "payment_intent.succeeded" | …
    created: z.number().int().nonnegative(), // unix seconds — the event's business clock (period bucketing; no clock read)
    data: z.object({ object: z.record(z.string(), z.unknown()) }),
  })
  .strip();
export type StripeWebhookEvent = z.infer<typeof StripeWebhookEventSchema>;

/** No provider bound (DARK). Thrown by NotConfiguredBilling.verify — the webhook maps it to a loud 503, emits
 *  nothing. Distinct from BillingSignatureError so the two failures are never confused: one needs configuration
 *  (an operator binds the secret at R4), the other is a rejected/forged request. */
export class BillingNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingNotConfiguredError";
  }
}

/** The signature did not verify (missing/malformed header, stale timestamp, or MAC mismatch). Fail-closed:
 *  nothing downstream runs. Maps to a 400. */
export class BillingSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingSignatureError";
  }
}

export interface Billing {
  /**
   * Verify the Stripe signature over the RAW request body and return the typed event, or reject LOUDLY.
   * NotConfiguredBilling always rejects (DARK) — nothing is processed until a secret is bound.
   */
  verify(rawBody: string, signatureHeader: string | null): Promise<StripeWebhookEvent>;
}

/**
 * The DARK default — no Stripe secret bound. Rejects loudly and actionably; a silent no-op would let an operator
 * believe a webhook was processed when nothing is wired. Never touches the network, never emits.
 */
export class NotConfiguredBilling implements Billing {
  // async so the rejection is a REJECTED promise, never a sync throw a caller's try could mis-handle.
  async verify(): Promise<never> {
    throw new BillingNotConfiguredError(
      "Billing is NOT CONFIGURED: no STRIPE_WEBHOOK_SECRET is bound in this environment, so the Stripe webhook " +
        "was NOT verified and NOTHING was charged, emitted, or projected. PLG is DARK until R4 — binding the " +
        "operator-injected secret (`wrangler secret`, NEVER wrangler.toml — REQ-154) selects the live client. " +
        "See docs/wp/WP-14.md.",
    );
  }
}

// ---- constant-time helpers -------------------------------------------------------------------------
async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Length-checked XOR accumulation — no early return on the first differing byte (that would leak position via
// timing). Equal-length hex strings only reach the loop; a length mismatch is a definite non-match.
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Parse `t=…,v1=…[,v1=…][,v0=…]` → the timestamp + every v1 candidate. Tolerant of whitespace and unknown
// schemes (v0 etc. are ignored). Returns null when no timestamp or no v1 is present.
function parseSignatureHeader(header: string): { t: number; v1: string[] } | null {
  let t: number | undefined;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") t = Number(v);
    else if (k === "v1" && v.length > 0) v1.push(v);
  }
  if (t === undefined || !Number.isFinite(t) || v1.length === 0) return null;
  return { t, v1 };
}

export interface StripeBillingOptions {
  /** Injected for the tolerance test; defaults to Date.now. */
  now?: () => number;
  /** Replay window in seconds (default 300 — Stripe's documented default). */
  toleranceSec?: number;
}

/**
 * The live client — verifies the raw Stripe webhook signature. Selected by billingFor() only when the secret is
 * bound. Written now so going live at R4 is a config flip (bind the secret), not a code task.
 */
export class StripeBilling implements Billing {
  private readonly secret: string;
  private readonly now: () => number;
  private readonly toleranceSec: number;

  constructor(secret: string, options: StripeBillingOptions = {}) {
    this.secret = secret;
    this.now = options.now ?? (() => Date.now());
    this.toleranceSec = options.toleranceSec ?? 300;
  }

  async verify(rawBody: string, signatureHeader: string | null): Promise<StripeWebhookEvent> {
    if (signatureHeader === null || signatureHeader === "") {
      throw new BillingSignatureError("missing Stripe-Signature header — unsigned webhook rejected (fail-closed)");
    }
    const parsed = parseSignatureHeader(signatureHeader);
    if (parsed === null) {
      throw new BillingSignatureError("malformed Stripe-Signature header — no t/v1 pair");
    }
    // Replay window: a timestamp far from now is rejected even if the MAC is valid (a captured-and-replayed
    // request). Idempotency (credits.ts) is the second line; this is the first.
    const nowSec = Math.floor(this.now() / 1000);
    if (Math.abs(nowSec - parsed.t) > this.toleranceSec) {
      throw new BillingSignatureError(`Stripe-Signature timestamp ${parsed.t} outside the ${this.toleranceSec}s tolerance (replay?)`);
    }
    const expected = await hmacSha256Hex(this.secret, `${parsed.t}.${rawBody}`);
    // CONSTANT-TIME over every candidate: a forged body / wrong secret matches none.
    const ok = parsed.v1.some((candidate) => constantTimeEqual(expected, candidate));
    if (!ok) {
      throw new BillingSignatureError("Stripe-Signature v1 mismatch — the body was not signed by the bound secret");
    }
    // ONLY a verified body is parsed. A verified-but-non-JSON body is a Stripe/proxy fault, surfaced loudly.
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw new BillingSignatureError("verified webhook body is not valid JSON");
    }
    return StripeWebhookEventSchema.parse(json);
  }
}

/**
 * The composition root (REQ-154). Selects the live client ONLY when the operator-injected secret is bound;
 * otherwise DARK (NotConfiguredBilling, rejects loudly). The SAME discipline as the Biller's evidenceSender
 * and the api's LLM binding: the secret is read HERE, never inside the client, and NEVER from wrangler.toml.
 */
export function billingFor(env: BillingEnv): Billing {
  const secret = env.STRIPE_WEBHOOK_SECRET;
  return secret !== undefined && secret !== "" ? new StripeBilling(secret) : new NotConfiguredBilling();
}
