import type { Env } from "./index.js";
import { ApiError } from "./middleware/error.js";
import { isPlatformTenant } from "@shuddl/contracts";

// REQ-025: tenant → D1 binding is a server-side allowlist keyed by the JWT claim.
// There is no code path from client input to a database handle. EXPORTED so the WP-09 public host
// allowlist (HOST_TENANTS in src/pub/quote.ts) can be proven a structural subset of it — every hostname
// the /pub surface resolves MUST map to a tenant this core allowlist actually binds (ISO-pub-5 parity test,
// share-lint-matchers skill). The public map may never conjure a tenant the core map doesn't know.
export const TENANT_BINDINGS: Record<string, keyof Pick<Env, "TENANT_A_DB" | "TENANT_B_DB">> = {
  "tenant-a": "TENANT_A_DB",
  "tenant-b": "TENANT_B_DB",
};

export function tenantDb(env: Env, tenantSlug: string): D1Database {
  // REQ-123/025 fail-closed FIRST: the reserved PLATFORM revenue tenant is NEVER resolvable through the
  // customer path — its own D1 is reached only server-side (resolvePlatformTenantDb below). This guard is
  // defense-in-depth ON TOP of the allowlist: `_platform` is not a TENANT_BINDINGS key (so the lookup would
  // FORBIDDEN it anyway), but rejecting it explicitly here keeps the guarantee true even if the allowlist
  // were ever mis-edited to add it. A customer JWT that carries tenant=_platform dies here, before any handle.
  if (isPlatformTenant(tenantSlug)) throw new ApiError("FORBIDDEN", 403, "UNKNOWN TENANT");
  const binding = TENANT_BINDINGS[tenantSlug];
  if (!binding) throw new ApiError("FORBIDDEN", 403, "UNKNOWN TENANT");
  return env[binding];
}

// REQ-123/025: the INTERNAL, server-side-only resolver for the reserved platform tenant's OWN D1. It binds a
// DISTINCT database (PLATFORM_TENANT_DB) that is NOT in the customer allowlist and NOT the control plane — so
// no customer route/lens can reach it (they only ever call tenantDb). The later usage/credits billing worker
// binds this the same way. There is no slug argument: the platform tenant is a single well-known target, so
// there is no client-influenced input on this path at all.
export function resolvePlatformTenantDb(env: Env): D1Database {
  return env.PLATFORM_TENANT_DB;
}
