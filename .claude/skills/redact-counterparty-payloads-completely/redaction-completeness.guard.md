# Redaction-completeness CI guard

A per-incident patch to `REDACTIONS` closes the field you noticed and leaves the next one open. Replace vigilance with an enumerated invariant: for every kind whose default is `counterparty`/`public`, assert every internal field is stripped by `redactEvent` — including fields nested inside array elements.

## The matrix
- Rows: kinds where `KIND_VISIBILITY_DEFAULTS[kind] !== "internal"` (`packages/ledger/src/visibility.ts:8`).
- Columns: the internal-field inventory — `gl_map`, `division`, `floors`, `basis`, `versions`, and any cost/buy amount field.
- Cell assertion: build a maximal payload for the kind that plants each internal field at every position the contract allows (top-level AND inside each array, e.g. `lines[]`), run it through `redactEvent({ scope: "party" }, event)`, then assert `JSON.stringify(projected.payload)` contains none of the internal field names.

## Sketch (vitest, colocated with packages/ledger redaction tests)
```ts
const OUTBOUND = (Object.keys(KIND_VISIBILITY_DEFAULTS) as EventKind[])
  .filter((k) => KIND_VISIBILITY_DEFAULTS[k] !== "internal");
const INTERNAL_FIELDS = ["gl_map", "division", "floors", "basis", "versions", "buy_cents", "cost_cents"];

for (const kind of OUTBOUND) {
  it(`${kind} leaks no internal field to a party lens`, () => {
    const ev = plantInternalFieldsEverywhere(kind, INTERNAL_FIELDS); // top-level + nested in every array
    const out = redactEvent({ scope: "party" }, ev);
    const seen = JSON.stringify(out.payload);
    for (const f of INTERNAL_FIELDS) {
      expect(seen, `${kind} still ships ${f}`).not.toContain(`"${f}"`);
    }
  });
}
```

## Why it catches the live gap
Run today against `invoice.issued` (`visibility.ts:31`), the guard fails: `lines[].gl_map` (`compose.ts:168`, `money.ts:25`) survives because `redact.ts:60` only deletes top-level keys and `REDACTIONS` (`redact.ts:11`) has no entry for the kind. It stays failing until BOTH a top-level entry (`division`) and the nested walk (`stripInternalInPlace.ts`) land — which is exactly the completeness the invariant demands.

## Guard against the latent-leak trap
Do not let empty `party_refs` (`packages/contracts/src/events.ts:620`) make the party-lens test vacuous. The guard must call `redactEvent` directly with `{ scope: "party" }` rather than routing through lens resolution, so it exercises the projection even for kinds no party currently references. WP-08 booking populating `party_refs` must not be what first exercises this path in production.
