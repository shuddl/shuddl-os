import type { Hono } from "hono";
import type { EventKind } from "@shuddl/contracts";
import { requireRole } from "../middleware/auth.js";
import { tenantDb } from "../tenants.js";
import {
  computeUnbilled,
  computeOtdBps,
  computeDwellMinutes,
  computeLanePnl,
  computeDsoDays,
  computeCostRatioBps,
  type KpiValue,
  type LaneEntry,
} from "../kpis/compute.js";
import type { Env, Vars } from "../index.js";

// WP-10 Task 5 (REQ-083) — THE KPI STRIP. GET /v1/kpis returns the 6 tiles, each a REAL number computed from
// real ledger rows and DRILLABLE to its backing events, OR the literal "UNKNOWN" — NEVER a fabricated/placeholder
// number (the L3 / "no price on air" ethos for KPIs; every UNKNOWN condition is documented on its compute fn).
// A DURABLE READ over the existing rows/events: NO new table, NO event kind, NO projection. Tenant-scoped off the
// JWT claim ONLY (tenantDb(session.tenant), REQ-025) — never a header/query param (auth rejects those at the door).
//
// backing = { kinds } lets the UI DEEP-LINK each tile to GET /v1/events?kind=<kinds> (the Task-1 kind filter) so
// every KPI clicks through to the exact events that back it — the DoD ("every KPI clicks through to its ledger
// events"). The kinds are the ledger source of each number, so the same kind-filtered read the UI issues returns
// precisely that tile's backing events.
//
// THE OR (tile 6) HONESTY FRAMING: there is NO true operating-cost event kind (money_lines AP = interline +
// settlement fees only, NOT linehaul/driver/asset op-cost), so a literal AP/AR would be an INTERLINE ratio and
// labeling it "Operating Ratio" would FABRICATE a meaning. So tile 6 is a clearly-labeled cost/revenue ratio from
// the rater's quoted cost basis (floors.full over sell) — key "or", label "Cost/Rev (quoted basis)", NEVER a bare
// "Operating Ratio". See computeCostRatioBps.

export interface KpiTile {
  key: string; // machine key
  label: string; // HONEST human label (esp. the OR tile — never implies true op-cost)
  value: KpiValue; // a real number OR the literal "UNKNOWN" — never a fabricated placeholder
  unit: "count" | "bps" | "min" | "cents" | "days";
  backing: { kinds: EventKind[] }; // the ledger kinds behind the number; fed to GET /v1/events?kind= for click-through
  lanes?: LaneEntry[]; // lane_pnl breakdown only (each entry is a real lane key or the literal "UNKNOWN")
}

export function mountKpiRoutes(app: Hono<{ Bindings: Env; Variables: Vars }>): void {
  // GET /v1/kpis — the command KPI strip. Tenant-lens roles only (admin/ops/finance/read); a portal party/driver
  // has no command strip. Tenant comes from the JWT claim ONLY (tenantDb) — never a header/query param (REQ-025).
  app.get("/v1/kpis", requireRole("admin", "ops", "finance", "read"), async (c) => {
    const session = c.get("session");
    const db = tenantDb(c.env, session.tenant);
    const now = Date.now(); // DSO ages open AR against the server clock (the compute fn takes it explicitly)

    // Six independent read paths — run them together. Each returns a REAL number or the literal "UNKNOWN".
    const [unbilled, otd, dwell, lane, dso, or] = await Promise.all([
      computeUnbilled(db),
      computeOtdBps(db),
      computeDwellMinutes(db),
      computeLanePnl(db),
      computeDsoDays(db, { now }),
      computeCostRatioBps(db),
    ]);

    const kpis: KpiTile[] = [
      // (1) unbilled — the "=0 alarm": pod.signed WITHOUT invoice.issued. A real count; 0 is the healthy truth.
      { key: "unbilled", label: "Unbilled PODs", value: unbilled, unit: "count", backing: { kinds: ["pod.signed", "invoice.issued"] } },
      // (2) OTD — on-time delivery %, appt-window gated (bps). UNKNOWN if no delivered-with-window.
      { key: "otd", label: "On-Time Delivery", value: otd, unit: "bps", backing: { kinds: ["pod.signed"] } },
      // (3) dwell — mean matched arrive→depart (minutes). UNKNOWN if no pairs.
      { key: "dwell", label: "Avg Dwell", value: dwell, unit: "min", backing: { kinds: ["stop.arrived", "stop.departed"] } },
      // (4) lane P&L — AR−AP by derived lane (cents); un-attributable money is an honest "UNKNOWN" lane entry.
      {
        key: "lane_pnl",
        label: "Lane P&L",
        value: lane.value,
        unit: "cents",
        backing: { kinds: ["invoice.issued", "settlement.executed", "split.computed"] },
        lanes: lane.lanes,
      },
      // (5) DSO — dollar-weighted average age of open AR (days). UNKNOWN if no open AR.
      { key: "dso", label: "DSO (open AR age)", value: dso, unit: "days", backing: { kinds: ["invoice.issued", "payment.received"] } },
      // (6) OR — HONEST cost/revenue ratio from the quoted cost basis (bps), NOT a true operating ratio. UNKNOWN if none.
      { key: "or", label: "Cost/Rev (quoted basis)", value: or, unit: "bps", backing: { kinds: ["quote.priced", "invoice.issued"] } },
    ];

    return c.json({ kpis });
  });
}
