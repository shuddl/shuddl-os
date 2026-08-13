import { describe, expect, it } from "vitest";
import { TENANT_SLUGS } from "../src/tenants.js";
import apiTenantsSrc from "../../api/src/tenants.ts?raw";
import agentsTenantsSrc from "../src/tenants.ts?raw";

// REQ-014 / REQ-025 — the cron's tenant allowlist MUST match the API's, or a tenant silently stops
// being anchored. We diff the slug literals in both source files (regex on the raw text), so adding a
// tenant to one file without the other fails this test.

function slugSet(src: string): Set<string> {
  return new Set([...src.matchAll(/"(tenant-[a-z0-9-]+)"/g)].map((m) => m[1]!));
}

// §1353 — THIS GATE ASSERTS IDENTITY ONLY, AND THAT IS NOT THE WHOLE GUARANTEE.
// Two rosters that BOTH dropped a tenant are in perfect parity, so the assertion below stays green while a
// tenant silently stops being served everywhere at once — §786's warning ("a parity test alone would happily
// certify two copies that are identically WRONG"), demonstrated concretely at §1352 M2 on the TSA factories.
// The missing PROPERTY is pinned elsewhere and deliberately recorded here because nothing links them:
//   · `tenant-resolution.test.ts` — `TENANT_SLUGS.length > 1` (pre-existing)
//   · `sweep-containment.test.ts` / `claimed-tenants.test.ts` — `TENANT_SLUGS[0] === "tenant-a"` and length ≥ 2,
//     added at §1311/§1312 for the containment premise, which is a DIFFERENT purpose that happens to cover this.
// Incidental coverage is real coverage, but it can be deleted by someone editing a containment test who has no
// idea this gate leans on it. If those go, this file needs its own length/order assertion.
describe("REQ-014 — anchor cron tenant allowlist parity with the API", () => {
  it("agents TENANT_SLUGS equals the slugs declared in workers/api/src/tenants.ts", () => {
    const apiSlugs = slugSet(apiTenantsSrc);
    const agentsSlugs = slugSet(agentsTenantsSrc);
    expect(apiSlugs.size).toBeGreaterThan(0);
    expect([...agentsSlugs].sort()).toEqual([...apiSlugs].sort());
    // and the runtime export agrees with its own source
    expect([...TENANT_SLUGS].sort()).toEqual([...agentsSlugs].sort());
  });
});
