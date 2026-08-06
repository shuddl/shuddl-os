import { TERMINAL_STATES } from "@shuddl/ledger/queries/metrics";
import type { Hono } from "hono";
import { lensFor } from "@shuddl/ledger/lens";
import { generalizePosition } from "@shuddl/ledger/redact";
import { requireRole } from "../middleware/auth.js";
import { ApiError } from "../middleware/error.js";
import { resolveTenantDb } from "../tenants.js";
import type { Env, Vars } from "../index.js";

// GET /v1/board — the live, lens-scoped fleet for BOTH command surfaces. The map IS the home, and its exception
// marks must reflect ACTUAL ledger state (so the exception-pulse / world-dim acceptance demo #5 fires on REAL
// data, not a synthetic demoFleet). A DURABLE READ over two existing rows — NO new table, NO event kind, NO
// projection:
//   • shipments.status_cache.state — the mutable projection the sequencer maintains (booked/dispatched/
//     in_transit/exception/delivered), mapped here to the MAP's status vocabulary (healthy|at-risk|exception).
//   • positions — the physical GPS partition; the LATEST row per shipment is the mark's location.
//
// TWO LENSES, resolved SERVER-SIDE from the JWT claim ONLY (never a header/query hint; REQ-025, REQ-030):
//   • TENANT lens (admin/ops/finance/read) — the whole-tenant Command board. redact.ts leaves this UNREDACTED
//     (coarsenGeoInPlace runs only for the PARTY lens), so the board legitimately exposes EXACT ops geo
//     (lat_e6/lon_e6 microdegrees) — the internal operational view. Response shape: `{ board }` (byte-stable;
//     apps/command parses it .strict()).
//   • PARTY lens (portal, WP-remediation Task 12 / REQ-085) — the client portal's own-freight board. Scope +
//     coordinate generalization are applied HERE, in SQL + the server projection, BEFORE serialization:
//       · party-relationship predicate — a shipment is the party's iff it is the shipper|consignee|bill_to; so
//         party A can never read party B (REQ-025), and a forged ?party_id buys nothing (identity is the claim).
//       · coordinate generalization — non-out-for-delivery positions coarsen to ~city (REQ-074); exact geo
//         unlocks only at OFD. Reuses the SAME coarsenGeoInPlace law (generalizePosition) the ledger redaction
//         enforces on events, so the two never drift.
//     Response shape: `{ board, as_of }` — a server-derived freshness stamp the polling portal renders. (The
//     tenant/command board loads once and needs no stamp, so its shape stays `{ board }`.)
//
// It never sharpens or fabricates a position: a shipment with no positions row is simply not placed on the map
// (truthful map, skill keep-map-instrument-truthful). Bounded to the freshest-positioned active shipments.

// Terminal states leave the LIVE fleet — a delivered/settled truck is not a moving mark. Mirrors exceptions.ts
// TERMINAL_STATES so "active" means the same thing across the reads. Everything else (booked/dispatched/
// in_transit/exception/OFD/unknown/no-state) is LIVE. 'settled' is listed forward-safe (a future settlement
// projection); only 'delivered' is produced today (status-cache.ts pod.signed).
const TERMINAL_STATE_LIST: readonly string[] = [...TERMINAL_STATES];

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

// The party query additionally reads OFD to decide precise-vs-coarse. json_extract returns 1 for JSON `true`.
interface PartyBoardRow extends BoardRow {
  ofd: number | null;
}

export interface BoardItem {
  shipment_id: string;
  lat_e6: number; // microdegrees — exact for the tenant lens; generalized to ~city for the party lens (pre-OFD)
  lon_e6: number;
  status: MapStatus;
}

// LENS_UNRESOLVED (a portal session missing party_id) surfaces as a clean 403 rather than an opaque 500 —
// mirrors invoices.ts / documents.ts. Anything else rethrows as-is.
function toLensError(e: unknown): unknown {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.startsWith("LENS_UNRESOLVED")) return new ApiError("FORBIDDEN", 403, "SESSION LENS UNRESOLVED");
  return e;
}

// One shipment is one mark: two devices can share the exact same max ts → two rows; keep the FIRST per
// shipment so the map's promoteId stays unique. The mapper builds the STRICT item (no extra keys ever ride out).
function dedupeToItems<R extends { shipment_id: string }>(rows: readonly R[], toItem: (r: R) => BoardItem): BoardItem[] {
  const seen = new Set<string>();
  const board: BoardItem[] = [];
  for (const r of rows) {
    if (seen.has(r.shipment_id)) continue;
    seen.add(r.shipment_id);
    board.push(toItem(r));
  }
  return board;
}

