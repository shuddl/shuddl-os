import { z, assertNotPlatformTenant } from "@shuddl/contracts";
import type { Env } from "./index.js";

// WP-14 Task 2 (REQ-121/025) — POOL-BASED DYNAMIC TENANT PROVISIONING, FLAG-GATED DARK.
//
// A stranger becomes a provisioned tenant by CLAIMING a slot from a pool of pre-provisioned, MIGRATED tenant
// D1s. Cloudflare Worker bindings are STATIC (declared in wrangler.toml, resolved at deploy), so provisioning
// can never MINT a new D1 handle at runtime — it can only claim a reserved one that ops created out-of-band.
// This module is the CLAIM: it flips a reserved control-plane slot to a customer and returns the workspace D1.
//
// FAIL-CLOSED / DARK (REQ-121): the whole path sits behind a server-side flag (PROVISIONING_ENABLED) that is
// OFF by DEFAULT — absent from every wrangler.toml. Until R4 flips it, provisionTenant() REFUSES. This is the
// same composition-root discipline as the copilot's LLM binding and the Biller's NotConfiguredSender: an
// unbound/OFF capability rejects LOUDLY, it never silently no-ops.
//
// NO NEW TABLE (I8 budget stays 21/22): the claimed-registry is the EXISTING `tenants` control table. Each pool
// slot is a reserved `tenants` row (id/slug `_pool_0N`, plan `unclaimed`, policy.pool_binding → its D1 binding
// key). The customer resolver (TENANT_BINDINGS in tenants.ts) is UNTOUCHED, so the REQ-025 ISO-pub-5
// subset-parity (HOST_TENANTS ⊆ TENANT_BINDINGS) still holds — the pool is a SEPARATE, server-side-only
// resolution surface, and the client-supplied slug is only ever looked up in the control plane, which returns a
// binding key constrained to the static POOL_BINDINGS allowlist. There is no client-input → arbitrary-handle path.

// The static, code-reviewed allowlist of pool D1 binding keys. A control-plane pool_binding is honored ONLY if
// it is one of these — the same defense the customer path gets from TENANT_BINDINGS. Grow it alongside the
// wrangler slots + sentinel rows (0003_tenant_pool.sql).
export const POOL_BINDINGS = ["TENANT_POOL_01_DB", "TENANT_POOL_02_DB"] as const;
export type PoolBindingKey = (typeof POOL_BINDINGS)[number];

function isPoolBinding(key: string): key is PoolBindingKey {
  return (POOL_BINDINGS as readonly string[]).includes(key);
}

// Reserved plan values a customer can NEVER be provisioned into (the pool sentinel + the platform tenant).
const RESERVED_PLANS = new Set(["unclaimed", "platform"]);

// A customer slug MUST be a DNS-hostname label (genesis/14 §02: it names the per-tenant physical D1 and routes
// the /pub surface): [a-z0-9] with internal hyphens, no leading/trailing hyphen, no leading "_". This rejects
// EVERY sentinel (`_platform`, `_pool_0N`) by construction — a leading underscore is outside the customer space.
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const ProvisionInput = z
  .object({
    slug: z.string().regex(DNS_LABEL, "slug must be a DNS-hostname label ([a-z0-9-], no leading underscore)"),
    name: z.string().min(1).max(200),
    plan: z.string().min(1).max(40),
    admin: z.object({ email: z.string().email(), user_id: z.string().min(1).optional() }).strict(),
    // The initial usage_credits meter period (YYYY-MM). Optional — defaults to the current month.
    period: z.string().min(1).max(20).optional(),
  })
  .strict();
export type ProvisionInput = z.infer<typeof ProvisionInput>;

export type ProvisionErrorCode =
  | "PROVISIONING_DISABLED" // the DARK flag is OFF (fail-closed default)
  | "INVALID_INPUT" // Zod-invalid input (incl. a sentinel-shaped slug)
  | "RESERVED_PLAN" // a customer cannot take a reserved plan value
  | "POOL_EXHAUSTED" // no unclaimed slot remains — ops must pre-provision more
  | "PROVISION_FAILED" // the atomic claim batch failed and ROLLED BACK (no half-claim)
  | "NOT_CLAIMED"; // resolveClaimedTenantDb: the slug is not a claimed pool tenant

export class ProvisionError extends Error {
  constructor(
    public code: ProvisionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProvisionError";
  }
}

/** Server-side flag read off the Worker Env ONLY (never a client input). DARK by default: absent ⇒ false. */
export function provisioningEnabled(env: Env): boolean {
  return env.PROVISIONING_ENABLED === "true";
}

export type ProvisionedTenant = {
  tenant_id: string;
  slug: string;
  plan: string;
  pool_binding: PoolBindingKey;
  db: D1Database; // the claimed workspace handle
};

/**
 * Claim an unclaimed pool slot for a NEW customer tenant. All writes are CONTROL-PLANE only (no tenant-data
 * write): the `tenants` slot is flipped to the customer, and an admin `users` row + an initial `usage_credits`
 * row are inserted — in ONE atomic D1 batch (all-or-nothing), so a partial failure leaves no half-claimed slot.
 *
 * Returns the workspace handle (the claimed pool D1). DARK: refuses unless PROVISIONING_ENABLED === "true".
 */
