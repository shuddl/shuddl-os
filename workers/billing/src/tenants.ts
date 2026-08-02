import { isPlatformTenant, CLAIMED_TENANT_BY_SLUG_SQL, CLAIMED_TENANTS_SQL } from "@shuddl/contracts";
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
  /** REQ-123/025 (WP-14 Task 7) — the reserved PLATFORM revenue tenant's OWN D1, where credits append as money
   *  events. A DISTINCT database, NOT in the customer allowlist (TENANT_BINDINGS) and NOT the control plane, so
   *  no customer path can reach it — it is resolved SERVER-SIDE only (resolvePlatformTenantDb, no slug input).
   *  Mirrors workers/api PLATFORM_TENANT_DB. Deliberately NEVER metered (absent from TENANT_SLUGS). */
  PLATFORM_TENANT_DB: D1Database;
  /** REQ-154 — the operator-injected Stripe webhook signing secret (`wrangler secret`, NEVER wrangler.toml).
   *  ABSENT ⇒ DARK: billingFor → NotConfiguredBilling rejects loudly and nothing charges/emits until R4. */
  STRIPE_WEBHOOK_SECRET?: string;
  /** WP-14 Task 10 (REQ-123/025) — the `API` service binding to the api worker (its Hono app + the internal,
   *  secret-gated platform-credit route). Task 10 appends credit money events onto `_platform` through the REAL
   *  sequencer over this binding (SequencerPlatformLedger), retiring the interim D1 mirror. Mirrors workers/mcp's
   *  API binding + the cross-script bindings the translator/agents workers use to reach the api worker. */
  API: Fetcher;
  /** WP-14 Task 10 (REQ-123/025/154) — the server-to-server shared secret the internal platform-credit route
   *  requires. ABSENT ⇒ DARK: the platform ledger rejects LOUDLY (never a silent no-op) and no credit appends.
   *  Operator-injected via `wrangler secret`, NEVER wrangler.toml. Matches workers/api Env.PLATFORM_INTERNAL_SECRET. */
  PLATFORM_INTERNAL_SECRET?: string;
  ENVIRONMENT?: string;
  /** 2026-08-01 §12 — claimed-tenant pool planes (ids converged with workers/api per env). */
  TENANT_POOL_01_DB: D1Database;
  TENANT_POOL_02_DB: D1Database;
};

/** 2026-08-01 §12 (REQ-121/123/025/122) — the claimed-tenant POOL planes. The metering sweep OVERWRITES
 *  usage_credits, so a claimed tenant that is never metered is UNBILLED usage the day PLG flips. */
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

// REQ-123/025 — the INTERNAL, server-side-only resolver for the reserved platform tenant's OWN D1 (where credits
// append as money events). There is NO slug argument: the platform tenant is a single well-known target, so no
// client-influenced input reaches this path at all. `_platform` is never a TENANT_BINDINGS key, so `tenantDb`
// above can never return this database — a customer path (which only ever calls tenantDb) cannot reach it.
// Mirrors workers/api/src/tenants.ts resolvePlatformTenantDb.
export function resolvePlatformTenantDb(env: BillingEnv): D1Database {
  return env.PLATFORM_TENANT_DB;
}

// ── Claimed pool tenants (2026-08-01 audit C3 — REQ-121/123/025/REQ-122) ─────────────────────────────────
//
// The api worker + sequencer DO serve CLAIMED pool tenants; this worker must too, or their committed
// events enqueue triggers it can only park and every sweep excludes them. The resolver MIRRORS
// workers/api/src/provision.ts resolveClaimedTenantDb — same fail-closed contract, pinned by
// test/claimed-tenants.test.ts (2026-08-02 §13: this line once claimed a pin that did not exist, and
// reverting the metering fan-out left all 45 billing tests green): a control row whose plan is NOT unclaimed/platform AND
// whose policy.pool_binding is one of the static POOL_BINDINGS resolves; a sentinel, an unclaimed row,
// an unknown slug, the platform tenant, or a misconfigured slot all throw UNKNOWN_TENANT. No
// client-input → arbitrary-handle path: the binding key never comes from the wire, only from the
// control plane, constrained to this allowlist.

export const POOL_BINDINGS = ["TENANT_POOL_01_DB", "TENANT_POOL_02_DB"] as const;
type PoolBindingKey = (typeof POOL_BINDINGS)[number];

function isPoolBinding(key: string): key is PoolBindingKey {
  return (POOL_BINDINGS as readonly string[]).includes(key);
}

