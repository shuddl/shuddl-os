// WP-14 Task 8 (REQ-122/125) — THE SPARK CONVENIENCE CAP, resolved at the composition root, enforced at the
// agent-action chokepoint (concierge.ts). The plan-flag gate + the SparkMeter DO wiring live here; the consumer
// merely consumes the injected `SparkGate` port (mirrors evidenceSender/conciergeParser selection).
//
// ── THE INVERSION (the headline) ──────────────────────────────────────────────────────────────────────────
// This cap fails CLOSED on the CONVENIENCE seam ONLY. A `tenants.plan='spark'` tenant over its monthly AI-credit
// allotment loses the LLM-powered agent action (Concierge auto-quote); it NEVER loses the physical-truth append
// path or invoicing. The gate is wired into the Concierge consumer alone — the sequencer append + the Biller
// invoice construct NO gate, so an over-cap tenant STILL records stop/pod/delivery/custody + STILL invoices.
// "Credits throttle conveniences, not truth" (genesis/04:15).
//
// ── PLAN-FLAG GATED, FAIL-CLOSED ON THE ALLOTMENT ─────────────────────────────────────────────────────────
// A tenant is metered IFF `tenants.plan === 'spark'` (a NON-Spark tenant is UNCAPPED — the gate no-ops). The
// monthly allotment is read from `tenants.policy` (no new table/column) under `spark_ai_allotment`; ABSENT or
// MALFORMED ⇒ ZERO (an unprovisioned Spark tenant is at its floor, never infinite). The plan/allotment come from
// the SERVER control plane keyed on the SERVER-resolved tenant slug — never a client field.
import type { SparkReserveRequest, SparkReserveResult } from "./spark-meter.js";
import type { AgentsEnv } from "./tenants.js";

/** The metered tier. Any other plan (pilot/pro/scale/platform/…) is UNCAPPED. */
export const SPARK_PLAN = "spark";

/** The `tenants.policy` key carrying a Spark tenant's monthly AI-action allotment (an integer count). Reused
 *  from the existing policy JSON — NO new table/column (the DO adds none either). */
export const SPARK_ALLOTMENT_POLICY_KEY = "spark_ai_allotment";

/** The metering period: the UTC calendar month, "YYYY-MM". Mirrors workers/mcp/src/caps.ts `currentPeriod` and
 *  workers/billing/src/metering.ts `periodOf` — one deterministic window off the worker clock. */
export function currentPeriod(now: number): string {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** The resolved plan posture for a tenant. `capped:false` ⇒ UNCAPPED (not a Spark tenant). */
export interface SparkPlan {
  /** true ⇒ this tenant's agent conveniences are metered (a Spark tenant). false ⇒ UNCAPPED (any other plan). */
  capped: boolean;
  /** The monthly agent-action allotment (integer count). ZERO when unconfigured/malformed — never infinite. */
  allotment: number;
}

/**
 * Resolve a tenant's Spark posture from the control plane (keyed by the tenant SLUG — the queue trigger's
 * `tenant`, mapped to `tenants.slug`). Only `plan === 'spark'` is capped; ANY other plan — or a MISSING control
 * row (an unknown tenant is not a CONFIRMED Spark tenant) — is UNCAPPED. For a Spark tenant, the allotment comes
 * from `tenants.policy.spark_ai_allotment`; an absent key, a non-integer/negative value, or unparseable policy
 * JSON ⇒ ZERO (the fail-closed floor). A storage fault THROWS — the caller redelivers the CONVENIENCE message
 * (truth is never on this path), never silently allows an un-metered convenience.
 */
export async function resolveSparkPlan(controlDb: D1Database, tenantSlug: string): Promise<SparkPlan> {
  const row = await controlDb
    .prepare("SELECT plan, policy FROM tenants WHERE slug = ?")
    .bind(tenantSlug)
    .first<{ plan: string; policy: string }>();
  if (row === null || row.plan !== SPARK_PLAN) return { capped: false, allotment: 0 };

  let allotment = 0;
  try {
    const policy = JSON.parse(row.policy) as Record<string, unknown>;
    const v = policy[SPARK_ALLOTMENT_POLICY_KEY];
    if (typeof v === "number" && Number.isInteger(v) && v >= 0) allotment = v;
  } catch {
    // Malformed policy JSON ⇒ ZERO (fail-closed floor). A provisioned Spark tenant's policy is well-formed;
    // a corrupt one throttles conveniences rather than silently uncapping them.
  }
  return { capped: true, allotment };
}

/** The DO stub surface (the generic DurableObjectStub RPC mapper is bound to a hand-written surface, as the
 *  mcp caps.ts + api sequencer call sites do — the runtime is unchanged; this is purely the call-site type). */
type SparkMeterStub = DurableObjectStub & {
  checkAndReserve(req: SparkReserveRequest): Promise<SparkReserveResult>;
};

/** The outcome of reserving ONE agent convenience. `ok:false` carries the count/allotment for the refusal note. */
export type SparkReserveOutcome =
  | { ok: true }
  | { ok: false; reason: "over_allotment"; count: number; allotment: number };

/**
 * THE PORT the agent-convenience consumer consumes. `reserve(actionId)` atomically reserves ONE convenience for
 * this tenant. A NON-Spark tenant's gate always returns `{ok:true}` (the check no-ops). A Spark tenant over its
 * allotment returns `{ok:false}` — the convenience is throttled. Keyed off the SERVER tenant (the factory bakes
 * the tenant into the DO name), so a client field can never lift the cap.
 */
export interface SparkGate {
  reserve(actionId: string): Promise<SparkReserveOutcome>;
}

/** The UNCAPPED gate — a non-Spark tenant (or a harness with no plan wired). The check no-ops. */
export const UNCAPPED_SPARK_GATE: SparkGate = { reserve: async () => ({ ok: true }) };

/**
 * Build the per-tenant SparkGate at the composition root. Resolves the plan (control plane) ONCE; a non-Spark
 * tenant gets the UNCAPPED no-op gate (never a DO touch). A Spark tenant gets a gate that reserves against the
 * per-tenant SparkMeter DO (`idFromName(tenant)`) under this month's period + the tenant's allotment. A DO
 * storage fault propagates out of `reserve` — the consumer's caller redelivers the CONVENIENCE (never fails open
 * past the cap; the convenience only runs after a successful `{ok:true}`).
 *
 * Constructed ONLY on the agent-convenience path (queue()'s message.received branch). The Biller (pod.signed)
 * and Booking (quote.accepted) branches build NO gate — the truth-path carve-out is STRUCTURAL.
 */
export async function sparkGateFor(env: AgentsEnv, tenant: string, now: () => number = () => Date.now()): Promise<SparkGate> {
  const plan = await resolveSparkPlan(env.CONTROL_DB, tenant);
  if (!plan.capped) return UNCAPPED_SPARK_GATE;
  const period = currentPeriod(now());
  return {
    reserve: async (actionId: string) => {
      const stub = env.SPARK_METER.get(env.SPARK_METER.idFromName(tenant)) as unknown as SparkMeterStub;
      const res = await stub.checkAndReserve({ period, allotment: plan.allotment, actionId });
      return res.ok ? { ok: true } : { ok: false, reason: "over_allotment", count: res.count, allotment: res.allotment };
    },
  };
}
