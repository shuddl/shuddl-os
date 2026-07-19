// Tenant allowlist for the anchor cron. This is a MIRROR of workers/api/src/tenants.ts — if the two
// drift, a tenant silently stops being anchored (its daily Merkle root never gets a TSA receipt). A
// parity unit test (test/tenants-parity.test.ts) asserts the slug sets match, so drift fails CI.

export type AgentsEnv = {
  TENANT_A_DB: D1Database;
  TENANT_B_DB: D1Database;
  EVIDENCE: R2Bucket;
  /** The api worker's sequencer DO (cross-script binding) — the Biller's ONLY write path (I2 + money projection run there). */
  SHIPMENT_SEQ: DurableObjectNamespace;
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
