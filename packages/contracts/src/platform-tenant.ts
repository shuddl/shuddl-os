import { z } from "zod";
import { Visibility } from "./events.js";
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

// ---- Is a tenant's control-plane policy USABLE? (2026-08-02 §19 — REQ-030/025/180) ---------------------
//
// `tenants.policy` is D1 `TEXT NOT NULL DEFAULT '{}'` — NOT NULL, but never constrained to valid JSON. The
// sequencer REFUSES every append for a tenant whose policy is unusable, because proceeding on `{}` is not a
// floor: it drops `gates.dims_required`, widens `gates.geofence_radius_m` to the 150m default, and drops
// every narrowing visibility override — and visibility is stamped onto an APPEND-ONLY event, so that last
// one is irreversible.
//
// The refusal has a second consumer. The EDI translator must decide, BEFORE it writes anything, whether a
// tender can be appended at all: if it discovers the refusal only when the append throws, the 500 becomes a
// partner retry-storm against a DETERMINISTIC condition, while parties/shipments/tender-markers accumulate
// with no ledger behind them — which is exactly the harm its own quarantine law forbids.
//
// So the predicate lives HERE, once, and both callers read it. A duplicated copy is how the sequencer and
// the translator would come to disagree about which tenants may append (the seven-copies-of-one-rule shape
// §14 closed). Returns the parsed policy, or null when the tenant cannot safely append.
//
// ── DO NOT "UNIFY" THE READERS OF tenants.policy — THEY DISAGREE ON PURPOSE (§25, corrected §30) ───────
//
// FOUR reader families, twelve call sites, four different failure directions. §25 said THREE and claimed
// "enumerated and verified"; it had missed the fourth and got a third one backwards. Both corrections are
// kept visible because this comment's whole job is to certify these directions, and a confident wrong
// certification is worse than none — the omitted reader is precisely where §29's HIGH turned up.
//
//   1. THIS one — `parseTenantPolicy` (gates + visibility): the sequencer + the EDI preflight.
//      → REFUSES an unusable policy. `{}` is the PERMISSIVE end for a gate bag (`dims_required` reads
//        false, the geofence widens to the 150m default, visibility falls to per-kind defaults), and the
//        visibility half is stamped irreversibly onto append-only events.
//
//   2. `readEntitlementPolicy` (entitlements.ts, hazmat) → FLOORS to `{}`.
//      → Correct: for a GRANT, `{}` grants nothing. Refusing would take a whole workspace down over a
//        hazmat flag.
//
//   3. `resolveSparkPlan` (agents/spark-caps.ts, the AI allotment) → TWO directions, and §25 named only
//      the safe one. A MALFORMED policy on a `spark`-plan row floors to zero (restrictive). But a MISSING
//      row — or any non-Spark plan — returns `{ capped: false, allotment: 0 }`, i.e. UNCAPPED: the fully
//      permissive answer. That is deliberate (an unknown tenant is not a confirmed Spark tenant, so there
//      is nothing to meter), but it is the OPPOSITE of what §25 wrote, on exactly the missing-row case
//      §18 exists for.
//
//   4. THE POOL-BINDING RESOLVER — the one §25 missed entirely. Eight call sites, all a bare
//      `JSON.parse(row.policy) as { pool_binding?: string }`: agents/translator/billing `tenants.ts`
//      (resolve + enumerate each) and api `provision.ts` (claim + resolve).
//      → A FOURTH direction, and it is split: on RESOLVE it throws `UNKNOWN_TENANT` (refuse-routing); on
//        ENUMERATE (`claimedTenantSlugs`) it SILENTLY SKIPS the tenant, dropping it from every cron sweep.
//      This is the most security-relevant read of the column — it decides which physical D1 a slug maps
//      to (REQ-025) — and it is the mis-keyed-cast shape the Zod schema here was added to close,
//      duplicated eight times. §29's HIGH (a claimed-pool tender 500ing the VAN) is a direct consequence:
//      the translator preflight was placed AFTER this reader because the enumeration did not include it.
//
// The differences are not sloppiness; they are the direction each default moves ITS consumer. A reader who
// pattern-matches without re-deriving that will unify these and silently break one: flooring here
// re-opens the §15 disclosure; refusing in the entitlement readers turns a missing flag into an outage.
// If you touch this, re-derive per consumer first; the reasoning is in the audit at §15a/§18/§25/§30.
// The SHAPE of the knobs that actually steer a gate. `.passthrough()` is deliberate — a tenant policy
// carries tenant-specific keys this package has no business enumerating (hazmat_enabled, pool_binding, …),
// and refusing those would break every tenant. What IS pinned is that the gate-bearing keys, WHEN PRESENT,
// have the type the readers assume: `policy.gates?.dims_required === true` reads `false` from a `gates`
// that is an array or a string, which is the permissive direction. A truncated ops paste rarely parses; a
// MIS-KEYED one always does, and the mis-keyed one is the likelier mistake.
// `.nullish()`, NOT `.optional()`, on every knob (2026-08-02 §27). Zod's `.optional()` admits `undefined`
// and REJECTS `null` — so `{"gates":null}` was refused, and a refusal here means the sequencer declines
// EVERY append for that tenant and the EDI preflight quarantines every tender. A total outage.
//
// `null` is not an exotic input: it is exactly what a YAML key with no value serializes to, and tenant #0's
// policy is generated from a config pack OUTSIDE this repo (genesis/13). Every consumer already treats it as
// absent — `policy.gates?.dims_required === true`, `?? DEFAULT_FENCE_RADIUS_M`, `?? []`,
// `policy?.[kind] ?? KIND_VISIBILITY_DEFAULTS[kind]` — so null can harm nothing and must not refuse. The
// cruellest case this fixes: a tenant that correctly set `dims_required: true` taken down because a SIBLING
// knob was null.
//
// The visibility VALUE is the shared `Visibility` union, not `z.string()`. The first cut typed only the key
// and let any string through, so a one-character typo (`"publc"`, `"Internal"`) passed this predicate AND
// the translator preflight, and then threw a raw ZodError out of `LedgerEvent.parse` inside the sequencer —
// a 500, not a named refusal, which is precisely the VAN retry-storm §19 exists to prevent, reached through
// the same corrupt-policy vector and with the projection orphans intact. Reusing the union means a new
// visibility rank can never leave this predicate behind.
const TenantPolicyShape = z
  .object({
    gates: z
      .object({
        dims_required: z.boolean().nullish(),
        geofence_radius_m: z.number().nullish(),
        invoice_without_pod_classes: z.array(z.string()).nullish(),
      })
      .passthrough()
      .nullish(),
    visibility: z.record(z.string(), Visibility).nullish(),
  })
  .passthrough();

