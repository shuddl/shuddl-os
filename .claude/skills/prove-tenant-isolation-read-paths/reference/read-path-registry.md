# REQ-025 read-path registry + attack-shape matrix

The enforced form of the informal promise at `workers/api/test/isolation.test.ts:5`
("grows a case for every read path added in later WPs"). Every route or key builder
that touches tenant-scoped storage MUST appear here AND have the required cases in
`workers/api/test/isolation.test.ts`. A row with a missing case is an open Critical
at WP exit (REQ-119); CLAUDE.md rule #8 makes REQ-025 a per-merge gate.

## 1. The registry (keep in sync with the code)

| # | Read path (route or fn) | Storage | Key builder / handle | Tenant source | Route case | Key-builder unit case |
|---|---|---|---|---|---|---|
| 1 | `GET /v1/_probe` | D1 | `tenantDb` | JWT claim | ✅ isolation.test.ts:20,29 | n/a (test table) |
| 2 | `GET /v1/shipments/:id/events` | D1 | `tenantDb` | JWT claim | ✅ isolation.test.ts:79 | n/a |
| 3 | `POST /v1/shipments/:id/events` | D1/DO | `tenantDb` | JWT claim | ✅ isolation.test.ts:87 | n/a |
| 4 | `GET /v1/events` (firehose) | D1 | `tenantDb` | JWT claim | ✅ isolation.test.ts:104 | n/a |
| 5 | `POST /v1/positions` | D1 | `tenantDb` | JWT claim | ✅ isolation.test.ts | n/a |
| 6 | `GET /v1/anchors/:day` | R2 | `anchorManifestKey` → `anchors/${tenant}/${day}/manifest.json` (packages/ledger/src/anchor.ts:61) | JWT claim (anchors.ts:38 `session.tenant`) | ⚠️ no dedicated route case — but a dropped `${tenant}` REDS (§174: 2 api cases + the ledger DoD test) | ✅ `packages/ledger/test/anchor.test.ts:676` |
| 7 | `GET /v1/anchors/:day/proof` | R2+D1 | `anchorReceiptKey` (anchor.ts:58), `tenantDb` (anchors.ts:53) | JWT claim | ⚠️ as row 6 | ✅ as row 6 |
| 8 | `POST /v1/anchors/run` | R2+D1 | `runDailyAnchor({ tenant: session.tenant })` (anchors.ts:72) | JWT claim | ⚠️ as row 6 | n/a |
| 9 | evidence upload/serve | R2+D1 | `evidenceKey` → `evidence/${tenant}/${shipmentId}/${hash}` (evidence.ts:60); `session.tenant` at the `.put` call | JWT claim | ✅ `evidence-upload.test.ts:312` — tenant B's token vs tenant A's shipment → 404 **and the R2 object asserted null** | ✅ incidental, 6 cases (§174) |
| 10 | `POST /v1/rate` | D1 | `loadTenantRatingConfig(tenantDb(c.env, session.tenant), now)` (rate.ts:127) | JWT claim | ✅ attack shapes (§571) **+ the VALUE direction (§1628)**: the authenticated quote must be tenant-a's number and not tenant-b's | n/a (D1 handle) |

> **Rows 6–10 re-measured; the `❌ ADD`s they used to carry were WRONG.** Read the header above literally — *a row
> with a missing case is an open Critical at WP exit* — and this table was asserting four open Criticals that
> **§174 (2026-08-04) had already measured as false**, plus a fifth (row 10) that was half true. Re-verified at
> HEAD on 2026-08-15 (audit §1628): both cited tests still exist and still assert what is claimed.
>
> **The distinction the ⚠️ rows preserve is the one that matters.** An anchors regression fails loudly today, but
> on *incidental* nets — test-side literals and a duplicated key helper. That is a real difference from row 9,
> where the route case asserts the R2 object is null by name. **A stale `❌` costs a redundant test; a stale `✅`
> costs the thing the gate exists for — so state the MECHANISM of the catch, not just its polarity.**

Update this table in the SAME PR that adds a read path. New WP agents (Scheduler,
Dispatcher, …) each add rows — WP-08 booking routes go here before they merge.

## 2. Attack-shape matrix — every route case runs ALL of these

Mirror `isolation.test.ts:29` (`describe("adversarial: …")`). tenant + party are
read from the verified JWT claim ONLY; anything client-supplied must be rejected,
never used to re-key the D1 handle or R2 prefix.

| Attack shape | Injection | Expected | Reference |
|---|---|---|---|
| Client tenant header | `X-Tenant-Id: tenant-b` with a valid tenant-a token | 403 TENANT_MISMATCH (or ignored → tenant-a data) | isolation.test.ts:31, :91 |
| Client tenant query param | `?tenant=tenant-b` | 403 (or ignored) | isolation.test.ts:35, :99 |
| Forged token, wrong secret | `token({tenant:"tenant-b"}, "attacker-secret")` | 401 | isolation.test.ts:38, :109 |
| Unsigned garbage token | `Bearer eyJhbGciOiJub25lIn0…` | ≥401 | isolation.test.ts:41 |
| Cross-tenant id under valid session | tenant-a token, tenant-b's shipment/day/hash in the PATH | 200 empty / 404 — reads tenant-a's physical store, never tenant-b's | isolation.test.ts:79 |
| Symmetry | valid tenant-b session sees ONLY tenant-b marker | tenant-b data, never tenant-a | isolation.test.ts:60 |

For R2-keyed paths (6,7,9) also add the **key-builder unit assertion** (see SKILL.md):
the leak a route test cannot see is a dropped `${tenant}` segment, because with an
empty store both tenants return 404. Assert the literal string and that two tenants
never collide:
```ts
expect(anchorManifestKey("tenant-a","2026-07-15")).toBe("anchors/tenant-a/2026-07-15/manifest.json");
expect(evidenceKey("a","s","h")).not.toBe(evidenceKey("b","s","h"));
```

## 3. WP-exit check (make the promise enforceable)

```sh
# every route that reads the session tenant
grep -rn 'session\.tenant' workers/api/src/routes | grep -oE '/v1/[^"'"'"' ]*' | sort -u
# every R2 key builder with a tenant segment
grep -rn 'return `[a-z]*/\${tenant}/' packages workers
```
Each result MUST be a row above with its cases present in isolation.test.ts.
Any gap = fail the WP (REQ-119, no open Criticals at close).
