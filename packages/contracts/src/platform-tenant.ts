// REQ-123/025 (WP-14 Task 1): the reserved PLATFORM revenue tenant.
//
// WP-14 ships PLG DARK (fail-closed until R4). This module names the single well-known tenant the credits/
// usage-billing ledger provisions against — a NEW cross-tenant read surface, and therefore the highest-risk
// artifact in the work package. It MUST be isolated in BOTH directions (REQ-025): no customer path may ever
// resolve or read it, and a read on its own D1 may never reach a customer tenant.
//
// WHY the sentinel can NEVER collide with a customer slug:
//   1. SHAPE — a customer slug is a DNS-hostname label: it routes the public /pub surface via HOST_TENANTS
//      (new URL(url).hostname) and names the per-tenant physical D1 `shuddl-t-{slug}-{env}` (genesis/14 §02).
//      A DNS label is `[a-z0-9]` with internal hyphens and may NOT begin with "_". A leading underscore is
//      therefore outside the customer slug space by construction — no onboarding can mint `_platform`.
//   2. ALLOWLIST — the customer resolver (workers/api/src/tenants.ts TENANT_BINDINGS) is a static, code-
//      reviewed map; the sentinel is never a key, so tenantDb() fail-closes it to FORBIDDEN.
//   3. GUARD — assertNotPlatformTenant() is called by every customer-facing tenant-claim / provisioning path
//      so even a future DYNAMIC slug provisioner cannot accept the reserved id.
// Keep this string frozen: the whole billing plane keys the reserved control-plane row + its D1 off it.
export const PLATFORM_TENANT_ID = "_platform";

/** True ONLY for the reserved platform tenant id/slug. Nothing a customer path may resolve is platform. */
export function isPlatformTenant(slug: string): boolean {
  return slug === PLATFORM_TENANT_ID;
}

/**
 * Fail-closed guard for any customer-facing path that accepts a tenant slug. Throws if the caller named the
 * reserved platform id where a CUSTOMER slug is expected, so the reserved revenue tenant can never be claimed
 * or addressed from a customer surface (REQ-025). Throws a plain Error (contracts is the zod-only boundary
 * package — it never depends on the workers' ApiError); the customer HTTP resolver in workers/api maps its own
 * FORBIDDEN separately.
 *
 * REAL CALLERS (WP-14): (1) workers/api/src/provision.ts provisionTenant() — the pool-based DYNAMIC tenant
 * provisioner calls this on the requested customer slug so `_platform` can never be claimed as a customer
 * (pool sentinels `_pool_0N` are additionally excluded by the DNS-label slug shape); and (2)
 * resolveClaimedTenantDb() so the platform id can never resolve a claimed workspace. This closes the Task-1
 * forward-looking note ("a future DYNAMIC slug provisioner cannot accept the reserved id"): that provisioner
 * now exists and enforces it.
 */
export function assertNotPlatformTenant(slug: string): void {
  if (isPlatformTenant(slug)) {
    throw new Error(`PLATFORM_TENANT_FORBIDDEN: "${slug}" is the reserved platform tenant — not addressable from a customer path`);
  }
}
