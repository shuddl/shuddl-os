import type { Hono } from "hono";
import { requireRole } from "../middleware/auth.js";
import { resolveTenantDb } from "../tenants.js";
import { computeAllParity, type ModuleParity } from "@shuddl/ledger/parity";
import type { Env, Vars } from "../index.js";

// WP-15 Task 6 (REQ-023 / REQ-152 / REQ-153) — the v_parity BACKEND COMPUTE. GET /v1/parity surfaces the
// per-module native-vs-legacy shadow parity for the Command v_parity dashboard (Task 7 renders it). Each entry is
// a ModuleParity from the SHARED primitive (@shuddl/ledger/parity) — a REAL number OR the literal "UNKNOWN",
// with backing_kinds for drill-through — so the number the flip gate (Task 3) enforces, the number the
// Watchtower (Task 8) alarms on, and the number this dashboard shows are the SAME computation (no drift). This
// route REUSES computeAllParity; it never recomputes parity a second way.
//
// Mirrors the KPI route (routes/kpis.ts): a DURABLE READ over the append-only `events` split by `source` — NO
// new table, NO event kind, NO projection. Tenant-scoped off the JWT claim ONLY (resolveTenantDb(session.tenant),
// REQ-025) — never a header/query param (auth rejects those at the door). Role-gated to the tenant-lens roles
// (admin/ops/finance/read), exactly like the KPI strip: a portal party / driver has no command dashboard.
//
// TODAY, before the Task-4 legacy mirror exists, every module is honestly UNKNOWN (no `source:'legacy'` events),
// and the dashboard shows that truthfully — never a fabricated green.

export function mountParityRoutes(app: Hono<{ Bindings: Env; Variables: Vars }>): void {
  app.get("/v1/parity", requireRole("admin", "ops", "finance", "read"), async (c) => {
    const session = c.get("session");
    const db = await resolveTenantDb(c.env, session.tenant);
    const modules: ModuleParity[] = await computeAllParity(db);
    return c.json({ modules });
  });
}
