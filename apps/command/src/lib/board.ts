// WP-10 Task 9 (REQ-073/080) — the command board's data seam: fetch the REAL lens-scoped fleet (GET /v1/board)
// and the lens-scoped event tail for a selected mark (GET /v1/shipments/:id/events), and map both into the shapes
// @shuddl/map consumes. This replaces the synthetic demoFleet() the map used to render: the exception marks now
// reflect ACTUAL ledger state, so the already-built exception-pulse / world-dim demo #5 fires on real data.
//
// Zod at the boundary (CLAUDE.md): the board response is fully server-controlled, so it is parsed .strict(); the
// event tail reuses the ledger read envelope ({events, next_cursor}), so its per-event schema keeps only the two
// fields the panel needs (zod strips the rest of the LedgerEvent). A malformed board is a hard parse throw the
// caller surfaces as an honest empty map — never a half-rendered fabricated fleet.
import { z } from "@shuddl/contracts";
import type { FleetItem, LensEvent } from "@shuddl/map";
import { get } from "./api.js";

// The map's status vocabulary (mirrors @shuddl/map `Status`). The server maps status_cache.state → this set:
// only 'exception' has a ledger source today, so 'healthy'/'exception' are what actually arrive; 'at-risk' stays
// for forward-safety. z.enum makes an unexpected status a parse throw (never a silently-mis-coloured mark).
const BoardItem = z
  .object({
    shipment_id: z.string(),
    lat_e6: z.number(),
    lon_e6: z.number(),
    status: z.enum(["healthy", "at-risk", "exception"]),
  })
  .strict();
const BoardResponse = z.object({ board: z.array(BoardItem) }).strict();

type BoardItemT = z.infer<typeof BoardItem>;

// microdegrees (integer canonical geo) → decimal degrees for MapLibre.
const E6 = 1_000_000;

/**
 * Map one board row to the FleetItem the map renders. TRUTHFUL MAP (skill keep-map-instrument-truthful):
 *   • kind "at_rest" — a last-known DOT, not a chevron. The board carries a single position and NO heading, and a
 *     chevron would render a fabricated due-north bearing. A dot claims no direction; it still rides the `rest`
 *     layer's exception pulse, so demo #5 is unaffected.
 *   • bearing 0 — inert for a circle (only the `trucks` symbol reads bearing), so no heading is invented.
 * party_refs is empty: a command (tenant-lens) mark is not party-scoped, and useFleet only generalizes on the
 * PARTY lens — the command scope passes the exact geo straight through (matches the server's unredacted read).
 */
function toFleetItem(b: BoardItemT): FleetItem {
  return {
    id: b.shipment_id,
    lng: b.lon_e6 / E6,
    lat: b.lat_e6 / E6,
    bearing: 0,
    kind: "at_rest",
    status: b.status,
    label: b.shipment_id,
    shipment_id: b.shipment_id,
    party_refs: [],
  };
}

/** Fetch the live lens-scoped fleet and map it to FleetItem[] for useFleet. Throws ApiError on a non-2xx (the
 * caller branches on isAuthError → re-auth) or a ZodError on a malformed body (→ honest empty map). */
export async function fetchBoard(): Promise<FleetItem[]> {
  const raw = await get<unknown>("/v1/board");
  return BoardResponse.parse(raw).board.map(toFleetItem);
}

// The event tail envelope (the ledger read shape). Keep only kind + ts per event — zod strips the rest of the
// LedgerEvent (payload/hash/sig/…), which the panel does not render. next_cursor is present in the envelope, so
// it is declared (nullable) to keep the schema .strict() rather than silently dropping an unexpected shape.
const TailEvent = z.object({ kind: z.string(), ts: z.number() });
const TailResponse = z.object({ events: z.array(TailEvent), next_cursor: z.string().nullable() }).strict();

// A stored event `ts` is epoch ms; render it as a compact HH:MM (UTC, deterministic across environments) for the
// mono panel. The panel's `at` field is display-only — no ledger fact is derived from it.
function hhmm(ts: number): string {
  return new Date(ts).toISOString().slice(11, 16);
}

/** Fetch a shipment's lens-scoped event tail and map it to the LensPanel's LensEvent[]. On any failure the caller
 * shows an empty tail (the panel renders "No events yet") — never fabricated events. */
export async function fetchShipmentEvents(shipmentId: string): Promise<LensEvent[]> {
  const raw = await get<unknown>(`/v1/shipments/${encodeURIComponent(shipmentId)}/events`);
  return TailResponse.parse(raw).events.map((e) => ({ kind: e.kind, at: hhmm(e.ts) }));
}
