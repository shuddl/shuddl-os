import type { Hono } from "hono";
import { lensFor } from "@shuddl/ledger/lens";
import { ApiError } from "../middleware/error.js";
import { resolveTenantDb } from "../tenants.js";
import type { Env, Vars } from "../index.js";

// REQ-085 (WP-09 Task 7) — the PORTAL INVOICES list. GET /v1/invoices returns the `invoices` read-model
// HEADERS scoped to the caller's lens, derived from the JWT claim ONLY (tenantDb + lensFor) — never a
// header/query/:id:
//   - party lens (portal):        ONLY invoices billed to the claim party (invoices.party_id = party_id).
//   - tenant lens (admin/ops/finance/read): every in-tenant invoice.
//   - driver lens (driver PWA):   a driver has no billing relationship — empty list (fail-closed).
//
// The list is the SUMMARY only. `division` (internal org unit / margin dimension, REQ-057) is DELIBERATELY
// absent from the PARTY projection, and gl_map (margin/chart-of-accounts) never rides this table at all —
// margin/GL internals must not reach a counterparty list (REQ-179, the same law redact.ts enforces on the
// invoice.issued EVENT). The tenant projection keeps division: it is the tenant's own filterable dimension.

// Portal-SAFE summary columns — NO division (internal), NO issued_event_id (ledger internal ref).
const INVOICE_COLS_PARTY = "id, party_id, shipment_ids, total_cents, status, due_ts";
// Tenant summary — division is legitimately the tenant's own dimension (REQ-057, filterable everywhere).
const INVOICE_COLS_TENANT = "id, party_id, division, shipment_ids, total_cents, status, issued_event_id, due_ts";

// lensFor throws Error("LENS_UNRESOLVED: …") for a portal session missing party_id — surface it as a clean
// 403 instead of an opaque 500. Anything else rethrows as-is (mirrors documents.ts / status-link.ts).
function toLensError(e: unknown): unknown {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.startsWith("LENS_UNRESOLVED")) return new ApiError("FORBIDDEN", 403, "SESSION LENS UNRESOLVED");
  return e;
}

export function mountInvoiceRoutes(app: Hono<{ Bindings: Env; Variables: Vars }>): void {
  // GET /v1/invoices — the caller's invoices through its lens. No requireRole: the lens IS the gate
  // (mirrors the documents/events reads). The party lens binds party_id from the CLAIM, so a forged
  // ?party_id never widens it. The D1 handle is claim-keyed (tenantDb, REQ-025) — a cross-tenant read
  // is impossible: a session only ever touches its own tenant's `invoices`.
  app.get("/v1/invoices", async (c) => {
    const session = c.get("session");
    const db = await resolveTenantDb(c.env, session.tenant);
    try {
      const lens = lensFor(session);
      if (lens.scope === "driver") return c.json({ invoices: [] }); // no billing relationship — fail-closed
      if (lens.scope === "party") {
        const res = await db
          .prepare(`SELECT ${INVOICE_COLS_PARTY} FROM invoices WHERE party_id = ? ORDER BY id`)
          .bind(lens.partyId)
          .all();
        return c.json({ invoices: res.results });
      }
      // tenant lens (admin/ops/finance/read): every in-tenant invoice, division included.
      const res = await db.prepare(`SELECT ${INVOICE_COLS_TENANT} FROM invoices ORDER BY id`).all();
      return c.json({ invoices: res.results });
    } catch (e) {
      throw toLensError(e);
    }
  });
}
