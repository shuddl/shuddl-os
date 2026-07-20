// Tenant allowlist for the Billing worker's metering sweep. A MIRROR of workers/api/src/tenants.ts
// (TENANT_BINDINGS) and workers/translator/src/tenants.ts — the SAME customer tenants the rest of the platform
// binds. REQ-025 isolation: this server-side allowlist is the ONLY tenant→D1 map; there is no code path from
// client input to a database handle. The reserved `_platform` revenue tenant and the `_pool_0N` pool sentinels
// are DELIBERATELY ABSENT — they are NEVER metered as customers, so the sweep iterates ONLY paying tenants.

export type BillingEnv = {
  TENANT_A_DB: D1Database;
  TENANT_B_DB: D1Database;
  /** Control plane (usage_credits — the metering OVERWRITE target; the tenants roster). A SEPARATE database
   *  from any tenant D1 (which is exactly why metering is a scheduled recompute, not a sequencer batch). The
   *  sweep WRITES only each customer tenant's OWN usage_credits row here; it is never a tenant DATA path
   *  (REQ-025). */
  CONTROL_DB: D1Database;
  ENVIRONMENT?: string;
};

const TENANT_BINDINGS: Record<string, keyof Pick<BillingEnv, "TENANT_A_DB" | "TENANT_B_DB">> = {
  "tenant-a": "TENANT_A_DB",
  "tenant-b": "TENANT_B_DB",
};

// The customer tenants the sweep iterates (REQ-025: one tenant's D1 read + its OWN control row write per
// iteration). No `_platform`, no pool sentinel — those are never in the metering roster.
export const TENANT_SLUGS: readonly string[] = Object.keys(TENANT_BINDINGS);

export function tenantDb(env: BillingEnv, slug: string): D1Database {
  const binding = TENANT_BINDINGS[slug];
  if (!binding) throw new Error(`UNKNOWN_TENANT: ${slug}`);
  return env[binding];
}