/* NOT exported as a shared TYPE — considered and rejected (2026-08-02 §32).
 *
 * The predicate is shared (§19); the TYPE stays hand-written in its two consumers. Inferring it from this
 * schema was tried and reverted: `.nullish()` + `.passthrough()` infers keys as REQUIRED-with-undefined
 * (`gates: X | undefined`) rather than OPTIONAL (`gates?: X`), which `exactOptionalPropertyTypes: true`
 * rejects at every consumer. Closing that needs either transform gymnastics here — which make the schema
 * harder to read than the duplication removes — or loosening the gate signatures in packages/ledger, which
 * is the wrong direction on the file that decides whether an append is refused.
 *
 * So this is duplication kept ON PURPOSE, with the reason recorded, rather than a fragile dedup on a
 * security-critical path. The drift risk is bounded: the schema is the only thing that decides ACCEPTANCE,
 * and a consumer type that disagrees with it fails to compile against the parsed value.
 */

export function parseTenantPolicy(raw: string | null | undefined): Record<string, unknown> | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  // `typeof [] === "object"`, so Array.isArray is load-bearing: a JSON array behaves exactly like `{}` and
  // would widen silently. A first cut of this check omitted it and `[1,2]` appended 201.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  // Zod at the boundary (CLAUDE.md): the object check alone accepts `{"gates":[1,2]}` and a `{"gate":{…}}`
  // typo, both of which then produce EXACTLY the `{}` widening this predicate exists to refuse.
  return TenantPolicyShape.safeParse(parsed).success ? (parsed as Record<string, unknown>) : null;
}

/** WHY a policy was rejected, for the operator-facing log. A refusal takes the whole tenant down, so the log
 *  has to point at the row AND the key — "unparseable, null, an array, or a non-object" was accurate before
 *  the Zod shape landed and became misleading after it (§27 admits SHAPE rejections too, and the commonest
 *  is a mis-keyed paste on a row that parses fine). Key PATHS only: they carry no tenant data. */
export function describeTenantPolicyRejection(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "no control-plane row";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "policy is not valid JSON";
  }
  if (parsed === null) return "policy is JSON null";
  if (Array.isArray(parsed)) return "policy is a JSON array, not an object";
  if (typeof parsed !== "object") return `policy is a JSON ${typeof parsed}, not an object`;
  const r = TenantPolicyShape.safeParse(parsed);
  if (r.success) return "policy is usable";
  // §36 — `visibility` is `z.record(z.string(), Visibility)`, so EVERY key under it is arbitrary
  // tenant-supplied text that would otherwise become a path segment in an operator log. §33a claimed "key
  // paths only: they carry no tenant data" and that was false for exactly this branch — the pinning test
  // planted its sentinel under `gates.dims_required`, a FIXED-key branch where a leak was structurally
  // impossible, so it asserted the safe half and skipped the only unsafe one. Collapse the tenant-controlled
  // segment to a count: an operator learns WHICH knob is wrong without the log becoming a place tenant
  // config leaks to.
  const paths = [
    ...new Set(
      r.error.issues.map((i) => {
        const p0 = i.path[0];
        if (p0 === "visibility") return i.path.length > 1 ? "visibility.<kind>" : "visibility";
        return i.path.join(".") || "(root)";
      }),
    ),
  ];
  const visKeys = r.error.issues.filter((i) => i.path[0] === "visibility" && i.path.length > 1).length;
  const suffix = visKeys > 0 ? ` (${visKeys} visibility entr${visKeys === 1 ? "y" : "ies"})` : "";
  return `policy parses but these keys have the wrong shape: ${paths.join(", ")}${suffix}`;
}
