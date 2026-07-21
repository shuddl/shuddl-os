// WP-14 Task 6 · REQ-123 — THE BILLING WORKER ENTRY. It owns the cross-DB metering recompute sweep
// (cron-driven). It BINDS to existing resources (the per-tenant D1s + the control-plane D1) — it never owns or
// migrates them, and it adds NO table (a scheduled worker is not a table).
//
// The metering write is a SCHEDULED RECOMPUTE, not a sequencer batch, precisely because the two databases are
// separate: the metered unit lives in each tenant's D1 (`agent_runs`, one row per committed `agent.acted`)
// while the meter target lives in the control plane (`usage_credits.metered`). A single-DB batch cannot span
// them, so the sweep recomputes {agent: count} per (tenant, period) from the ledger and OVERWRITES the control
// row — drift-free by construction (a full replace, never a += counter).
import { runMeteringSweep } from "./metering.js";
import { handleStripeWebhook } from "./webhook.js";
import type { BillingEnv } from "./tenants.js";

export default {
  // The ONLY public HTTP surface is the Stripe webhook (Stripe-authed via the signature, NOT customer-authed) —
  // plus a health probe. The metering recompute is cron-driven (scheduled()), never a route. Every other
  // path/method 404s (defensive; workers_dev = false keeps it off the auto subdomain).
  async fetch(request: Request, env: BillingEnv, ctx: ExecutionContext): Promise<Response> {
    void ctx;
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }
    // WP-14 Task 7 (REQ-123/154) — the credit-purchase webhook. DARK until an operator binds STRIPE_WEBHOOK_SECRET
    // at R4: billingFor → NotConfiguredBilling rejects loudly (503) and nothing charges/emits. Verified events drive
    // the credit money-event flow on the PLATFORM tenant (resolved server-side; a customer JWT can never reach it).
    if (request.method === "POST" && url.pathname === "/webhooks/stripe") {
      return handleStripeWebhook(request, env);
    }
    return new Response("Not Found", { status: 404 });
  },
  // REQ-123 — the metering recompute. Per-tenant fault isolation lives inside runMeteringSweep (one tenant's
  // failure never aborts the rest), and the whole sweep is idempotent (OVERWRITE, not +=), so re-running each
  // cron tick is safe.
  async scheduled(controller: ScheduledController, env: BillingEnv, ctx: ExecutionContext): Promise<void> {
    void controller;
    void ctx;
    await runMeteringSweep(env);
  },
};
