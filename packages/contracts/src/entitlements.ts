import { z } from "zod";

// WP-14 Task 9 (REQ-060/162) — PURE, server-side ENTITLEMENT helpers over the two control-plane levers
// tenants.plan / tenants.policy (db/control 0001_control.sql:5-6) — levers no code read until this task. NO I/O:
// the caller reads the control row (mirroring resolveSparkPlan in workers/agents/src/spark-caps.ts) and passes
// it here. Both helpers fail CLOSED (default OFF): an ABSENT or MALFORMED signal grants NOTHING, so an
// unprovisioned or corrupt row can never silently unlock a regulated flow. Each helper is a pure function of the
// PASSED row, so an entitlement is scoped to its OWN control-plane row — one tenant can never inherit another's.
//
// [HYPOTHESIS] (REQ-130): the flag MECHANISM, not final packaging or pricing. Do not treat PROOF_TO_CASH_PLAN as
// a frozen tier name or read any tier price/limit off these constants — those re-base on tenant-#0 telemetry.

/**
 * The control-plane tenant-row slice these helpers read. `plan` is tenants.plan (text); `policy` is
 * tenants.policy as the RAW JSON string EXACTLY as stored — this module parses it, mirroring resolveSparkPlan's
 * `row.policy` read. Reading the raw string (not a pre-parsed object) keeps the fail-closed parse in ONE place.
 */
export interface TenantEntitlementRow {
  plan: string;
  policy: string;
}

// ── HAZMAT (REQ-060) — a per-tenant WORKSPACE-enablement flag carried in tenants.policy. Default OFF. ──────
/** The tenants.policy key carrying a tenant's hazmat workspace enablement. Exported so the SERVER-SIDE booking
 *  gate (sequencer #enforceBooking) reads the SAME key this module validates — one wire name, no drift. */
export const HAZMAT_ENABLED_POLICY_KEY = "hazmat_enabled";

/** The typed slice of tenants.policy this module reads. `.passthrough()` — policy carries many unrelated concerns
 *  (gates / visibility / pool_binding / spark_ai_allotment); only the entitlement flag is typed here. The flag
 *  grants ONLY on a literal boolean `true` — a string "true", a 1, or an absent key all read as OFF (fail-closed). */
const EntitlementPolicy = z
  .object({ [HAZMAT_ENABLED_POLICY_KEY]: z.boolean().optional() })
  .passthrough();

/** Parse the raw policy JSON defensively: unparseable OR non-object ⇒ {} (the fail-closed floor — an
 *  unprovisioned or corrupt policy grants NOTHING). Mirrors resolveSparkPlan's try/catch-to-floor discipline. */
function readEntitlementPolicy(policyJson: string): z.infer<typeof EntitlementPolicy> {
  try {
    return EntitlementPolicy.parse(JSON.parse(policyJson));
  } catch {
    return {};
  }
}

/** REQ-060 — is HAZMAT booking enabled for this tenant? TRUE only when the control-plane policy carries
 *  `hazmat_enabled: true`. Default OFF / fail-closed. Excluded from the Spark default (a Spark tenant's policy
 *  carries no hazmat_enabled), so a Spark tenant is hazmat-OFF unless its workspace is explicitly enabled. */
export function hazmatEnabled(row: TenantEntitlementRow): boolean {
  return readEntitlementPolicy(row.policy)[HAZMAT_ENABLED_POLICY_KEY] === true;
}

// ── PROOF-TO-CASH SKU (REQ-162) — a tenants.plan PLAN-FLAG, founder-led (provisioned at M-H/R1). Default OFF. ──
/** The standalone PROOF-TO-CASH SKU plan slug (mirrors SPARK_PLAN in spark-caps.ts). [HYPOTHESIS] — the flag
 *  MECHANISM, not a frozen tier name/price (REQ-130). */
export const PROOF_TO_CASH_PLAN = "proof_to_cash";

/** The set of plans that GRANT the PROOF-TO-CASH SKU. A SET so a full-OS plan that BUNDLES the SKU joins it when
 *  that plan taxonomy is defined (post-WP-14); today only the standalone SKU slug grants. Keeping it a set means
 *  the gate never needs a brittle plan-string cascade at the call site. */
export const PROOF_TO_CASH_GRANTING_PLANS: ReadonlySet<string> = new Set([PROOF_TO_CASH_PLAN]);

/** REQ-162 — is this tenant entitled to the PROOF-TO-CASH SKU? TRUE only when tenants.plan is a granting plan.
 *  Default OFF / fail-closed (any other plan — incl. reserved `unclaimed`/`platform`, an unprovisioned empty
 *  plan, or an unknown value — is NOT entitled). Reads ONLY plan: the SKU is a plan-flag, never grantable via a
 *  policy field, so a spoofed policy can never lift it. */
export function proofToCashEnabled(row: TenantEntitlementRow): boolean {
  return PROOF_TO_CASH_GRANTING_PLANS.has(row.plan);
}

// ── Fail-closed guards — a consumer calls these BEFORE a gated capability; they THROW a typed refusal. ────────
export type EntitlementCode = "hazmat_not_enabled" | "proof_to_cash_not_entitled";

/** A typed entitlement refusal. `code` is a stable machine token a caller maps to its transport (in an HTTP
 *  context an entitlement miss is a 403/FORBIDDEN authorization refusal — NOT malformed input). A distinct
 *  Error subtype so a consumer tells a policy refusal apart from an internal/transport error. */
export class EntitlementError extends Error {
  constructor(
    readonly code: EntitlementCode,
    message: string,
  ) {
    super(message);
    this.name = "EntitlementError";
  }
}

/** REQ-060 — THROW EntitlementError('hazmat_not_enabled') unless HAZMAT is enabled for this tenant (fail-closed). */
export function assertHazmatEnabled(row: TenantEntitlementRow): void {
  if (!hazmatEnabled(row)) {
    throw new EntitlementError("hazmat_not_enabled", "hazmat booking requires per-tenant workspace enablement (REQ-060)");
  }
}

/** REQ-162 — THROW EntitlementError('proof_to_cash_not_entitled') unless this tenant is SKU-entitled (fail-closed). */
export function assertProofToCashEntitled(row: TenantEntitlementRow): void {
  if (!proofToCashEnabled(row)) {
    throw new EntitlementError("proof_to_cash_not_entitled", "the PROOF-TO-CASH SKU requires a granting plan (REQ-162)");
  }
}