// TENANT lens (Command) — the whole-tenant fleet at EXACT ops geo. Each ACTIVE shipment joined to its LATEST
// position (max ts per shipment); a shipment with no position is dropped by the JOIN, a terminal shipment by the
// state filter. json_extract returns NULL for a stateless shipment — treated as LIVE. Ordered freshest-first.
async function tenantBoard(db: D1Database): Promise<BoardItem[]> {
  const placeholders = TERMINAL_STATE_LIST.map(() => "?").join(",");
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
    .bind(...TERMINAL_STATE_LIST, BOARD_LIMIT)
    .all<BoardRow & { pts: number }>();
  return dedupeToItems(rows.results, (r) => ({
    shipment_id: r.shipment_id,
    lat_e6: r.lat_e6,
    lon_e6: r.lon_e6,
    status: toMapStatus(r.state),
  }));
}

// PARTY lens (portal) — ONLY the party's own shipments (shipper|consignee|bill_to), each generalized to ~city
// unless out-for-delivery. The party predicate is a BOUND `?` param (SQL-injection-safe) applied in the WHERE,
// so the scope is enforced in the database, not after the fact. `partyId` is the lens id from the verified
// claim — never a request value — so isolation cannot be widened by anything a caller sends (REQ-025).
async function partyBoard(db: D1Database, partyId: string): Promise<BoardItem[]> {
  const placeholders = TERMINAL_STATE_LIST.map(() => "?").join(",");
  const rows = await db
    .prepare(
      `SELECT s.id AS shipment_id,
              json_extract(s.status_cache, '$.state') AS state,
              json_extract(s.status_cache, '$.out_for_delivery') AS ofd,
              p.lat_e6 AS lat_e6,
              p.lon_e6 AS lon_e6,
              p.ts AS pts
         FROM shipments s
         JOIN positions p
           ON p.shipment_id = s.id
          AND p.ts = (SELECT MAX(p2.ts) FROM positions p2 WHERE p2.shipment_id = s.id)
        WHERE (s.shipper_party_id = ? OR s.consignee_party_id = ? OR s.bill_to_party_id = ?)
          AND (json_extract(s.status_cache, '$.state') IS NULL
               OR json_extract(s.status_cache, '$.state') NOT IN (${placeholders}))
        ORDER BY p.ts DESC
        LIMIT ?`,
    )
    .bind(partyId, partyId, partyId, ...TERMINAL_STATE_LIST, BOARD_LIMIT)
    .all<PartyBoardRow & { pts: number }>();
  return dedupeToItems(rows.results, (r) => {
    // REQ-074 — coarsen to ~city (nearest 0.1°, accuracy dropped) UNLESS out-for-delivery. Reuse the SAME
    // coarsenGeoInPlace law the ledger redaction enforces, so the party board never drifts from the event
    // redaction. json_extract yields 1 for JSON `true`; anything else (0 / NULL) stays coarse.
    const geo = generalizePosition({ lat_e6: r.lat_e6, lon_e6: r.lon_e6 }, r.ofd === 1) as {
      lat_e6: number;
      lon_e6: number;
    };
    return { shipment_id: r.shipment_id, lat_e6: geo.lat_e6, lon_e6: geo.lon_e6, status: toMapStatus(r.state) };
  });
}

export function mountBoardRoutes(app: Hono<{ Bindings: Env; Variables: Vars }>): void {
  // Tenant-lens roles (admin/ops/finance/read) AND the portal party lens may read the board; a driver has no
  // board (excluded by requireRole → 403). Tenant from the JWT claim ONLY (tenantDb) — never a header/query
  // param (REQ-025); the lens (tenant vs party) is likewise claim-derived (lensFor), never client-supplied.
  app.get("/v1/board", requireRole("admin", "ops", "finance", "read", "portal"), async (c) => {
    const session = c.get("session");
    const db = await resolveTenantDb(c.env, session.tenant);
    let lens;
    try {
      lens = lensFor(session);
    } catch (e) {
      throw toLensError(e); // portal session missing party_id → clean 403 (fail-closed, no board)
    }
    if (lens.scope === "tenant") {
      return c.json({ board: await tenantBoard(db) });
    }
    if (lens.scope === "party") {
      // The party board carries a server-derived freshness stamp the polling portal renders honestly.
      return c.json({ board: await partyBoard(db, lens.partyId), as_of: Date.now() });
    }
    // driver — no board (unreachable via requireRole; kept fail-closed as defence-in-depth).
    throw new ApiError("FORBIDDEN", 403, "ROLE NOT PERMITTED");
  });
}
