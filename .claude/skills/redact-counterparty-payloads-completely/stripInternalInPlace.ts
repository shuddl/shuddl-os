// Structural internal-field stripper for redactEvent — the missing half of REQ-015 / I6.
//
// Motivation: packages/ledger/src/redact.ts:60 strips only TOP-LEVEL payload keys
// (`delete payload[path]`). Internal fields nested inside array elements — e.g.
// invoice.issued `lines[].gl_map` (packages/agents/src/biller/compose.ts:168,
// contract packages/contracts/src/money.ts:25) — never get reached, so the chart of
// accounts ships to the counterparty. This helper mirrors coarsenGeoInPlace
// (redact.ts:32-45): a structural recursion that deletes configured internal keys at
// ANY depth, so a new counterparty-visible kind cannot silently reopen the leak.
//
// Usage inside redactEvent, AFTER the top-level REDACTIONS loop and BEFORE geo:
//
//   for (const path of REDACTIONS[event.kind] ?? []) delete payload[path]; // top-level
//   for (const key of INTERNAL_NESTED[event.kind] ?? []) stripKeyInPlace(payload, key);
//
// Keep this list append-only alongside KIND_VISIBILITY_DEFAULTS: any counterparty/public
// kind carrying gl_map/division/floors/basis/cost/buy in a nested position needs an entry.

import type { EventKind } from "@shuddl/contracts";

// Internal-only keys stripped at EVERY depth for non-tenant lenses, per kind.
// gl_map = chart of accounts; division = internal org unit; floors/basis = rating internals.
export const INTERNAL_NESTED: Partial<Record<EventKind, readonly string[]>> = {
  "invoice.issued": ["gl_map"], // lines[].gl_map — money.ts:25
  "invoice.corrected": ["gl_map"], // reissue_lines[].gl_map — money.ts:47
};

/**
 * Delete `key` from `node` and from every object nested inside it — through arrays and
 * plain objects alike. Mutates in place; call on a structuredClone, never on a stored
 * event (redactEvent already clones at redact.ts:59). Structural, not path-enumerated,
 * so `lines[3].gl_map` needs no index bookkeeping.
 */
export function stripKeyInPlace(node: unknown, key: string): void {
  if (Array.isArray(node)) {
    for (const item of node) stripKeyInPlace(item, key);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (key in obj) delete obj[key];
  for (const value of Object.values(obj)) stripKeyInPlace(value, key);
}
