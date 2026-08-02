import type { Hono } from "hono";
import { publicStatusHandler } from "../pub/status.js";
import { publicQuoteHandler } from "../pub/quote.js";
import type { Env, Vars } from "../index.js";

// REQ-187/188 (WP-09) — the PUBLIC, no-auth surface. Mounted at the `/pub/*` prefix, which by construction
// does NOT match `app.use("/v1/*", auth)` or `app.use("/v1/*", idempotency)` — so NO session middleware runs
// here. That is the whole point: these routes are unauthenticated by design, and each carries its own
// capability check (the status cap; Task 4's quote token). ~~Keep this the ONE place /pub routes are
// declared so the "no auth on /pub" property is verifiable in one glance.~~ CORRECTED 2026-08-01
// (convergence audit): two further /pub routes are declared elsewhere — GET /pub/documents/:cap
// (routes/documents.ts) and POST /pub/signup (routes/signup.ts). Verify the property across those THREE
// files; it still holds structurally, because index.ts mounts auth on /v1/* only.
//
// REQ-193 (WP-09 exit audit) — ABUSE CONTROL IS AT THE EDGE, NOT HERE. These are unauthenticated endpoints
// that each do 1-2 D1 reads (status_cache/positions, or loadTenantRatingConfig+priceShipment), so a per-IP
// Cloudflare edge rate-limit rule on `/pub/*` (plus optional Turnstile on /pub/quote) is a DEPLOY prerequisite
// before the public surface is GA. In-Worker rate limiting is deliberately NOT added: it would burn Worker
// invocations on attack traffic and duplicate a platform control. Provision the CF rule before public launch.
export function mountPublicRoutes(app: Hono<{ Bindings: Env; Variables: Vars }>): void {
  // GET /pub/status/:cap — the forwardable public status page for ONE shipment. verifyStatusCap is the gate.
  app.get("/pub/status/:cap", publicStatusHandler);
  // POST /pub/quote (REQ-051/189) — the no-auth GUEST QUOTE. A pure price PREVIEW: it prices via the engine
  // and appends NOTHING to the ledger ("guest may QUOTE, never BOOK"). Tenant resolves from the CF-routed
  // hostname (HOST_TENANTS), never a header. No auth/idempotency middleware runs here (it is /pub/*, not /v1/*).
  app.post("/pub/quote", publicQuoteHandler);
}
