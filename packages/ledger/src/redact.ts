import type { EventKind, LedgerEvent } from "@shuddl/contracts";

// REQ-015 / I6: redaction is a READ PROJECTION applied to already-visibility-filtered rows
// for non-tenant lenses. It NEVER mutates the stored event — prev_hash/sig/hash pass through
// untouched (party lenses verify individual evidence hashes against anchors, not the chain).
// Only the scope matters here; a lens carries more (partyId/userId) but redaction ignores it.
type RedactScope = "tenant" | "party" | "driver";

// Per-kind payload paths stripped for non-tenant lenses: quote internals (margin/rating
// basis/pinned versions) and the operator-only exception note. TOP-LEVEL keys only — `delete
// payload[path]` cannot reach a field nested inside an array element (see INTERNAL_NESTED).
export const REDACTIONS: Partial<Record<EventKind, readonly string[]>> = {
  "quote.priced": ["floors", "basis", "versions"],
  "exception.raised": ["internal_note"],
};

// REQ-179 / I6 — the STRUCTURAL half of redaction. `delete payload[path]` (REDACTIONS) reaches only
// TOP-LEVEL keys, so a MARGIN/GL internal nested inside an array — e.g. invoice.issued `lines[].gl_map`
// and invoice.corrected `reissue_lines[].gl_map` (money.ts:25/47) — would ship to the counterparty. The
// portal is the FIRST counterparty surface to read invoice.issued/invoice.corrected, so these keys must
// be stripped at ANY depth. Keys listed here are removed wherever they appear (through arrays AND nested
// objects), mirroring coarsenGeoInPlace. gl_map = chart of accounts; division = internal org unit. The
// walk is STRUCTURAL, not path-enumerated, so it FAILS CLOSED: an unexpected shape (an extra line, a key
// buried deeper than the contract) still loses the internal field — strip more, never less. The sell/
// totals/line amounts (invoice_id, party_id, lines[].line_no/kind/amount_cents) are NOT listed, so a
// counterparty still sees exactly what it owes. Keep append-only alongside KIND_VISIBILITY_DEFAULTS.
export const INTERNAL_NESTED: Partial<Record<EventKind, readonly string[]>> = {
  "invoice.issued": ["division", "gl_map"], // top-level division + lines[].gl_map (money.ts:25/34)
  "invoice.corrected": ["division", "gl_map"], // reissue_lines[].gl_map (money.ts:47); division defensive
  // REQ-192 (WP-09 exit audit) — the OTHER counterparty-default kinds that carry an internal field. The
  // portal is the first surface a counterparty reads these through, so the internal dimension must be
  // stripped for the party/driver lens exactly as invoice.issued's is: booking.created carries `division`
  // (the org/margin dimension, booking.ts:43), dispatch.assigned carries `driver_user_id` (an internal user
  // id — REQ-167 — booking.ts:99; a forward guard: dispatch.assigned is not yet emitted with customer
  // party_refs, but this closes it before it can go live). The general fail-closed test (redact.test) asserts
  // NO known-internal field survives the party lens for ANY counterparty-default kind.
  "booking.created": ["division"],
  "dispatch.assigned": ["driver_user_id"],
};

// Delete `key` from `node` and from every object nested inside it — through arrays and plain objects
// alike. Mutates in place; call on the structuredClone redactEvent already makes, never on a stored
// event. Structural, not index-bookkeeping, so `lines[3].gl_map` needs no path. Sibling to
// coarsenGeoInPlace: one shape solves the nested-in-array case for BOTH geo and internal fields.
function stripKeyInPlace(node: unknown, key: string): void {
  if (Array.isArray(node)) {
    for (const item of node) stripKeyInPlace(item, key);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (key in obj) delete obj[key];
  for (const value of Object.values(obj)) stripKeyInPlace(value, key);
}

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
  for (const path of REDACTIONS[event.kind] ?? []) delete payload[path]; // top-level
  // Nested internal fields (invoice.issued/corrected margin+GL): stripped at EVERY depth so a field
  // buried in lines[]/reissue_lines[] cannot reach a counterparty (REQ-179). Fail-closed structural walk.
  for (const key of INTERNAL_NESTED[event.kind] ?? []) stripKeyInPlace(payload, key);
  // Party geo-privacy applies to EVERY geo-bearing kind (structural walk), not just
  // position.updated — exact coordinates are an ops/driver privilege (doc 07 §02, REQ-074).
  // Driver lenses keep exact geo.
  const projected = lens.scope === "party" ? generalizePosition(payload, outForDelivery) : payload;
  return { ...event, payload: projected } as unknown as LedgerEvent;
}
