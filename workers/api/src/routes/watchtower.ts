import type { Hono } from "hono";
import { ApiError } from "../middleware/error.js";
import { requireRole } from "../middleware/auth.js";
import { tenantDb } from "../tenants.js";
import type { Env, Vars } from "../index.js";

// WP-11 Task 8 (REQ-036) — the Watchtower READ. A thin, tenant-scoped list over the durable `anomalies` alarms
// the Watchtower cron (workers/agents/src/watchtower.ts) UPSERTs: unbilled, pricing_anomaly, floor_breach. The
// alarm STORE is the deliverable; this read merely surfaces the open alarms to the command surface. NO new
// table, NO new event kind, NO projection — a pure read over the existing `anomalies` table.
//
// Tenant comes from the JWT claim ONLY (tenantDb) — never a header/query param (REQ-025). roles admin/ops/
// finance (the command-lens roles that action alarms; a portal party/driver has no watchtower). Default lists
// OPEN alarms; ?status=all surfaces resolved ones too (history), ?status=resolved just the cleared. An unknown
// status is a hard 400 (mirrors approvals.ts / exceptions.ts), never a silent empty result.

const STATUS_VALUES: ReadonlySet<string> = new Set(["open", "resolved", "all"]);

interface AlarmRow {
  id: string;
  rule: string;
  object_kind: string | null;
  object_id: string | null;
  severity: string;
  detail: string;
  status: string;
}

// Rank most-urgent first so the command surface reads criticals before warns. A stable secondary sort by id
// keeps the list deterministic across ties (the anomalies table has no created_ts column).
const SEVERITY_RANK: Record<string, number> = { critical: 0, warn: 1, info: 2 };

export function mountWatchtowerRoutes(app: Hono<{ Bindings: Env; Variables: Vars }>): void {
  app.get("/v1/watchtower", requireRole("admin", "ops", "finance"), async (c) => {
    const session = c.get("session");
    const db = tenantDb(c.env, session.tenant); // REQ-025 — D1 keyed off the claim only

    const status = c.req.query("status") ?? "open";
    if (!STATUS_VALUES.has(status)) throw new ApiError("VALIDATION_FAILED", 400, "status MUST BE open, resolved OR all");

    const where = status === "all" ? "" : " WHERE status = ?";
    const stmt = db.prepare(`SELECT id, rule, object_kind, object_id, severity, detail, status FROM anomalies${where}`);
    const bound = status === "all" ? stmt : stmt.bind(status);
    const res = await bound.all<AlarmRow>();

    // Parse each detail JSON for the caller (the column is a JSON string). A malformed detail degrades to the
    // raw string rather than 500ing the whole read (best-effort surface; the alarm's rule/severity still land).
    const alarms = res.results
      .map((r) => {
        let detail: unknown;
        try {
          detail = JSON.parse(r.detail);
        } catch {
          detail = r.detail;
        }
        return { id: r.id, rule: r.rule, object_kind: r.object_kind, object_id: r.object_id, severity: r.severity, status: r.status, detail };
      })
      .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) || a.id.localeCompare(b.id));

    return c.json({ alarms });
  });
}
