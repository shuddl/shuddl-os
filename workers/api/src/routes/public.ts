import type { Hono } from "hono";
import { publicStatusHandler } from "../pub/status.js";
import { publicQuoteHandler } from "../pub/quote.js";
import type { Env, Vars } from "../index.js";

// REQ-187/188 (WP-09) — the PUBLIC, no-auth surface. Mounted at the `/pub/*` prefix, which by construction
// does NOT match `app.use("/v1/*", auth)` or `app.use("/v1/*", idempotency)` — so NO session middleware runs
// here. That is the whole point: these routes are unauthenticated by design, and each carries its own
// capability check (the status cap; Task 4's quote token). Keep this the ONE place /pub routes are declared
// so the "no auth on /pub" property is verifiable in one glance.
export function mountPublicRoutes(app: Hono<{ Bindings: Env; Variables: Vars }>): void {
  // GET /pub/status/:cap — the forwardable public status page for ONE shipment. verifyStatusCap is the gate.
  app.get("/pub/status/:cap", publicStatusHandler);
  // POST /pub/quote (REQ-051/189) — the no-auth GUEST QUOTE. A pure price PREVIEW: it prices via the engine
  // and appends NOTHING to the ledger ("guest may QUOTE, never BOOK"). Tenant resolves from the CF-routed
  // hostname (HOST_TENANTS), never a header. No auth/idempotency middleware runs here (it is /pub/*, not /v1/*).
  app.post("/pub/quote", publicQuoteHandler);
}
