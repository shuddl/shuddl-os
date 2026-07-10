import type { EventKind, LedgerEvent } from "@shuddl/contracts";

// REQ-015 / I6: redaction is a READ PROJECTION applied to already-visibility-filtered rows
// for non-tenant lenses. It NEVER mutates the stored event — prev_hash/sig/hash pass through
// untouched (party lenses verify individual evidence hashes against anchors, not the chain).
// Only the scope matters here; a lens carries more (partyId/userId) but redaction ignores it.
type RedactScope = "tenant" | "party" | "driver";

// Per-kind payload paths stripped for non-tenant lenses: quote internals (margin/rating
// basis/pinned versions) and the operator-only exception note.
export const REDACTIONS: Partial<Record<EventKind, readonly string[]>> = {
  "quote.priced": ["floors", "basis", "versions"],
  "exception.raised": ["internal_note"],
};

// Party geo-privacy (doc 07 §02, L2, REQ-074): a consignee sees position rounded to ~11 km
// (0.1 deg = 100_000 microdegrees) with accuracy dropped, until the shipment is out-for-delivery
// — then exact coordinates unlock. Exact coordinates are otherwise an ops/driver privilege.
// Returns a generalized DEEP COPY; the input payload is never mutated.
export function generalizePosition(
  payload: Record<string, unknown>,
  outForDelivery: boolean,
): Record<string, unknown> {
  const out = structuredClone(payload) as Record<string, unknown>;
  if (!outForDelivery) coarsenGeoInPlace(out);
  return out;
}

// Recursively coarsen EVERY geo-bearing node — top-level lat_e6/lon_e6 (position.updated) AND
// nested `geo` objects (pod.signed / custody.transferred), and anywhere a future kind might put
// them. Structural, not kind-enumerated, so a new geo-bearing kind cannot silently reopen the leak.
function coarsenGeoInPlace(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) coarsenGeoInPlace(item);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const hasLat = typeof obj.lat_e6 === "number";
  const hasLon = typeof obj.lon_e6 === "number";
  if (hasLat) obj.lat_e6 = Math.round((obj.lat_e6 as number) / 100_000) * 100_000;
  if (hasLon) obj.lon_e6 = Math.round((obj.lon_e6 as number) / 100_000) * 100_000;
  if (hasLat || hasLon) delete obj.accuracy_m; // accuracy reveals precision — drop it with the coords
  for (const value of Object.values(obj)) coarsenGeoInPlace(value);
}

/**
 * Project a stored event down to what a lens may see. Tenant lenses see the unredacted event.
 * Non-tenant lenses get a deep-cloned copy with redacted payload paths removed; party lenses
 * additionally get positions generalized until `outForDelivery`. The returned object is a new
 * envelope — the input `event` is never mutated.
 */
export function redactEvent(
  lens: { scope: RedactScope },
  event: LedgerEvent,
  outForDelivery = false,
): LedgerEvent {
  if (lens.scope === "tenant") return event; // ops/finance/admin/read see the unredacted truth
  const payload = structuredClone(event.payload) as Record<string, unknown>;
  for (const path of REDACTIONS[event.kind] ?? []) delete payload[path];
  // Party geo-privacy applies to EVERY geo-bearing kind (structural walk), not just
  // position.updated — exact coordinates are an ops/driver privilege (doc 07 §02, REQ-074).
  // Driver lenses keep exact geo.
  const projected = lens.scope === "party" ? generalizePosition(payload, outForDelivery) : payload;
  return { ...event, payload: projected } as unknown as LedgerEvent;
}
