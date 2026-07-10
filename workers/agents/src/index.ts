// REQ-014 / REQ-039. This worker owns the daily Merkle -> TSA anchor cron. LLM calls live here and in
// packages/agents — never in the ledger (REQ-024). Queue consumers (one module per agent) arrive at
// WP-06+; today the only scheduled job is anchoring every tenant's just-closed day.

import { runDailyAnchor } from "@shuddl/ledger/anchor";
import { FakeTsaClient, HttpTsaClient, UnavailableTsaClient, type TsaClient } from "@shuddl/ledger/tsa/client";
import { TENANT_SLUGS, tenantDb, type AgentsEnv } from "./tenants.js";

// Prod resolves a real RFC-3161 endpoint from the `integrations` row; a missing config yields an
// Unavailable client so the anchor leaves the day unanchored + escalates (never a fake in prod).
// Dev/CI use the deterministic fake so the whole flow runs offline.
async function tsaFor(env: AgentsEnv, db: D1Database): Promise<TsaClient> {
  if (env.ENVIRONMENT !== "prod") return new FakeTsaClient();
  const row = await db.prepare("SELECT config FROM integrations WHERE kind = 'tsa' LIMIT 1").first<{ config: string }>();
  if (!row) return new UnavailableTsaClient("TSA_UNCONFIGURED");
  const cfg = JSON.parse(row.config) as { url?: string };
  return cfg.url ? new HttpTsaClient({ url: cfg.url }) : new UnavailableTsaClient("TSA_URL_MISSING");
}

// Anchor every allowlisted tenant. Exported so the cron test and a manual backfill both drive the
// identical path. A per-tenant failure is contained — one tenant's TSA outage never stalls the rest.
export async function runAllTenants(env: AgentsEnv, now: () => Date = () => new Date()): Promise<void> {
  for (const slug of TENANT_SLUGS) {
    const db = tenantDb(env, slug);
    const tsa = await tsaFor(env, db);
    await runDailyAnchor({ db, r2: env.EVIDENCE, tsa, tenant: slug, now });
  }
}

export default {
  // 01:00 UTC daily (a grace window past midnight so the just-closed day can no longer grow). The
  // clock is the cron's own scheduledTime — "yesterday" is relative to when the trigger fired, so a
  // delayed/retried invocation still anchors the correct just-closed day (and tests are deterministic).
  async scheduled(controller: ScheduledController, env: AgentsEnv, ctx: ExecutionContext): Promise<void> {
    void ctx;
    await runAllTenants(env, () => new Date(controller.scheduledTime));
  },
  // REQ-039: queue consumers (one module per agent) land WP-06+.
  async queue(): Promise<void> {
    /* agents arrive WP-06+ */
  },
};
