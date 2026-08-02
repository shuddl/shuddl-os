// Tenant allowlist for the anchor cron. This is a MIRROR of workers/api/src/tenants.ts — if the two
// drift, a tenant silently stops being anchored (its daily Merkle root never gets a TSA receipt). A
// parity unit test (test/tenants-parity.test.ts) asserts the slug sets match, so drift fails CI.

import { isPlatformTenant, CLAIMED_TENANT_BY_SLUG_SQL, CLAIMED_TENANTS_SQL } from "@shuddl/contracts";

export type AgentsEnv = {
  TENANT_A_DB: D1Database;
  TENANT_B_DB: D1Database;
  /** 2026-08-01 audit C3 (REQ-121/123/025) — the claimed-tenant POOL planes, mirroring workers/api. Bound so
   *  the Biller/Concierge/Booking consumers and every cron sweep can serve a CLAIMED pool tenant; resolution
   *  is server-side-only through resolveClaimedTenantDb (control row → pool_binding ∈ POOL_BINDINGS). */
  TENANT_POOL_01_DB: D1Database;
  TENANT_POOL_02_DB: D1Database;
  EVIDENCE: R2Bucket;
  /** The api worker's sequencer DO (cross-script binding) — the Biller's ONLY write path (I2 + money projection run there). */
  SHIPMENT_SEQ: DurableObjectNamespace;
  /** WP-14 Task 8 (REQ-122/125) — the control plane (`tenants.plan` = the Spark tier flag; `tenants.policy` =
   *  the per-tenant AI-credit allotment). READ-ONLY here: the Spark convenience cap resolves the plan + allotment;
   *  it NEVER writes control rows. A SEPARATE database from any tenant D1 (REQ-025). Mirrors workers/api CONTROL_DB. */
  CONTROL_DB: D1Database;
  /** WP-14 Task 8 (REQ-122/125) — the per-TENANT Spark convenience meter DO (`idFromName(tenant)`). Caps the
   *  LLM-powered agent conveniences (Concierge auto-quote) for an over-allotment Spark tenant; it is NEVER
   *  consulted on the physical-truth append path or the Biller invoice ("credits throttle conveniences, not
   *  truth"). A Durable Object is NOT a D1 table — the 22-table ceiling is untouched. */
  SPARK_METER: DurableObjectNamespace;
  /** REQ-169 — the agent-trigger queue PRODUCER (the SAME queue this worker consumes + the DO produces to). The
   *  reconciliation sweep re-enqueues a lost pod.signed Biller trigger here so the queue() consumer re-drives it. */
  AGENT_QUEUE: Queue;
  ENVIRONMENT?: string;
  /** REQ-092/157 — BOTH present ⇒ ResendSender; otherwise NotConfiguredSender. Secrets via `wrangler secret`, never this file's toml. */
  RESEND_API_KEY?: string;
  EVIDENCE_FROM?: string;
  /** REQ-129 — the evidence email's referral link base. */
  REFERRAL_BASE?: string;
  // ── WP-07 Concierge (REQ-024/098). ──
  /** REQ-024 — BOTH present ⇒ ClaudeParser; otherwise NotConfiguredParser (rejects loudly, never a silent
   *  low-confidence parse). Secret via `wrangler secret`, never this file's toml. CONFIRM-gated (see WP-07). */
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  /** REQ-098 tenant voice — the config-seeded from-name that signs the auto-reply. Defaults to a generic. */
  CONCIERGE_FROM_NAME?: string;
  // ── Operator-set ONLY, for the guarded dev-only live-send probe (POST /_dev/evidence-test-send). ──
  //    All optional: absent ⇒ the route is inert (404). Real values are set per-environment by the
  //    operator (RESEND_API_KEY + TEST_SEND_TOKEN via `wrangler secret put`, never in the toml).
  /** "1" (and ONLY "1") arms the probe route; anything else ⇒ 404 (inert). */
  ALLOW_TEST_SEND?: string;
  /** The probe's bearer token (secret). Unset while ALLOW_TEST_SEND==="1" ⇒ the route 500s, fail-closed. */
  TEST_SEND_TOKEN?: string;
  /** The probe's SINK recipient — operator-controlled. Unset ⇒ the hardcoded "delivered@resend.dev" sink. */
  TEST_SEND_TO?: string;
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

// ── Claimed pool tenants (2026-08-01 audit C3 — REQ-121/123/025/169) ─────────────────────────────────
//
// The api worker + sequencer DO serve CLAIMED pool tenants; this worker must too, or their committed
// events enqueue triggers it can only park and every sweep excludes them. The resolver MIRRORS
// workers/api/src/provision.ts resolveClaimedTenantDb — same fail-closed contract, pinned by the pool
// parity test the way the slug roster already is: a control row whose plan is NOT unclaimed/platform AND
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
async function resolveClaimedTenantDb(env: AgentsEnv, slug: string): Promise<D1Database> {
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
export async function resolveTenantDb(env: AgentsEnv, slug: string): Promise<D1Database> {
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
export async function claimedTenantSlugs(env: AgentsEnv): Promise<string[]> {
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
    else console.error(`agents: pool-binding exclusivity VIOLATED — ${binding} is claimed by ${slugs.length} tenants (${slugs.join(", ")}); ALL are excluded from sweeps until the control rows are fixed (one claimed row per pool binding, REQ-025)`);
  }
  return out;
}

function slugIsStatic(slug: string): boolean {
  return TENANT_BINDINGS[slug] !== undefined;
}

/** The ONE enumeration every cron fan-out iterates: static roster first, then claimed, deduped. A
 *  control-plane fault degrades to the STATIC roster with a loud log — anchoring/sweeping the static
 *  tenants must never be hostage to claimed-tenant enumeration (the anchor.ts containment lesson). */
export async function allTenantSlugs(env: AgentsEnv): Promise<string[]> {
  let claimed: string[] = [];
  try {
    claimed = await claimedTenantSlugs(env);
  } catch (err) {
    console.error("agents: claimed-tenant enumeration failed — this sweep covers the STATIC roster only (claimed pool tenants are NOT swept this tick; re-run next tick):", err);
  }
  const seen = new Set(TENANT_SLUGS);
  return [...TENANT_SLUGS, ...claimed.filter((s) => !seen.has(s))];
}
