---
name: keep-readmodel-consistent-with-ledger
description: Use when writing or reviewing a projection (money_lines, invoices AR, status_cache, messages, passports), handling a correction/void/reissue, or when a read-model row can silently diverge from the append-only ledger. Trigger on invoice.corrected, INVOICE_UPDATE_SQL, INVOICE_UPSERT_SQL, or any project*()/apply*() emitter in packages/ledger/src/projection.
---

> **Grounding note (added 2026-08-01, on commit — 16 days after writing):** the examples and
> `path:line` citations in this skill are observations FROZEN as-of its writing (2026-07-15/16).
> Several RED examples have since been FIXED in live code — verify against HEAD before treating any
> cited defect as current. The LAW each skill states is current; the citations are its provenance,
> not its proof. Enrolled in the citation ratchet as a dated record (the 2026-07-15 audit precedent).

# Keep Every Read-Model Consistent With the Ledger

## Overview
The ledger is the truth; every read-model (`money_lines`, `invoices`, `status_cache`, `messages`, `passports`) is a projection of it (I1). **A correction that changes economic or status effect must update EVERY read-model that event feeds — not just the first one you remember.** Netting one projection to the right number while leaving a sibling row frozen at issue-time is a silent divergence: nothing throws, and it only surfaces in AR aging, the portal, or a QB reconciliation, weeks later.

## When to Use
- Writing/editing anything in `packages/ledger/src/projection/*` (`money.ts`, `status-cache.ts`, `messages.ts`, `passports.ts`).
- Handling `invoice.corrected` — a correction, void, or reissue.
- A review touches `INVOICE_UPDATE_SQL`, `INVOICE_UPSERT_SQL`, or any `project*()`/`apply*()` emitter.
- Adding a new event kind: ask which read-models it now feeds.

**Not** for: pure ledger append logic (`events` insert, hashing, sequencing) — that has no read-model fan-out. Cross-tenant/isolation concerns → separate discipline.

## The Defect This Closes (grounded RED)
`packages/ledger/src/projection/money.ts:150-153` — the void branch:
```ts
const invoices: InvoiceUpsert[] =
  p.reissue_lines.length === 0
    ? []   // <-- BUG: void touches money_lines but NOT the invoices row
    : [{ mode: "update", id: p.invoice_id, total_cents: <sum>, status: "issued", ... }];
```
On a void (`reissue_lines.length === 0`), the credit `money_lines` at :117-129 correctly net the AR to `0`, but `invoices` returns `[]`, so `INVOICE_UPDATE_SQL` (`money.ts:274`) never fires. The `invoices` row keeps its issue-time `{status:'issued', total_cents:<full face>}` from `invoice.issued` (:106). Result: the REQ-057 AR surface shows a **fully-voided invoice as outstanding at full face**, while the QB export (driven off `money_lines`) reconciles to `0`. Two read-models of the same event disagree — silently.

**The fix:** a void is a correction, not a no-op. Emit the invoices upsert too:
```ts
? [{ mode: "update", id: p.invoice_id, total_cents: 0, status: "void", issued_event_id: e.id }]
```
so `money_lines` net and the `invoices` AR row both land on the same economic truth in the same `db.batch()` (I1, both directions).

## The Discipline
1. **Enumerate the fan-out.** For the event kind you touch, list every read-model it feeds. `invoice.*` feeds `money_lines` AND `invoices`. `message.*` feeds `messages` (and status). Do not stop at the first.
2. **A void/correction is a new event, never a delete** (I3/I7). Its *effect* on each read-model must be written explicitly — netting is not automatic across separate projections.
3. **money_lines netting ≠ invoices AR.** They are independent tables. Zeroing one does not touch the other.
4. **The `never`-guard is not enough.** The exhaustiveness guard (`money.ts:262`, `messages.ts:147`) catches a *missing kind*. It cannot catch a *missing read-model within a kind* — the void branch compiles fine while dropping the invoices write.
5. **Reconciliation test per correction shape.** Assert `SUM(invoices.total_cents outstanding) == SUM(money_lines net)` for issue, correct-with-reissue, AND void. Add a QB-export-vs-invoices reconciliation to the fixture gate (`fixtures/README.md`: "QB export reconciles to the penny").

## Quick Reference
| Event kind | Read-models it MUST write | Void/correction rule |
|---|---|---|
| `invoice.issued` | `money_lines` (+lines), `invoices` insert | — |
| `invoice.corrected` (reissue) | credits+debits in `money_lines`, `invoices` update to new total | status stays `issued` |
| `invoice.corrected` (void) | credits net `money_lines` to 0, **`invoices` update to `{total_cents:0, status:'void'}`** | the bug: currently emits `[]` |
| `payment.received (cod)` | `money_lines` (negative AR) | — |
| `message.*` | `messages`, `status_cache` | — |

## Common Mistakes
- **Returning `[]` for the invoices projection on void** (`money.ts:151`) — nets money_lines but leaves the AR row frozen at full face. Emit `{status:'void', total_cents:0}`.
- **Trusting money_lines to "carry" the invoice total.** The AR surface reads `invoices.total_cents`, not a SUM of money_lines. Separate row, separate write.
- **Adding a kind and only wiring one projection.** The `never`-guard goes green; the sibling read-model silently misses the kind. Grep all four `projection/*` files.
- **No reconciliation test for the void shape.** Reissue tests pass while void diverges. Test all three correction shapes.

## Source of Truth
- `genesis/10-EVENT-TAXONOMY-DATA-MODEL.md` — I1 (projection commits with its event, both directions), I3/I7 (corrections are new events, one per event).
- `genesis/09-REQUIREMENTS-REGISTER.csv:58` — REQ-057 (division-filterable invoices AR everywhere).
