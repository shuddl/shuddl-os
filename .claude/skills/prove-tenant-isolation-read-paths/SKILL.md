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
`workers/api/test/isolation.test.ts:5` promises the suite "grows a case for every read path added in later WPs." It covers `_probe`, ledger events, and positions. It has **zero** cases for three shipped tenant-storage paths:
- `evidence.ts` — `evidenceKey(session.tenant, ...)` builds `evidence/${tenant}/${shipmentId}/${hash}` (evidence.ts:60 defines it; the route calls `evidenceKey(session.tenant, ...)` before `EVIDENCE.put`).
- `anchors.ts:38` — `readAnchorManifest(c.env.EVIDENCE, session.tenant, day)`, keyed by `anchorManifestKey` = `anchors/${tenant}/${day}/manifest.json` (packages/ledger/src/anchor.ts:58,61).
- `rate.ts:127` — `loadTenantRatingConfig(tenantDb(c.env, session.tenant), now)`.

So a regression that dropped `${tenant}` from `evidenceKey` or `anchorManifestKey` would ship green. Close it two ways: (1) an isolation.test case per path with all attack shapes; (2) a direct unit assertion that each key builder embeds the tenant.

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
| `/v1/anchors/:day`, `/proof`, `/run` | `anchorManifestKey`, `anchorReceiptKey`, `tenantDb` | **NO — add** |
| evidence upload/serve | `evidenceKey(session.tenant,…)` | **NO — add** |
| `/v1/rate` | `loadTenantRatingConfig(tenantDb…)` | **NO — add** |

## Common Mistakes
- **Testing only a sample of attack shapes.** A route may reject `X-Tenant-Id` but honor `?tenant=`. Hit all four shapes on every path (isolation.test.ts:29).
- **Route test without a key-builder unit test.** Both tenants returning empty hides a dropped `${tenant}` prefix. Assert the literal key string (anchor.ts:58, evidence.ts:60).
- **Adding the read path and the test in different PRs.** REQ-025 is a per-merge gate — the case grows in the SAME PR (CLAUDE.md rule #8).
- **Trusting client-supplied tenant.** tenant comes from the JWT claim only via `tenantDb`/`session.tenant`; a header/query param must 403, never re-key the handle.
- **Closing a WP with an untested registry row (REQ-119).** At WP exit, grep every route for `session.tenant` and every `*Key(` builder with a `${tenant}` segment; each must be a row in `reference/read-path-registry.md` with a case in isolation.test.ts. A row with no test is an open Critical — do not close the WP.
