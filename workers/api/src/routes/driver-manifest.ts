import type { Hono } from "hono";
import { DriverManifest, type DriverStop } from "@shuddl/contracts";
import { requireRole } from "../middleware/auth.js";
import { resolveTenantDb } from "../tenants.js";
import type { Env, Vars } from "../index.js";

// Task 10 (REQ-030/025/013) — GET /v1/driver/manifest: the driver PWA's ONLY read path. It REPLACES the
// fictional DAY_SHEET fixture with an AUTHENTICATED, server-scoped day sheet.
//
// TENANT + DRIVER FROM AUTH ONLY (REQ-025/156): tenant comes from the JWT claim (resolveTenantDb —
// a header/query tenant is rejected at auth) and the driver is `session.sub`, compared to the
// status-cache projection's `assigned_driver` (byte-identical to the events/positions driver write-scope
// in ../gate-context.js). A cross-driver / cross-tenant probe therefore returns NO stops — the manifest
// is scoped by the verified principal, never by anything in the request.
//
// POD-BEFORE-NEXT-ADDRESS (server-side, current V1 policy): stops are ordered; a stop is `revealed` only
// once EVERY earlier stop's terminal evidence is committed to the ledger. A withheld future stop is
// serialized with `geo: null` — the precise coordinate is never returned until the driver earns it. The
// full skip/co-sign reveal state machine (REQ-249/251) is V2-E; this is the conservative V1 floor.
//
// STRICT ALLOWLIST: the response is built field-by-field and validated by DriverManifest.strict() before
// it leaves the worker — status_cache, assigned_driver, party names, and every other internal column are
// structurally excluded (they can never leak through a spread).

// The driver-executable stop kinds. A linehaul/interline/dray leg is not a gated driver stop in V1, so
// only pickup/delivery legs are surfaced as day-sheet stops.
const STOP_KINDS = ["pickup", "delivery"] as const;

// The terminal ledger event that marks a stop DONE, by stop kind (mirrors the driver flow's terminals:
// a pickup ends at stop.departed; a delivery ends at delivery.evidenced).
const TERMINAL_KIND: Record<"pickup" | "delivery", string> = {
  pickup: "stop.departed",
  delivery: "delivery.evidenced",
};

interface LegRow {
  shipment_id: string;
  seq: number;
  kind: "pickup" | "delivery";
  geo: string;
  created_ts: number;
}
interface EventKindRow {
  shipment_id: string;
  kind: string;
}

// Parse a leg's stored geo JSON into an integer microdegree pair, or null when it carries no coordinate.
function parseGeo(raw: string): { lat_e6: number; lon_e6: number } | null {
  try {
    const g = JSON.parse(raw) as { lat_e6?: unknown; lon_e6?: unknown };
    if (typeof g.lat_e6 === "number" && typeof g.lon_e6 === "number") return { lat_e6: g.lat_e6, lon_e6: g.lon_e6 };
  } catch {
    /* malformed geo → no coordinate (truthful: never fabricate a location) */
  }
  return null;
}

export function mountDriverManifestRoutes(app: Hono<{ Bindings: Env; Variables: Vars }>): void {
  // GET /v1/driver/manifest — the authenticated driver's day sheet. requireRole("driver"): the manifest is
  // the driver surface (a command role has no assigned-driver stops), so a non-driver is 403.
  app.get("/v1/driver/manifest", requireRole("driver"), async (c) => {
    const session = c.get("session");
    const db = await resolveTenantDb(c.env, session.tenant);
    const driver = session.sub; // the AUTHENTICATED principal — never a request-body/param id

    // The driver's assigned pickup/delivery stops, in a deterministic day-sheet order (created_ts, then
    // shipment id, then leg seq). assigned_driver is compared to session.sub — the client cannot widen it.
    const legs = await db
      .prepare(
        `SELECT l.shipment_id AS shipment_id, l.seq AS seq, l.kind AS kind, l.geo AS geo, s.created_ts AS created_ts
           FROM legs l
           JOIN shipments s ON s.id = l.shipment_id
          WHERE l.kind IN (${STOP_KINDS.map(() => "?").join(",")})
            AND json_extract(s.status_cache, '$.assigned_driver') = ?
          ORDER BY s.created_ts ASC, s.id ASC, l.seq ASC`,
      )
      .bind(...STOP_KINDS, driver)
      .all<LegRow>();

    // The ledger status of those stops — stop.arrived / the terminal events — for the same assigned set.
    // Scoped by the SAME assigned_driver subquery so a driver can never read another driver's event state.
    const evns = await db
      .prepare(
        `SELECT shipment_id, kind FROM events
          WHERE kind IN ('stop.arrived','stop.departed','delivery.evidenced')
            AND shipment_id IN (SELECT id FROM shipments WHERE json_extract(status_cache,'$.assigned_driver') = ?)`,
      )
      .bind(driver)
      .all<EventKindRow>();

    const kindsByShipment = new Map<string, Set<string>>();
    for (const r of evns.results) {
      if (r.shipment_id == null) continue;
      const set = kindsByShipment.get(r.shipment_id) ?? new Set<string>();
      set.add(r.kind);
      kindsByShipment.set(r.shipment_id, set);
    }

    // Walk stops in order applying the reveal rule: a stop is revealed while every EARLIER stop is done;
    // the first not-done stop is the current (revealed) stop; everything after it is withheld.
    let blocked = false;
    const stops: DriverStop[] = legs.results.map((leg) => {
      const seen = kindsByShipment.get(leg.shipment_id) ?? new Set<string>();
      const done = seen.has(TERMINAL_KIND[leg.kind]);
      const arrived = seen.has("stop.arrived");
      const status: DriverStop["status"] = done ? "done" : arrived ? "arrived" : "pending";
      const revealed = !blocked;
      if (!done) blocked = true; // every stop after the first not-done stop is withheld
      return {
        shipment_id: leg.shipment_id,
        seq: leg.seq,
        kind: leg.kind,
        status,
        revealed,
        geo: revealed ? parseGeo(leg.geo) : null, // precise future-stop field withheld until earned
      };
    });

    // Validate the whole envelope against the STRICT contract before returning — a stray field would throw
    // here rather than leak. server_ts is the client's freshness anchor; tenant/driver echo the JWT claim.
    const manifest = DriverManifest.parse({ server_ts: Date.now(), tenant: session.tenant, driver_id: driver, stops });
    return c.json(manifest);
  });
}
