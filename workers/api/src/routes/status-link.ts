import type { Hono } from "hono";
import { lensFor, readEvents } from "@shuddl/ledger/lens";
import { ApiError } from "../middleware/error.js";
import { requireRole } from "../middleware/auth.js";
import { resolveTenantDb } from "../tenants.js";
import { mintStatusCap } from "../pub/status-cap.js";
import type { Env, Vars } from "../index.js";

// REQ-187 (WP-09, D1 half A) — mint a status-cap link, LENS-SCOPED to the caller. A portal party may mint
// a public status link ONLY for a shipment its own lens can see; ops/admin (tenant lens) are unrestricted.
// The public read that consumes the cap is Task 3 — this route only ISSUES caps.

const CAP_TTL_SECONDS = 30 * 24 * 3600; // 30 days (matches the exp baked into the cap)

export function mountStatusLinkRoutes(app: Hono<{ Bindings: Env; Variables: Vars }>): void {
  // POST /v1/shipments/:id/status-link — AUTHED (under /v1/*, so auth + idempotency already ran). The role
  // set is the two tenant-scope operational roles (admin/ops) PLUS portal (the party self-service case).
  // finance/read/driver are intentionally NOT mint-capable here (fail-closed; widen only on an explicit REQ).
  app.post("/v1/shipments/:id/status-link", requireRole("admin", "ops", "portal"), async (c) => {
    const session = c.get("session");
    // `?? ""` keeps this fail-closed (mirrors events.ts): an absent :id yields an empty shipment id, which
    // matches no events under any lens -> visibleCount 0 -> 403. It never reaches the cap as a real id.
    const id = c.req.param("id") ?? "";
    const db = await resolveTenantDb(c.env, session.tenant);

    // The mint-authorization gate. Resolve :id through the caller's LENS exactly as GET /v1/shipments/:id/
    // events does: a portal party's lens narrows to visibility<>'internal' AND party_refs∋party_id, so a
    // lens-scoped read returns >=1 row ONLY if the caller is a party on the shipment. ops/admin => tenant
    // lens (1=1) => any in-tenant shipment with events. Zero visible rows => the caller cannot see it => 403
    // (fail-closed). This reuses the SAME lens seam as the events read, so mint scope can never drift from
    // read scope.
    let visibleCount: number;
    try {
      const lens = lensFor(session);
      const events = await readEvents(db, lens, { shipment_id: id, limit: 1 });
      visibleCount = events.length;
    } catch (e) {
      // lensFor throws LENS_UNRESOLVED for a portal session missing party_id — surface it as a clean 403.
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith("LENS_UNRESOLVED")) throw new ApiError("FORBIDDEN", 403, "SESSION LENS UNRESOLVED");
      throw e;
    }
    if (visibleCount === 0) throw new ApiError("FORBIDDEN", 403, "SHIPMENT NOT IN YOUR SCOPE");

    // Mint. `t` comes from session.tenant ONLY — NEVER from :id or any client input — so a cap can never
    // be minted for a tenant the caller is not authenticated into. exp is absolute (now + 30 days).
    const expSeconds = Math.floor(Date.now() / 1000) + CAP_TTL_SECONDS;
    const cap = await mintStatusCap(c.env.JWT_SECRET, { t: session.tenant, s: id, expSeconds });

    // Relative /pub path only — the host is deploy-config, never a hardcoded real domain (REQ-167).
    return c.json({ cap, url: `/pub/status/${cap}` });
  });
}
