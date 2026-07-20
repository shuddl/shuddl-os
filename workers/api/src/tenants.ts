import type { Env } from "./index.js";
import { ApiError } from "./middleware/error.js";
import { isPlatformTenant } from "@shuddl/contracts";
import { resolveClaimedTenantDb } from "./provision.js";

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

// REQ-121/025 (WP-14 Task 3) — the CLAIMED-TENANT-AWARE read resolver the /v1 CUSTOMER routes use.
//
// The static `tenantDb` above binds ONLY the code-reviewed customer allowlist (tenant-a/b) and FORBIDDENs
// everything else. But a self-serve tenant provisioned by CLAIMING a pool slot (provision.ts) carries a slug
// that is NOT a TENANT_BINDINGS key, so its admin session could never reach its own workspace. This resolver
// adds the ONE controlled fallback: a non-static slug is resolved SERVER-SIDE in the control plane
// (resolveClaimedTenantDb → the `tenants` row → policy.pool_binding, constrained to the static POOL_BINDINGS
// allowlist), never from arbitrary client input straight to an arbitrary handle.
//
// REQ-025 stays airtight — the fallback does NOT widen isolation. The exact guard chain:
//   1. PLATFORM guard FIRST — `_platform` dies here before any binding OR control read (same as tenantDb);
//      resolveClaimedTenantDb re-asserts it, so it is closed twice.
//   2. HOT PATH — a static customer slug (tenant-a/b) returns its binding with NO control-plane round-trip;
//      the static allowlist + the ISO-pub-5 subset-parity (HOST_TENANTS ⊆ TENANT_BINDINGS) are UNTOUCHED.
//   3. FALLBACK — only a GENUINELY-CLAIMED pool tenant resolves: a `tenants` row whose plan is NOT
//      unclaimed/platform AND whose policy.pool_binding is one of the static POOL_BINDINGS (isPoolBinding).
//      A sentinel (`_pool_0N`, plan unclaimed), an unclaimed row, an unknown slug, or a misconfigured slot all
//      THROW inside resolveClaimedTenantDb → caught here → mapped to the SAME fail-closed FORBIDDEN as a static
//      miss: no tenant-existence oracle, no cross-tenant reach, no arbitrary-handle path. The pool remains a
//      separate, server-side-only resolution surface.
//
// A claimed tenant only EXISTS when provisioning created it (DARK posture: PROVISIONING_ENABLED). Until then
// this fallback can never resolve anything — every non-static slug is a FORBIDDEN.
export async function resolveTenantDb(env: Env, tenantSlug: string): Promise<D1Database> {
  if (isPlatformTenant(tenantSlug)) throw new ApiError("FORBIDDEN", 403, "UNKNOWN TENANT");
  const binding = TENANT_BINDINGS[tenantSlug];
  if (binding) return env[binding]; // hot path — the static customer allowlist, no control-plane read
  try {
    return await resolveClaimedTenantDb(env, tenantSlug);
  } catch {
    // sentinel / unclaimed / unknown / misconfigured — fail closed to the SAME FORBIDDEN as a static miss.
    throw new ApiError("FORBIDDEN", 403, "UNKNOWN TENANT");
  }
}

// REQ-123/025: the INTERNAL, server-side-only resolver for the reserved platform tenant's OWN D1. It binds a
// DISTINCT database (PLATFORM_TENANT_DB) that is NOT in the customer allowlist and NOT the control plane — so
// no customer route/lens can reach it (they only ever call tenantDb). The later usage/credits billing worker
// binds this the same way. There is no slug argument: the platform tenant is a single well-known target, so
// there is no client-influenced input on this path at all.
export function resolvePlatformTenantDb(env: Env): D1Database {
  return env.PLATFORM_TENANT_DB;
}