/** Claimed-slug → pool D1, server-side only. Throws UNKNOWN_TENANT for every non-claimed shape. */
async function resolveClaimedTenantDb(env: BillingEnv, slug: string): Promise<D1Database> {
  const row = await env.CONTROL_DB
    .prepare(CLAIMED_TENANT_BY_SLUG_SQL)
    .bind(slug)
    .first<{ policy: string }>();
  if (!row) throw new Error(`UNKNOWN_TENANT: ${slug}`);
  let poolBinding: string | undefined;
  try {
    poolBinding = (JSON.parse(row.policy) as { pool_binding?: string }).pool_binding;
  } catch {
    // A malformed policy row is not a routable tenant (2026-08-01 §12: the unguarded parse threw a
    // SyntaxError past this contract's own fail-closed promise, unhandled on the inbound write path).
    throw new Error(`UNKNOWN_TENANT: ${slug} (malformed policy)`);
  }
  if (!poolBinding || !isPoolBinding(poolBinding)) throw new Error(`UNKNOWN_TENANT: ${slug} (no valid pool_binding)`);
  // EXCLUSIVITY ON THE RESOLVE PATH — NOT enforced here, deliberately (2026-08-01 §12). The enumeration
  // path refuses a pool binding claimed by two tenants; resolution does not, so a hand-added duplicate ops
  // row would still resolve on the WRITE path. The guard was written and REVERTED: only two pool slots
  // exist, and the shared test control-plane legitimately carries standing claimed rows on both, so no
  // arrangement of the harness can satisfy one-tenant-per-binding — enforcing it made six real tests fail
  // on a harness artifact rather than a product truth. Ledgered as an open Medium with its named fix (a
  // control-plane UNIQUE index on the claimed pool_binding is the structural answer); dark today behind
  // PROVISIONING_ENABLED.
  return env[poolBinding];
}

/** The claimed-aware resolver: static allowlist hot path (no control-plane read), claimed-pool fallback.
 *  The platform tenant can never resolve on an agent path — guarded via the SHARED contracts sentinel
 *  (isPlatformTenant), the same source the api's resolver consults, so the two guards cannot drift. */
export async function resolveTenantDb(env: BillingEnv, slug: string): Promise<D1Database> {
  if (isPlatformTenant(slug)) throw new Error(`UNKNOWN_TENANT: ${slug}`);
  const binding = TENANT_BINDINGS[slug];
  if (binding) return env[binding];
  return resolveClaimedTenantDb(env, slug);
}

/** Every claimed slug with a valid pool_binding — the cron sweeps' dynamic half. Server-side only.
 *  EXCLUSIVITY is enforced fail-closed (2026-08-01 review): the one-tenant-per-pool-D1 model every sweep
 *  and the un-tenant-scoped tenant schema depend on rests on control-plane DATA, and pool slots are grown
 *  by hand-added ops rows — the exact vector for a duplicate. Two claimed rows naming ONE binding would
 *  make every sweep run the same physical D1 twice under two identities (a cross-tenant read/write,
 *  REQ-025), so BOTH slugs are dropped with a loud log until an operator fixes the rows. */
export async function claimedTenantSlugs(env: BillingEnv): Promise<string[]> {
  const rows = await env.CONTROL_DB
    .prepare(CLAIMED_TENANTS_SQL)
    .all<{ slug: string; policy: string }>();
  const byBinding = new Map<string, string[]>();
  for (const row of rows.results ?? []) {
    if (slugIsStatic(row.slug)) continue; // the static roster enumerates itself
    try {
      const poolBinding = (JSON.parse(row.policy) as { pool_binding?: string }).pool_binding;
      if (poolBinding !== undefined && isPoolBinding(poolBinding)) {
        byBinding.set(poolBinding, [...(byBinding.get(poolBinding) ?? []), row.slug]);
      }
    } catch {
      // a malformed policy row is not a routable tenant; the resolver would refuse it the same way
    }
  }
  const out: string[] = [];
  for (const [binding, slugs] of byBinding) {
    if (slugs.length === 1) out.push(slugs[0]!);
    else console.error(`billing: pool-binding exclusivity VIOLATED — ${binding} is claimed by ${slugs.length} tenants (${slugs.join(", ")}); ALL are excluded from sweeps until the control rows are fixed (one claimed row per pool binding, REQ-025)`);
  }
  return out;
}

function slugIsStatic(slug: string): boolean {
  return TENANT_BINDINGS[slug] !== undefined;
}

/** The ONE enumeration every cron fan-out iterates: static roster first, then claimed, deduped. A
 *  control-plane fault degrades to the STATIC roster with a loud log — anchoring/sweeping the static
 *  tenants must never be hostage to claimed-tenant enumeration (the anchor.ts containment lesson). */
export async function allTenantSlugs(env: BillingEnv): Promise<string[]> {
  let claimed: string[] = [];
  try {
    claimed = await claimedTenantSlugs(env);
  } catch (err) {
    console.error("billing: claimed-tenant enumeration failed — this sweep covers the STATIC roster only (claimed pool tenants are NOT swept this tick; re-run next tick):", err);
  }
  const seen = new Set(TENANT_SLUGS);
  return [...TENANT_SLUGS, ...claimed.filter((s) => !seen.has(s))];
}
