import type { Hono } from "hono";
import { requireRole } from "../middleware/auth.js";
import { resolveTenantDb } from "../tenants.js";
import type { Env, Vars } from "../index.js";

// WP-10 Task 9 (REQ-073/080) — GET /v1/board: the command map's live, lens-scoped fleet. The map IS the home,
// and its exception marks must reflect ACTUAL ledger state (so the already-built exception-pulse / world-dim
// acceptance demo #5 fires on REAL data, not synthetic demoFleet). A DURABLE READ over two existing rows — NO
// new table, NO event kind, NO projection:
//   • shipments.status_cache.state — the mutable projection the sequencer maintains (booked/dispatched/
//     in_transit/exception/delivered), mapped here to the MAP's status vocabulary (healthy|at-risk|exception).
//   • positions — the physical GPS partition; the LATEST row per shipment is the mark's location.
//
// TENANT-SAFE (REQ-025): tenant comes from the JWT claim ONLY (tenantDb(session.tenant)); a header/query tenant
// hint is rejected at auth. Command roles (admin/ops/finance/read) are the TENANT lens — scope "tenant", which
// redact.ts leaves UNREDACTED (coarsenGeoInPlace runs only for the PARTY lens). So the board legitimately
// exposes EXACT ops geo (lat_e6/lon_e6 microdegrees) — the internal operational view. It never sharpens or
// fabricates a position: a shipment with no positions row is simply not placed on the map (truthful map, skill
// keep-map-instrument-truthful). Bounded to the freshest-positioned active shipments (BOARD_LIMIT).

// Terminal states leave the LIVE fleet — a delivered/settled truck is not a moving mark. Mirrors exceptions.ts
// TERMINAL_STATES so "active" means the same thing across the WP-10 reads. Everything else (booked/dispatched/
// in_transit/exception/OFD/unknown/no-state) is LIVE. 'settled' is listed forward-safe (a future settlement
// projection); only 'delivered' is produced today (status-cache.ts pod.signed).
const TERMINAL_STATES: readonly string[] = ["delivered", "settled"];

// The map draws ≤1,000 marks at the 60fps budget (REQ-079); cap the board there. Freshest-positioned first, so
// a very large fleet surfaces the most-recently-moving trucks — never an unbounded scan onto the canvas.
const BOARD_LIMIT = 1000;

// The map's status vocabulary (mirrors @shuddl/map `Status` — a browser package the worker never imports). Only
// 'exception' has a ledger source in status_cache today (exception.raised → state='exception'); there is NO
// at-risk projection, so the board NEVER fabricates one — every non-exception active state maps to 'healthy'.
// 'at-risk' stays in the union (forward-safe) for when a risk projection lands. This is the honest instrument:
// the map shows the alarm the ledger recorded and nothing it didn't.
type MapStatus = "healthy" | "at-risk" | "exception";
function toMapStatus(state: string | null): MapStatus {
  return state === "exception" ? "exception" : "healthy";
}

interface BoardRow {
  shipment_id: string;
  state: string | null;
  lat_e6: number;
  lon_e6: number;
}

export interface BoardItem {
  shipment_id: string;
  lat_e6: number; // microdegrees — exact ops geo (tenant lens is unredacted)
  lon_e6: number;
  status: MapStatus;
}

export function mountBoardRoutes(app: Hono<{ Bindings: Env; Variables: Vars }>): void {
  // GET /v1/board — the live fleet. Tenant-lens roles only (admin/ops/finance/read); a portal party/driver has
  // no command board. Tenant from the JWT claim ONLY (tenantDb) — never a header/query param (REQ-025).
  app.get("/v1/board", requireRole("admin", "ops", "finance", "read"), async (c) => {
    const session = c.get("session");
    const db = await resolveTenantDb(c.env, session.tenant);

    // Each ACTIVE shipment joined to its LATEST position (max ts per shipment). A shipment with no position is
    // dropped by the JOIN (no fabricated mark); a terminal shipment is dropped by the state filter. json_extract
    // returns NULL for a stateless shipment — treated as LIVE (a positioned shipment IS somewhere), so the
    // filter is `state IS NULL OR state NOT IN (terminal)`. Ordered freshest-first, capped at BOARD_LIMIT.
    const placeholders = TERMINAL_STATES.map(() => "?").join(",");
    const rows = await db
      .prepare(
        `SELECT s.id AS shipment_id,
                json_extract(s.status_cache, '$.state') AS state,
                p.lat_e6 AS lat_e6,
                p.lon_e6 AS lon_e6,
                p.ts AS pts
           FROM shipments s
           JOIN positions p
             ON p.shipment_id = s.id
            AND p.ts = (SELECT MAX(p2.ts) FROM positions p2 WHERE p2.shipment_id = s.id)
          WHERE json_extract(s.status_cache, '$.state') IS NULL
             OR json_extract(s.status_cache, '$.state') NOT IN (${placeholders})
          ORDER BY p.ts DESC
          LIMIT ?`,
      )
      .bind(...TERMINAL_STATES, BOARD_LIMIT)
      .all<BoardRow & { pts: number }>();

    // A shipment can have two devices sharing the exact same max ts → two rows; keep the FIRST per shipment so
    // one shipment is one mark. (Rare, but the map's promoteId must be unique.)
    const seen = new Set<string>();
    const board: BoardItem[] = [];
    for (const r of rows.results) {
      if (seen.has(r.shipment_id)) continue;
      seen.add(r.shipment_id);
      board.push({ shipment_id: r.shipment_id, lat_e6: r.lat_e6, lon_e6: r.lon_e6, status: toMapStatus(r.state) });
    }

    return c.json({ board });
  });
}
