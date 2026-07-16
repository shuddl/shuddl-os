import type { Hono } from "hono";
import { publicStatusHandler } from "../pub/status.js";
import type { Env, Vars } from "../index.js";

// REQ-187/188 (WP-09) — the PUBLIC, no-auth surface. Mounted at the `/pub/*` prefix, which by construction
// does NOT match `app.use("/v1/*", auth)` or `app.use("/v1/*", idempotency)` — so NO session middleware runs
// here. That is the whole point: these routes are unauthenticated by design, and each carries its own
// capability check (the status cap; Task 4's quote token). Keep this the ONE place /pub routes are declared
// so the "no auth on /pub" property is verifiable in one glance.
export function mountPublicRoutes(app: Hono<{ Bindings: Env; Variables: Vars }>): void {
  // GET /pub/status/:cap — the forwardable public status page for ONE shipment. verifyStatusCap is the gate.
  app.get("/pub/status/:cap", publicStatusHandler);
  // Task 4 (REQ-188 /pub/quote) joins this mount.
}
