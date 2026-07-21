import type { Context, Hono } from "hono";
import { z } from "zod";
import { PLATFORM_TENANT_ID } from "@shuddl/contracts";
import { ApiError } from "../middleware/error.js";
import { resolvePlatformTenantDb } from "../tenants.js";
import { translateAppendError, type SeqStub } from "./events.js";
import type { AppendedEvent } from "../do/sequencer.js";
import type { Env, Vars } from "../index.js";

// WP-14 Task 10 (REQ-123/025/003) — THE INTERNAL PLATFORM-CREDIT APPEND SEAM (server-to-server ONLY).
//
// The billing worker's credit flow (Stripe credit-pack sale → an invoice.issued kind='credit_purchase', its
// settlement → a payment.received) must land as MONEY EVENTS on the reserved `_platform` revenue tenant, PROJECTED
// through the REAL sequencer (never a direct money_lines write — REQ-003, and never billing's own D1 mirror). The
// sequencer resolves `_platform` ONLY when the append carries `platform: true` (do/sequencer.ts #resolveDb), and
// that flag is set ONLY HERE — a customer /v1 route hard-codes append WITHOUT it, and this route is NOT a /v1
// route (it sits outside app.use("/v1/*", auth)). So the ISOLATION INVARIANT holds structurally: a customer JWT
// can never reach a `_platform` append, and this internal route is the single, secret-gated door that can.
//
// FAIL-CLOSED (mirrors the billing worker's NotConfigured discipline + the provisioning DARK flag):
//   · PLATFORM_INTERNAL_SECRET UNBOUND ⇒ 503, no append possible (DARK until R4, alongside the Stripe secret).
//   · a missing / wrong `X-Platform-Internal` header ⇒ 403 (constant-time compared). Nothing appends.
// There is NO customer-influenced input on the tenant resolution: the tenant is the fixed PLATFORM_TENANT_ID
// sentinel (never read from the request), and the caller is the Stripe-authed billing worker over the service
// binding. The event payload still flows through the DO's EventInput.parse + the `_platform` visibility clamp, so
// even this internal caller cannot forge seq/prev_hash/hash or widen a credit event past `internal`.

type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

// Length-checked XOR accumulation — no early return on the first differing byte (mirrors billing.ts
// constantTimeEqual). Equal-length strings only reach the loop; a length mismatch is a definite non-match.
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// The shared-secret gate. Returns an ApiError to THROW (fail-closed) or null when authorized. DARK (unbound
// secret) is a 503; a missing/mismatched header is a 403. Never reveals which (no oracle beyond dark-vs-not).
function internalGate(c: Ctx): ApiError | null {
  const secret = c.env.PLATFORM_INTERNAL_SECRET;
  if (secret === undefined || secret === "") {
    return new ApiError("INTERNAL", 503, "PLATFORM CREDIT PATH NOT CONFIGURED");
  }
  const provided = c.req.header("X-Platform-Internal");
  if (provided === undefined || !constantTimeEqual(provided, secret)) {
    return new ApiError("FORBIDDEN", 403, "FORBIDDEN");
  }
  return null;
}

// The append body: the credit stream id + the client-suppliable EventInput (the DO re-parses it — never trust
// this shape as an event). Kept loose here (streamId string + input object); the sequencer's EventInput.parse is
// the real validator, and its refusal is translated by translateAppendError exactly as a /v1 append is.
const AppendBody = z.object({ streamId: z.string().min(1).max(256), input: z.record(z.string(), z.unknown()) }).strict();

// The settle catch-up body — the re-runnable AR flip (finding A) the emitter runs after appending a
// payment.received, so an out-of-order (settlement-before-sale) webhook still flips the credit invoice to 'paid'.
const SettleBody = z
  .object({ invoiceId: z.string().min(1).max(256), paymentEventId: z.string().min(1).max(256), amountCents: z.number().int().nonnegative() })
  .strict();

export function mountInternalPlatformRoutes(app: Hono<{ Bindings: Env; Variables: Vars }>): void {
  // POST /internal/platform/credit-append — append ONE credit money event to `_platform` through the real
  // sequencer. The tenant is the fixed sentinel (never client-supplied); the DO id is derived from it, so this
  // instance can only ever bind the platform D1. `platform: true` is the ONLY thing that opens the `_platform`
  // door in #resolveDb; a redelivery re-derives the same event id and the sequencer dedups (idempotent, once-out).
  app.post("/internal/platform/credit-append", async (c) => {
    const denied = internalGate(c);
    if (denied) throw denied;

    const parsed = AppendBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError("VALIDATION_FAILED", 400, "INVALID CREDIT APPEND BODY");
    const { streamId, input } = parsed.data;

    const stub = c.env.SHIPMENT_SEQ.get(
      c.env.SHIPMENT_SEQ.idFromName(`${PLATFORM_TENANT_ID}|${streamId}`),
    ) as unknown as SeqStub;
    let event: AppendedEvent;
    try {
      event = await stub.append({ tenant: PLATFORM_TENANT_ID, streamId, input, platform: true });
    } catch (e) {
      throw translateAppendError(e);
    }
    return c.json({ id: event.id }, 200);
  });

  // POST /internal/platform/credit-settle — the re-runnable AR settle catch-up on the platform D1. It NEVER
  // invents a paid state: it flips the credit invoice 'issued' → 'paid' ONLY when a covering payment.received is
  // already committed on the ledger AND the invoice total is covered. Idempotent (a no-op once paid). This is a
  // legitimate read-model projection write (invoices is mutable — the same UPDATE money.ts issues), resolved
  // SERVER-SIDE via resolvePlatformTenantDb (no slug input), so no customer path can reach it.
  app.post("/internal/platform/credit-settle", async (c) => {
    const denied = internalGate(c);
    if (denied) throw denied;

    const parsed = SettleBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError("VALIDATION_FAILED", 400, "INVALID CREDIT SETTLE BODY");
    const { invoiceId, paymentEventId, amountCents } = parsed.data;

    const db = resolvePlatformTenantDb(c.env);
    const backing = await db
      .prepare("SELECT 1 AS present FROM events WHERE id = ? AND kind = 'payment.received'")
      .bind(paymentEventId)
      .first<{ present: number }>();
    if (backing === null) return c.json({ ok: true, settled: false }); // no payment event yet — nothing legitimately settles
    const res = await db
      .prepare("UPDATE invoices SET status = 'paid' WHERE id = ? AND status = 'issued' AND total_cents <= ?")
      .bind(invoiceId, amountCents)
      .run();
    return c.json({ ok: true, settled: (res.meta.changes ?? 0) > 0 });
  });
}