export async function provisionTenant(env: Env, input: ProvisionInput): Promise<ProvisionedTenant> {
  // 1. FLAG (fail-closed, DARK): the outermost gate — refuse before revealing anything (REQ-121).
  if (!provisioningEnabled(env)) {
    throw new ProvisionError("PROVISIONING_DISABLED", "self-serve provisioning is dark (fail-closed until R4)");
  }

  // 2. GUARD (REQ-025) — the reserved platform id can NEVER be claimed as a customer. This closes the Task-1
  // forward-looking note: assertNotPlatformTenant now has a REAL provisioning caller. Runs on the raw slug so
  // the guarantee holds even before Zod. (Pool sentinels `_pool_0N` are caught by the DNS-label shape below.)
  assertNotPlatformTenant(typeof input?.slug === "string" ? input.slug : "");

  // 3. BOUNDARY — Zod validates shape; the DNS-label slug rule structurally excludes every `_`-prefixed sentinel.
  const parsed = ProvisionInput.safeParse(input);
  if (!parsed.success) throw new ProvisionError("INVALID_INPUT", parsed.error.message);
  const { slug, name, plan, admin, period } = parsed.data;

  // 4. A customer may not take a reserved plan value.
  if (RESERVED_PLANS.has(plan)) {
    throw new ProvisionError("RESERVED_PLAN", `plan "${plan}" is reserved and cannot be provisioned onto a customer`);
  }

  const control = env.CONTROL_DB;
  const createdTs = Date.now();
  const billingPeriod = period ?? new Date(createdTs).toISOString().slice(0, 7); // YYYY-MM
  const userId = admin.user_id ?? `u-admin-${slug}`;

  // 5. CLAIM — bounded retry: pick the lowest unclaimed slot and atomically flip it. A conditional UPDATE
  // (WHERE plan='unclaimed') is the compare-and-swap; if two signups race the same slot only one flips it
  // (changes===1) and the loser (changes===0) moves to the next slot. Bounded by the pool size.
  for (let attempt = 0; attempt < POOL_BINDINGS.length; attempt++) {
    const slot = await control
      .prepare("SELECT id, policy FROM tenants WHERE plan = 'unclaimed' ORDER BY id LIMIT 1")
      .first<{ id: string; policy: string }>();
    if (!slot) break; // no unclaimed slot remains

    const poolBinding = (JSON.parse(slot.policy) as { pool_binding?: string }).pool_binding;
    if (!poolBinding || !isPoolBinding(poolBinding)) {
      throw new ProvisionError("PROVISION_FAILED", `pool slot ${slot.id} has no valid pool_binding — pool is misconfigured`);
    }
    const newPolicy = JSON.stringify({ pool_binding: poolBinding });
    const creditsId = `uc-${slot.id}-${billingPeriod}`;

    // ONE atomic batch (D1 wraps it in a single transaction; any failure rolls back ALL of it). The two
    // INSERTs are GATED on the flip winning — `WHERE EXISTS (the tenants row now carries OUR slug+plan)` —
    // so a lost CAS commits NOTHING (no orphan admin/credits for a slot we did not win).
    let results;
    try {
      results = await control.batch([
        control
          .prepare("UPDATE tenants SET slug = ?, name = ?, plan = ?, policy = ?, created_ts = ? WHERE id = ? AND plan = 'unclaimed'")
          .bind(slug, name, plan, newPolicy, createdTs, slot.id),
        control
          .prepare(
            "INSERT INTO users (id, tenant_id, email, role, auth, device_keys) " +
              "SELECT ?, ?, ?, 'admin', '{}', '[]' WHERE EXISTS (SELECT 1 FROM tenants WHERE id = ? AND slug = ? AND plan = ?)",
          )
          .bind(userId, slot.id, admin.email, slot.id, slug, plan),
        control
          .prepare(
            "INSERT INTO usage_credits (id, tenant_id, period, metered, stripe_refs) " +
              "SELECT ?, ?, ?, '{}', '{}' WHERE EXISTS (SELECT 1 FROM tenants WHERE id = ? AND slug = ? AND plan = ?)",
          )
          .bind(creditsId, slot.id, billingPeriod, slot.id, slug, plan),
      ]);
    } catch (e) {
      // The batch rolled back atomically (the flip is undone) — no half-claimed slot. Surface it fail-closed.
      throw new ProvisionError("PROVISION_FAILED", `atomic claim failed and rolled back: ${(e as Error).message}`);
    }

    const claimed = (results[0]?.meta.changes ?? 0) === 1;
    if (claimed) {
      return { tenant_id: slot.id, slug, plan, pool_binding: poolBinding, db: env[poolBinding] };
    }
    // lost the CAS for this slot → try the next unclaimed one
  }

  throw new ProvisionError("POOL_EXHAUSTED", "no unclaimed pool slot available — pre-provision more out-of-band (R4 ops)");
}

/**
 * Server-side-only resolution of a CLAIMED customer slug → its pool D1. This is the analogue of tenantDb for
 * dynamically-provisioned tenants: it consults the control plane (never client input beyond the slug) and
 * returns the binding named by policy.pool_binding, constrained to the static POOL_BINDINGS allowlist. It is
 * NOT wired into the live request path in WP-14 (provisioning is DARK); it exists so a claim is provably
 * bindable, and it is where R4 will hang the self-serve tenant resolver. The platform id can never resolve here.
 */
export async function resolveClaimedTenantDb(env: Env, slug: string): Promise<D1Database> {
  assertNotPlatformTenant(slug);
  const row = await env.CONTROL_DB
    .prepare("SELECT policy FROM tenants WHERE slug = ? AND plan NOT IN ('unclaimed','platform')")
    .bind(slug)
    .first<{ policy: string }>();
  if (!row) throw new ProvisionError("NOT_CLAIMED", `no claimed pool tenant for slug "${slug}"`);
  const poolBinding = (JSON.parse(row.policy) as { pool_binding?: string }).pool_binding;
  if (!poolBinding || !isPoolBinding(poolBinding)) {
    throw new ProvisionError("PROVISION_FAILED", `claimed tenant "${slug}" has no valid pool_binding`);
  }
  return env[poolBinding];
}
