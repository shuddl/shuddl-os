---
name: prove-tenant-isolation-read-paths
description: Use when adding any API route or R2/D1 key builder that touches tenant-scoped storage (evidence, anchors, rate config, events, positions), when editing workers/api/test/isolation.test.ts, or at any WP exit. Trigger on a new read path, a new R2 key template, or REQ-025. Symptoms — a route reads c.get("session").tenant, a key builder embeds `${tenant}/`, or the isolation suite has no case for a newly shipped storage path.
---

> **Grounding note (added 2026-08-01, on commit — 16 days after writing):** the examples and
> `path:line` citations in this skill are observations FROZEN as-of its writing (2026-07-15/16).
> Several RED examples have since been FIXED in live code — verify against HEAD before treating any
> cited defect as current. The LAW each skill states is current; the citations are its provenance,
> not its proof. Enrolled in the citation ratchet as a dated record (the 2026-07-15 audit precedent).

# Prove Tenant Isolation Read Paths

## Overview
REQ-025: a cross-tenant read *anywhere* is a build failure (CLAUDE.md rule #8, per-merge gate). "Anywhere" means every route and every R2/D1 key builder — untested is unproven. A read path with no isolation case ships green while a one-character prefix regression leaks a sibling tenant's freight.

## When to Use
Trigger when you:
- add/edit an API route that calls `tenantDb(c.env, session.tenant)` or `c.get("session").tenant`
- add an R2 key builder with a `${tenant}/` segment (evidence, anchors, tiles)
- add a D1 rate/config loader keyed off the session tenant
- edit `workers/api/test/isolation.test.ts`, or hit a WP exit (REQ-119 swarm)

Do NOT skip because the route "obviously" uses `tenantDb` — the point is the *proof*, not the intent.

## The gap this closes (the RED)
`workers/api/test/isolation.test.ts:39@WPs` promises the suite "grows a case for every read path added in later WPs." It covers `_probe`, ledger events, and positions. It has **zero** cases for three shipped tenant-storage paths:
- `evidence.ts` — `evidenceKey(session.tenant, ...)` builds `evidence/${tenant}/${shipmentId}/${hash}` (evidence.ts:60 defines it; the route calls `evidenceKey(session.tenant, ...)` before `EVIDENCE.put`).
- `anchors.ts:38` — `readAnchorManifest(c.env.EVIDENCE, session.tenant, day)`, keyed by `anchorManifestKey` = `anchors/${tenant}/${day}/manifest.json` (packages/ledger/src/anchor.ts:58,61).
- `rate.ts:127` — `loadTenantRatingConfig(tenantDb(c.env, session.tenant), now)`.

~~So a regression that dropped `${tenant}` from `evidenceKey` or `anchorManifestKey` would ship green.~~ **Measured false, 2026-08-04 (audit §174) — see the Quick Reference note.** Both mutations fail loudly today. But they fail on *incidental* nets (test-side literals and one duplicated key helper), so the two fixes below still apply — as durability, not as first coverage: (1) an isolation.test case per path with all attack shapes; (2) a direct unit assertion that each key builder embeds the tenant, which is the only net that survives DRY-ing the test literals against the builder.

## The pattern — one grounded example
For every new read path, add BOTH:

**1. A route case with all four attack shapes** (mirror isolation.test.ts:29 — client header, query param, forged token, unsigned garbage). Example for the anchor manifest:
```ts
it("tenant-a session GETting an anchor day reads tenant-a's R2, never tenant-b's", async () => {
  const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
  const res = await SELF.fetch("https://api.local/v1/anchors/2026-07-15", { headers: bearer(t) });
  // manifest key is anchors/${session.tenant}/... — a tenant-b day is a different physical R2 prefix.
  expect([200, 404]).toContain(res.status); // never tenant-b's manifest
});
it("X-Tenant-Id on GET /v1/anchors/:day is rejected at auth", async () => { /* expect 403 */ });
it("?tenant= on GET /v1/anchors/:day is rejected at auth", async () => { /* expect 403 */ });
```

**2. A key-builder unit assertion** (the prefix regression net — a route test can't catch a dropped segment if both tenants return empty):
```ts
import { anchorManifestKey, anchorReceiptKey } from "@shuddl/ledger/anchor";
import { evidenceKey } from "../src/routes/evidence.js";
it("R2 key builders embed the session tenant", () => {
  expect(anchorManifestKey("tenant-a", "2026-07-15")).toBe("anchors/tenant-a/2026-07-15/manifest.json");
  expect(anchorManifestKey("tenant-a", "2026-07-15")).toContain("tenant-a/");
  expect(evidenceKey("tenant-a", "ship1", "h")).toBe("evidence/tenant-a/ship1/h");
  // a builder whose output for two tenants is prefix-identical up to the tenant slug is the whole point:
  expect(evidenceKey("tenant-a", "s", "h")).not.toBe(evidenceKey("tenant-b", "s", "h"));
});
```
See `reference/read-path-registry.md` for the full registry + attack-shape matrix.

## Quick Reference
| Read path | Key builder / loader | Isolation case today? |
|---|---|---|
| `/v1/_probe` | probe table | yes (isolation.test.ts:20) |
| `/v1/shipments/:id/events`, `/v1/events` | `tenantDb` | yes (isolation.test.ts:73) |
| `/v1/positions` | `tenantDb` | yes |
| `/v1/anchors/:day`, `/proof`, `/run` | `anchorManifestKey`, `anchorReceiptKey`, `tenantDb` | key partitioning yes, explicitly (packages/ledger/test/anchor.test.ts, "REQ-025 — anchor R2 keys are tenant-partitioned"); no route-level cross-tenant case, and see the note below on why one adds little here |
| evidence upload/serve | `evidenceKey(session.tenant,…)` | yes — route-level cross-tenant (evidence-upload.test.ts:311: tenant B's token against tenant A's shipment → 404, NOTHING written); key shape held incidentally by 6 cases |
| `/v1/rate` | `loadTenantRatingConfig(tenantDb…)` | **re-measured 2026-08-15 (audit §1628) — now YES, both directions.** §571 had already added the two ATTACK SHAPES (X-Tenant-Id, ?tenant=); what was missing was the VALUE direction. Mutating the handle to tenant-b's D1 reds **39 tests across 10 files** — so it never shipped green — but left the isolation suite itself at **67/67**, because those 39 are pricing/biller tests noticing wrong numbers. A case now prices the same physics through both surfaces and asserts the authenticated answer is tenant-a's and NOT tenant-b's (computed, not hardcoded); it reds alone under that mutation |

> **Rows re-measured 2026-08-04 (audit §174).** The first two said **"NO — add"** and were wrong — one of them for
> the strongest possible reason: the evidence path already had a full route-level cross-tenant case. The RED above
> claimed a dropped `${tenant}` "would ship green"; mutating each builder alone and re-running both suites shows
> **every variant fails** (anchors: 2 api cases + the ledger DoD test; evidence: 6 cases). **The premise was never
> measured.** What survives the measurement is narrower and still worth acting on: those catches are *incidental* —
> each depends on a hardcoded literal or a duplicated key helper on the test side (evidence-upload.test.ts:50
> re-implements `evidenceKey`). DRY them against the builder and seed and read move together, blinding all of them
> silently. That is why the anchor row's fix was an explicit literal assertion, not a route test. **Before using
> this skill's "NO — add" column as a work list, mutate the builder and run the suite — a stale NO costs a
> redundant test, but the belief that a gap exists where none does is how a registry rots.**

## Common Mistakes
- **Testing only a sample of attack shapes.** A route may reject `X-Tenant-Id` but honor `?tenant=`. Hit all four shapes on every path (isolation.test.ts:29).
- **Route test without a key-builder unit test.** Both tenants returning empty hides a dropped `${tenant}` prefix. Assert the literal key string (anchor.ts:58, evidence.ts:60).
- **Adding the read path and the test in different PRs.** REQ-025 is a per-merge gate — the case grows in the SAME PR (CLAUDE.md rule #8).
- **Trusting client-supplied tenant.** tenant comes from the JWT claim only via `tenantDb`/`session.tenant`; a header/query param must 403, never re-key the handle.
- **Closing a WP with an untested registry row (REQ-119).** At WP exit, grep every route for `session.tenant` and every `*Key(` builder with a `${tenant}` segment; each must be a row in `reference/read-path-registry.md` with a case in isolation.test.ts. A row with no test is an open Critical — do not close the WP.
