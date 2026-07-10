// Tenant allowlist for the anchor cron. This is a MIRROR of workers/api/src/tenants.ts — if the two
// drift, a tenant silently stops being anchored (its daily Merkle root never gets a TSA receipt). A
// parity unit test (test/tenants-parity.test.ts) asserts the slug sets match, so drift fails CI.

export type AgentsEnv = {
  TENANT_A_DB: D1Database;
  TENANT_B_DB: D1Database;
  EVIDENCE: R2Bucket;
  ENVIRONMENT?: string;
};

const TENANT_BINDINGS: Record<string, keyof Pick<AgentsEnv, "TENANT_A_DB" | "TENANT_B_DB">> = {
  "tenant-a": "TENANT_A_DB",
  "tenant-b": "TENANT_B_DB",
};

export const TENANT_SLUGS: readonly string[] = Object.keys(TENANT_BINDINGS);

export function tenantDb(env: AgentsEnv, slug: string): D1Database {
  const binding = TENANT_BINDINGS[slug];
  if (!binding) throw new Error(`UNKNOWN_TENANT: ${slug}`);
  return env[binding];
}
