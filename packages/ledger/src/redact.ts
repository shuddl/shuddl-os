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

// Party geo-privacy (doc 07 §02, L2): a consignee sees position rounded to ~11 km (0.1 deg =
// 100_000 microdegrees) with accuracy dropped, until the shipment is out-for-delivery — then
// exact coordinates unlock. Exact coordinates are otherwise an ops/driver privilege.
export function generalizePosition(
  payload: Record<string, unknown>,
  outForDelivery: boolean,
): Record<string, unknown> {
  if (outForDelivery) return { ...payload };
  const out: Record<string, unknown> = { ...payload };
  if (typeof out.lat_e6 === "number") out.lat_e6 = Math.round(out.lat_e6 / 100_000) * 100_000;
  if (typeof out.lon_e6 === "number") out.lon_e6 = Math.round(out.lon_e6 / 100_000) * 100_000;
  delete out.accuracy_m;
  return out;
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
  const projected =
    lens.scope === "party" && event.kind === "position.updated"
      ? generalizePosition(payload, outForDelivery)
      : payload;
  return { ...event, payload: projected } as unknown as LedgerEvent;
}
