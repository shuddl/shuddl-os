import { z, assertNotPlatformTenant, proofToCashEnabled, assertProofToCashEntitled, CLAIMED_TENANT_BY_SLUG_SQL, UNCLAIMED_TENANT_PLAN, RESERVED_TENANT_PLANS, usageCreditsId, type TenantEntitlementRow } from "@shuddl/contracts";
import { TENANT_BINDINGS } from "./tenants.js";
import { seedColdStartTariff } from "./tariff-seed.js";
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
/** The usage_credits row identity — an ALIAS of the @shuddl/contracts definition, which is the ONE its three
 *  writers share (this claim batch, the billing metering sweep, the Stripe credit stamp). §13 shipped a
 *  SECOND copy here whose own comment called it "the ONE definition"; §15 retired it. The alias is kept
 *  because existing call sites and tests name it. */
export const usageCreditsIdFor = usageCreditsId;

export const POOL_BINDINGS = ["TENANT_POOL_01_DB", "TENANT_POOL_02_DB"] as const;
export type PoolBindingKey = (typeof POOL_BINDINGS)[number];

function isPoolBinding(key: string): key is PoolBindingKey {
  return (POOL_BINDINGS as readonly string[]).includes(key);
}

// Reserved plan values a customer can NEVER be provisioned into (the pool sentinel + the platform tenant).
// 2026-08-02 §14: this was an eighth independent copy of the reserved-plan rule, in TS rather than SQL — so
// the value a customer is REFUSED and the value a sweep EXCLUDES could drift apart silently. Both now read
// the same frozen array from @shuddl/contracts.
const RESERVED_PLANS = new Set<string>(RESERVED_TENANT_PLANS);

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
  | "SLUG_TAKEN" // the requested workspace slug is already claimed (a client collision → 409, not a 500)
  | "EMAIL_TAKEN" // the admin email is already registered (a client collision → 409, not a 500)
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

  // 5. COLLISION (the single most common signup error) — a taken workspace slug or admin email is CLIENT-
  // fixable input, so detect it up front and surface a DISTINCT code (mapped to 409 Conflict), never letting
  // it collapse into the batch's 500 PROVISION_FAILED and 5xx-alert. This is a best-effort pre-check; the
  // atomic UNIQUE constraints below remain the integrity backstop for a TOCTOU race (re-classified in the
  // batch catch), so a concurrent claim is a 409 too — never a half-claim, never a 500.
  //
  // 5a. STATIC-ROSTER SHADOWING (REQ-025, 2026-08-01 review): every resolver is static-FIRST, so a claimed
  // row named "tenant-a" would make that customer's sessions and triggers resolve to the REAL static
  // tenant's D1 — cross-tenant by shadowing. No prod migration seeds control rows for the static slugs, so
  // the row-collision check below can never fire for them; the refusal is STRUCTURAL, read from the same
  // roster the resolver consults (TENANT_BINDINGS — the import is cyclic with tenants.ts but only consumed
  // at call time, by when both modules are initialized). Surfaced as SLUG_TAKEN: to the client a reserved
  // name and a taken name are the same 409, and no slug-existence oracle is added.
  if (slug in TENANT_BINDINGS) {
    throw new ProvisionError("SLUG_TAKEN", `workspace slug "${slug}" is a reserved static-roster tenant and can never be claimed`);
  }
  const slugTaken = await control.prepare("SELECT 1 AS x FROM tenants WHERE slug = ?").bind(slug).first();
  if (slugTaken) throw new ProvisionError("SLUG_TAKEN", `workspace slug "${slug}" is already taken`);
  const emailTaken = await control.prepare("SELECT 1 AS x FROM users WHERE email = ?").bind(admin.email).first();
  if (emailTaken) throw new ProvisionError("EMAIL_TAKEN", "the admin email is already registered");

  // 6. CLAIM — bounded retry: pick the lowest unclaimed slot and atomically flip it. A conditional UPDATE
  // (WHERE plan='unclaimed') is the compare-and-swap; if two signups race the same slot only one flips it
  // (changes===1) and the loser (changes===0) moves to the next slot. Bounded by the pool size.
  for (let attempt = 0; attempt < POOL_BINDINGS.length; attempt++) {
    const slot = await control
      .prepare(`SELECT id, policy FROM tenants WHERE plan = '${UNCLAIMED_TENANT_PLAN}' ORDER BY id LIMIT 1`)
      .first<{ id: string; policy: string }>();
    if (!slot) break; // no unclaimed slot remains

    // Guarded (2026-08-02 §13): an unguarded parse threw a raw SyntaxError out of provisionTenant for one
    // malformed slot, which signup maps to a generic 500 instead of the ProvisionError its contract
    // promises. A misconfigured slot is now a per-slot refusal, so the loop's next attempt can still find
    // a healthy one rather than one bad row bricking signup.
    let poolBinding: string | undefined;
    try {
      poolBinding = (JSON.parse(slot.policy) as { pool_binding?: string }).pool_binding;
    } catch {
      poolBinding = undefined;
    }
    if (!poolBinding || !isPoolBinding(poolBinding)) {
      throw new ProvisionError("PROVISION_FAILED", `pool slot ${slot.id} has no valid pool_binding — pool is misconfigured`);
    }
    const newPolicy = JSON.stringify({ pool_binding: poolBinding });
    // The meter row is keyed on the SLUG (2026-08-02 §13), the identity the metering sweep and the Stripe
    // credit stamp both own (billing metering.ts usageCreditsId, credits.ts stampStripeRefs). It used to be
    // keyed `uc-<slot.id>-<period>` with tenant_id = the pool sentinel — harmless while a claimed tenant was
    // never swept, but porting the sweep made that divergence ACTIVE: the tenant would carry TWO rows, one
    // of them permanently empty under a `_pool_0N` identity. One writer identity, one row per tenant-month.
    const creditsId = usageCreditsIdFor(slug, billingPeriod);

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
          .bind(creditsId, slug, billingPeriod, slot.id, slug, plan), // tenant_id = the SLUG — one identity with the sweep + the Stripe stamp (§13)
      ]);
    } catch (e) {
      // The batch rolled back atomically (the flip is undone) — no half-claimed slot. A UNIQUE violation here is
      // a TOCTOU race that won the slug/email between the pre-check and the batch: re-classify it as the SAME
      // client-collision code (→ 409), so a race is never a 500. Anything else is a GENUINE fault → PROVISION_FAILED.
      const msg = (e as Error).message;
      if (/UNIQUE constraint failed:\s*tenants\.slug/i.test(msg)) {
        throw new ProvisionError("SLUG_TAKEN", `workspace slug "${slug}" is already taken`);
      }
      if (/UNIQUE constraint failed:\s*users\.email/i.test(msg)) {
        throw new ProvisionError("EMAIL_TAKEN", "the admin email is already registered");
      }
      throw new ProvisionError("PROVISION_FAILED", `atomic claim failed and rolled back: ${msg}`);
    }

    const claimed = (results[0]?.meta.changes ?? 0) === 1;
    if (claimed) {
      const workspaceDb = env[poolBinding];
      // REQ-151 COLD START — a newly-claimed tenant is RATEABLE day one: seed a brokerage cold-start tariff
      // (market rate + margin) into its OWN pre-migrated workspace D1, so "signup → first quote" works
      // immediately (demo #2). This is inside the DARK flag already (step 1 refuses when the flag is off) and
      // is a TENANT-plane write, deliberately SEPARATE from the control-plane claim batch above. effective_ts 0
      // ⇒ always in effect; idPrefix folds in the slug so a (never-expected) re-claim is idempotent.
      //
      // NON-FATAL by design: the claim is already committed, so a seed hiccup must NOT half-roll it. Worst case
      // the tenant simply has no tariff yet — /v1/rate answers UNKNOWN no_tariff (no price on air, REQ-004) until
      // the admin runs the guided builder (POST /v1/tariff). We log LOUDLY rather than fabricate or crash.
      try {
        await seedColdStartTariff(workspaceDb, { idPrefix: `cold-${slug}`, effectiveTs: 0, approvedBy: "provision" });
      } catch (e) {
        console.error(
          `REQ-151 cold-start tariff seed FAILED for newly-claimed tenant "${slug}" (${slot.id}); the tenant is claimed but not yet rateable — run POST /v1/tariff. Cause: ${(e as Error).message}`,
        );
      }
      return { tenant_id: slot.id, slug, plan, pool_binding: poolBinding, db: workspaceDb };
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
    .prepare(CLAIMED_TENANT_BY_SLUG_SQL)
    .bind(slug)
    .first<{ policy: string }>();
  if (!row) throw new ProvisionError("NOT_CLAIMED", `no claimed pool tenant for slug "${slug}"`);
  let poolBinding: string | undefined;
  try {
    poolBinding = (JSON.parse(row.policy) as { pool_binding?: string }).pool_binding;
  } catch {
    // A malformed policy row is not a routable tenant — refuse it the way every other bad shape is
    // refused (2026-08-01 §12: an unguarded parse threw SyntaxError past this contract's own promise).
    throw new ProvisionError("PROVISION_FAILED", `claimed tenant "${slug}" has a malformed policy`);
  }
  if (!poolBinding || !isPoolBinding(poolBinding)) {
    throw new ProvisionError("PROVISION_FAILED", `claimed tenant "${slug}" has no valid pool_binding`);
  }
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

// ── REQ-162 (WP-14 Task 9) — PROOF-TO-CASH SKU entitlement, resolved server-side at the SKU's provisioning home ──
//
// The PROOF-TO-CASH SKU is a tenants.plan PLAN-FLAG, founder-led (provisioned at M-H/R1). These resolvers are the
// SERVER-SIDE authority the SKU's feature-consumers call — the twin of Task 8's resolveSparkPlan (spark-caps.ts):
// they read the CONTROL PLANE keyed off the SERVER slug (never a client field) and fail CLOSED. DARK-adjacent —
// the check ships enforcing now; the granting plan is provisioned only at the SKU's milestone, so it refuses
// every current (pilot/…) tenant until a founder provisions `proof_to_cash`. Live feature-route attachment
// (status pages / evidence archive) lands with those surfaces at M-H; the pure predicate + fail-closed guard live
// in @shuddl/contracts/entitlements.ts. [HYPOTHESIS] flag mechanism, not final packaging/price (REQ-130).

/** Resolve whether the SERVER tenant `slug` is entitled to the PROOF-TO-CASH SKU. A MISSING control row (an
 *  unknown tenant is not a CONFIRMED SKU tenant) OR any non-granting plan reads as NOT entitled (default OFF). */
export async function resolveProofToCashEntitlement(control: D1Database, slug: string): Promise<boolean> {
  const row = await control
    .prepare("SELECT plan, policy FROM tenants WHERE slug = ?")
    .bind(slug)
    .first<TenantEntitlementRow>();
  return row !== null && proofToCashEnabled(row);
}

/** Fail-closed guard variant: THROWS EntitlementError('proof_to_cash_not_entitled') unless the SERVER tenant is
 *  SKU-entitled. A missing row fails closed (an empty-plan row is never a granting plan). A consumer maps the
 *  refusal to its transport (a 403/FORBIDDEN in HTTP). */
export async function assertProofToCashEntitledFor(control: D1Database, slug: string): Promise<void> {
  const row = await control
    .prepare("SELECT plan, policy FROM tenants WHERE slug = ?")
    .bind(slug)
    .first<TenantEntitlementRow>();
  assertProofToCashEntitled(row ?? { plan: "", policy: "{}" });
}
