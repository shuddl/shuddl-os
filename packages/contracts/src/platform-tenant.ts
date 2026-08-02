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

// ---- The RESERVED plan values, and the one predicate that separates a customer from a sentinel --------
//
// 2026-08-02 audit §14 (REQ-121/123/025). `tenants.plan` carries two reserved values that mean "this row is
// NOT a billable customer": an `unclaimed` pool slot waiting to be claimed, and the reserved `platform`
// revenue tenant. Every claimed-tenant read in every worker must exclude both — the resolve path (api
// `resolveClaimedTenantDb`, and the agents/translator/billing `resolveTenantDb` fallbacks) and the
// enumeration path (`claimedTenantSlugs`, which drives the metering sweep, the nine agent crons and the
// 214 sweep).
//
// It was written SEVEN times as a raw SQL string across four workers, with no parity pin — the exact shape
// of every divergence this audit has been closing. The rule and its SQL now have one home. A NEW reserved
// plan (a `suspended` delinquent, a `churned` account) added to this array propagates to all seven call
// sites at once; adding it to one worker's string literal, as the duplicated form invited, would have left
// billing metering a suspended tenant and the translator still transmitting its EDI.
//
// The fragment is built from the frozen array so the two can never disagree. It is a CONSTANT and must stay
// one: nothing here may ever be composed from input — the only bound parameter in these queries is `slug`.
export const UNCLAIMED_TENANT_PLAN = "unclaimed";
export const PLATFORM_TENANT_PLAN = "platform";
export const RESERVED_TENANT_PLANS = [UNCLAIMED_TENANT_PLAN, PLATFORM_TENANT_PLAN] as const;

/** `plan NOT IN ('unclaimed','platform')` — the WHERE fragment every claimed-tenant read shares. */
export const CLAIMED_TENANT_PLAN_SQL = `plan NOT IN (${RESERVED_TENANT_PLANS.map((p) => `'${p}'`).join(",")})`;

/** The single claimed row by slug (resolve path). Bind: slug. */
export const CLAIMED_TENANT_BY_SLUG_SQL = `SELECT policy FROM tenants WHERE slug = ? AND ${CLAIMED_TENANT_PLAN_SQL}`;

/** Every claimed row (enumeration path — the sweeps' fan-out). No binds. */
export const CLAIMED_TENANTS_SQL = `SELECT slug, policy FROM tenants WHERE ${CLAIMED_TENANT_PLAN_SQL}`;

// ---- The usage_credits row identity (REQ-123) ---------------------------------------------------------
//
// THREE writers touch this control-plane row and all three upsert `ON CONFLICT(id)`, so they must agree on
// `id` byte for byte or the conflict never fires and the tenant silently carries two rows:
//   · workers/billing/src/metering.ts  — the hourly recompute that OVERWRITES `metered`
//   · workers/billing/src/credits.ts   — the Stripe stamp that MERGES `stripe_refs`
//   · workers/api/src/provision.ts     — the initial row in the atomic claim batch
//
// 2026-08-02: provisioning had in fact diverged (`uc-<slot>-<period>`, and the SLOT id as `tenant_id`), so a
// claimed tenant's provisioned row could never merge with either writer — it stayed permanently empty while
// the real meter and the real Stripe refs accumulated on the other. §13 fixed the shape but left TWO
// definitions, one of which called itself "the ONE definition" while the other predated it. This is now
// genuinely the one: the workers re-export it, they do not redefine it.
//
// `tenant_id` is the SLUG, matching this id — deliberately NOT `tenants.id`, which is the convention
// `users.tenant_id` follows. The two are not joined anywhere today (verified 2026-08-02); the divergence is
// noted on the DDL in db/control/migrations/0001_control.sql so a future JOIN does not assume otherwise.
export function usageCreditsId(tenantSlug: string, period: string): string {
  return `${tenantSlug}:${period}`;
}
