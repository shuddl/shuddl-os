import { describe, expect, it } from "vitest";
import apiTenantsSrc from "../../api/src/tenants.ts?raw";
import mineTenantsSrc from "../src/tenants.ts?raw";
import { TENANT_SLUGS } from "../src/tenants.js";

// THE THIRD AND FOURTH COPIES (audit §224). workers/agents/test/tenants-parity.test.ts guards the agents
// roster against the api's — "or a tenant silently stops being anchored" (REQ-014/025). There are FOUR
// copies of tenants.ts (api, agents, billing, translator) and that guard covered two.
//
// This worker's own source states the obligation: billing/src/tenants.ts opens by naming the api's
// TENANT_BINDINGS and workers/translator/src/tenants.ts as "the SAME customer tenants". Nothing enforced
// the three-way claim.
//
// Same mechanism as the original — diff the slug literals in the raw sources, then confirm the runtime
// export agrees with its own file. A tenant added to the api without this worker fails here rather than
// silently dropping out of EDI ingest (a tenant whose 204s resolve to nothing).
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
describe("REQ-014/REQ-025 — translator tenant allowlist parity with the API", () => {
  it("translator TENANT_SLUGS equals the slugs declared in workers/api/src/tenants.ts", () => {
    const apiSlugs = slugSet(apiTenantsSrc);
    const mine = slugSet(mineTenantsSrc);
    expect(apiSlugs.size).toBeGreaterThan(0);
    expect([...mine].sort()).toEqual([...apiSlugs].sort());
    expect([...TENANT_SLUGS].sort()).toEqual([...mine].sort());
  });
});
