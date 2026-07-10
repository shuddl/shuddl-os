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
