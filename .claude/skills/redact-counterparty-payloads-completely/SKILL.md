---
name: redact-counterparty-payloads-completely
description: Use when adding or reviewing an EventKind whose default visibility is counterparty or public, when a payload carries internal-only fields (gl_map, division, floors, basis, cost/buy amounts), or when editing redact.ts / REDACTIONS. Trigger on any new outbound-visible event kind or a nested-in-array internal field.
---

> **Grounding note (added 2026-08-01, on commit — 16 days after writing):** the examples and
> `path:line` citations in this skill are observations FROZEN as-of its writing (2026-07-15/16).
> Several RED examples have since been FIXED in live code — verify against HEAD before treating any
> cited defect as current. The LAW each skill states is current; the citations are its provenance,
> not its proof. Enrolled in the citation ratchet as a dated record (the 2026-07-15 audit precedent).

# Redact counterparty payloads completely

## Overview
Redaction is a per-kind completeness invariant (I6, REQ-015): for every kind whose default visibility is `counterparty` or `public`, each internal-only field must be either absent from the payload or provably stripped by `redactEvent`. A field that exists in the stored payload but is not stripped ships to the counterparty. There is no partial credit.

## When to use
- Adding/editing an EventKind that resolves to `counterparty`/`public` in `KIND_VISIBILITY_DEFAULTS` (`packages/ledger/src/visibility.ts:8`).
- A payload (or a producer like the Biller composer) writes `gl_map`, `division`, `floors`, `basis`, `versions`, cost/buy amounts, or any margin/chart-of-accounts field.
- Editing `REDACTIONS` or `redactEvent` in `packages/ledger/src/redact.ts`.
- NOT for `internal`-default kinds (credit.checked, split.computed, agent.acted…) — those never leave the tenant lens, so redaction is moot.

## The RED: `delete payload[path]` cannot reach a field nested in an array
`redactEvent` strips only TOP-LEVEL keys:
```
for (const path of REDACTIONS[event.kind] ?? []) delete payload[path]; // redact.ts:60
```
`invoice.issued` defaults to `counterparty` (`visibility.ts:31`) yet has NO `REDACTIONS` entry (`redact.ts:11` lists only `quote.priced` and `exception.raised`). The Biller composer puts a top-level `division` and a per-line `gl_map` into the payload:
```
division: bill.division ?? "main",                 // compose.ts:163  (top-level)
lines: acceptedQuote.lines.map((line, i) => ({
  ..., gl_map: glMap(line.kind),                    // compose.ts:168  (nested in lines[])
})),
```
A flat `REDACTIONS["invoice.issued"] = ["gl_map"]` would delete a top-level `gl_map` that does not exist and never touch `lines[].gl_map` (`money.ts:25`). The chart of accounts ships to the customer.

## The fix: strip top-level AND walk arrays, mirroring `coarsenGeoInPlace`
`coarsenGeoInPlace` (`redact.ts:32-45`) already solves the nested case for geo: a structural recursion that hits `lat_e6`/`lon_e6` at any depth, including inside `lines[]`. Redaction of internal fields needs the same shape. Add an entry AND a nested rule:
```
"invoice.issued":   ["division"],        // top-level, delete[] handles it
"invoice.corrected":["division"],
// plus a structural walk that deletes `gl_map` on every object node (see stripInternalInPlace.ts)
```
See `stripInternalInPlace.ts` in this skill for the helper — it recurses arrays and objects exactly like `coarsenGeoInPlace`, deleting a configured set of internal keys wherever they appear.

## Do not lean on empty `party_refs`
Today `invoice.issued` fixtures carry `party_refs: []` (`packages/contracts/src/events.ts:620`), so no party lens resolves the event and the leak is latent. WP-08 booking populates `party_refs` — the moment it does, the latent leak goes live. Fix redaction at the projection, never rely on nobody looking.

## Quick reference
| Field | Where | Internal because |
|---|---|---|
| `gl_map` | `money.ts:25`, `lines[]` | chart of accounts |
| `division` | `money.ts:34`, top-level | internal org unit |
| `floors`/`basis`/`versions` | `redact.ts:12` | margin / rating internals |
| cost/buy amounts | split/settlement payloads | executing-share economics |

Completeness check: `counterparty|public kinds × internal-field list → assert each stripped, including nested`. A worked CI guard is in `redaction-completeness.guard.md`.

## Common mistakes
- **Flat entry for a nested field.** `["gl_map"]` on `invoice.issued` is a no-op — `delete` is top-level (`redact.ts:60`). Walk the array.
- **Forgetting `invoice.corrected`.** It inherits the corrected event's visibility (`visibility.ts:67`) — also `counterparty`, same `reissue_lines[].gl_map` exposure (`money.ts:47`).
- **Treating it as a per-incident patch.** New counterparty kind = re-run the whole kind × field matrix, not just the field you noticed.
- **Trusting `party_refs: []`.** Latent ≠ safe. A producer populating the ref flips it live (`events.ts:620`).

REQUIRED BACKGROUND: the geo model to copy is `coarsenGeoInPlace` (`redact.ts:32`); visibility resolution is `resolveVisibility` (`visibility.ts:61`).
