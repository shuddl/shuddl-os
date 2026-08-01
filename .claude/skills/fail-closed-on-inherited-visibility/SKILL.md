---
name: fail-closed-on-inherited-visibility
description: Use when a ledger resolution INHERITS a security-relevant attribute (visibility, division, party, floor) from a referenced event, when resolving invoice.corrected against its corrected event, or when a lookup can return undefined for a referenced id. Trigger on resolveVisibility, #visibilityOf, or any correction/netting path.
---

> **Grounding note (added 2026-08-01, on commit — 16 days after writing):** the examples and
> `path:line` citations in this skill are observations FROZEN as-of its writing (2026-07-15/16).
> Several RED examples have since been FIXED in live code — verify against HEAD before treating any
> cited defect as current. The LAW each skill states is current; the citations are its provenance,
> not its proof. Enrolled in the citation ratchet as a dated record (the 2026-07-15 audit precedent).

# Fail Closed On Inherited Visibility

## Overview
When one event inherits a security attribute (visibility/division/party/floor) from a
referenced event, a **missing** inherited value is a HARD ERROR — never a silent
fall-through to the kind's open default. The widest default is exactly the leak the
inherit was added to prevent.

## When to Use
- Symptoms: `resolveVisibility`, a `#visibilityOf(id)` lookup, `invoice.corrected`
  netting, `corrects_event_id` / `party_refs` / division resolution — any place a
  referenced id can resolve to zero rows and hand back `undefined`.
- NOT for: a value the caller legitimately owns (a per-event `requested` narrow is
  advisory and may be absent — not inheritance).

## The defect this closes (SHUDDL RED)
`packages/ledger/src/visibility.ts:67`
```ts
if (kind === "invoice.corrected" && correctedEventVisibility) return correctedEventVisibility;
let v = policy?.[kind] ?? KIND_VISIBILITY_DEFAULTS[kind]; // ← falls through here on undefined
```
The `&& correctedEventVisibility` truthiness guard means an **undefined** corrected
visibility SKIPS the inherit and falls to the kind default at `visibility.ts:68`
(`invoice.corrected` → `counterparty`, `visibility.ts:32`). A `#visibilityOf(corrects_event_id)`
that resolves zero rows returns `row?.visibility === undefined`. So an
`invoice.issued` narrowed to `internal`, corrected against a bad/unresolved
reference, stamps the correction at `counterparty` — **wider than the invoice it
nets**. A phantom charge leaks into a lens the original never reached, breaking I7 and I6.

Worse: `visibility.test.ts:64` currently *blesses* the fall-through
(`resolveVisibility("invoice.corrected", undefined, undefined)` asserted `"counterparty"`),
locking in the leak. Fixing the code means rewriting that assertion.

## The rule
Inheriting a security attribute needs a **required input**, not an optional one. On a
miss, fail closed to the most-restrictive rank (`internal`, rank 0 at
`visibility.ts:50`) or throw — never to the kind's open default.

Mirror the fail-loud discipline already used for gates: `assertDelivery` throws when
`ctx.fence` is undefined (`transition-gates.ts:194`); `assertInterline` takes
`isInterline` as a REQUIRED positional so a caller omission is a compile error, not a
silently skipped gate (`transition-gates.ts:247-254`). A zero-row `corrects_event_id`
should reject the append, not quietly produce a wider correction.

## Fix
```ts
if (kind === "invoice.corrected") {
  if (correctedEventVisibility === undefined) {
    throw new Error("invoice.corrected: unresolved corrects_event_id — cannot inherit visibility (I7)");
    // or fail closed: return "internal";
  }
  return correctedEventVisibility;
}
```
And in the append path: reject the append when `corrects_event_id` resolves to zero
rows — do not let `#visibilityOf` return `undefined` downstream.

## Quick Reference
| Situation | Wrong | Right |
|---|---|---|
| Inherited visibility undefined | fall to kind default (`counterparty`) | throw, or fail to `internal` |
| `&& value` truthiness guard | skips guard on `undefined`/falsy | `if (value === undefined) throw` |
| `corrects_event_id` → 0 rows | `row?.visibility` = `undefined`, continue | reject the append |
| Correction vs. original | may out-disclose original | never wider than the netted event |

## Common Mistakes
- **Truthiness guard on an inherited attribute** (`visibility.ts:67`). `&& x` treats a
  legitimate-but-falsy or undefined inherit as "not present" and falls through. Use an
  explicit `=== undefined` check.
- **Defaulting a miss to the kind's open value.** For a *security* attribute the safe
  default is the narrowest rank, never the widest.
- **Optional plumbing for a required attribute.** Pass the inherited value as required;
  make caller omission a compile/append error (see `assertInterline`).
- **Leaving the blessing test in place.** `visibility.test.ts:64` asserts the leaky
  fall-through. The fix includes replacing it.

## Test recipe
For each inheriting kind, feed an UNRESOLVED parent (undefined inherited value) and
assert the result does NOT widen: it throws, or resolves to `internal` — never the
kind's `counterparty`/`public` default. Add a case where the corrected
`invoice.issued` was `internal` and confirm the correction never resolves wider.

## Docs
- `genesis/10-EVENT-TAXONOMY-DATA-MODEL.md` — I6 (visibility respected by every view),
  I7 (correction pairs net zero in GL export), visibility ranks.
- `genesis/09-REQUIREMENTS-REGISTER.csv` — REQ-015 (role-scoped lenses, per-kind
  visibility; "Adversarial cross-lens read fails").
