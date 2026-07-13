// REQ-014 / REQ-039. This worker owns the daily Merkle -> TSA anchor cron AND the agent queue
// consumers (WP-06: the Biller — src/biller.ts). LLM calls live here and in packages/agents — never
// in the ledger (REQ-024); the Biller itself is deterministic and LLM-free.

import { runDailyAnchor } from "@shuddl/ledger/anchor";
import { FakeTsaClient, HttpTsaClient, UnavailableTsaClient, type TsaClient } from "@shuddl/ledger/tsa/client";
import { NotConfiguredSender, ResendSender, SendError } from "@shuddl/agents";
import type { EvidenceSender } from "@shuddl/agents";
import { PodSignedMessage, handlePodSigned, type BillerDeps, type SeqStubLike } from "./biller.js";
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

// The composition root reads the send config (REQ-092/157) — the adapter NEVER reads env. Live email
// is a CONFIRM-gated config flip: BOTH halves present (`wrangler secret` RESEND_API_KEY + a verified
// EVIDENCE_FROM) ⇒ ResendSender; anything less ⇒ NotConfiguredSender, which rejects LOUDLY (retriable)
// so an unconfigured environment can never silently swallow evidence sends.
function evidenceSender(env: AgentsEnv): EvidenceSender {
  const apiKey = env.RESEND_API_KEY;
  const from = env.EVIDENCE_FROM;
  if (apiKey !== undefined && apiKey !== "" && from !== undefined && from !== "") {
    return new ResendSender({ apiKey, from });
  }
  return new NotConfiguredSender();
}

// Route each append to the (tenant|stream) sequencer DO — the same id derivation the api routes use,
// so the DO's identity re-derivation (REQ-025) accepts it. Bound to the hand-written SeqStubLike
// surface for the same TS reason events.ts binds SeqStub (the recursive event union explodes the
// generic RPC mapper).
function sequencerFor(env: AgentsEnv): SeqStubLike {
  return {
    append: (req) =>
      (env.SHIPMENT_SEQ.get(env.SHIPMENT_SEQ.idFromName(`${req.tenant}|${req.streamId}`)) as unknown as SeqStubLike).append(req),
  };
}

// REQ-129 — the owner-fixed referral base; the wrangler var overrides per environment.
const DEFAULT_REFERRAL_BASE = "https://shuddl.tech";

// Backoff for provider rate-limiting (429): long enough to clear a per-second/minute limiter window,
// short enough to keep the <5s golden path the COMMON case (this only ever delays the retry of a
// send that already failed).
const RATE_LIMIT_RETRY_DELAY_S = 30;

export default {
  // 01:00 UTC daily (a grace window past midnight so the just-closed day can no longer grow). The
  // clock is the cron's own scheduledTime — "yesterday" is relative to when the trigger fired, so a
  // delayed/retried invocation still anchors the correct just-closed day (and tests are deterministic).
  async scheduled(controller: ScheduledController, env: AgentsEnv, ctx: ExecutionContext): Promise<void> {
    void ctx;
    await runAllTenants(env, () => new Date(controller.scheduledTime));
  },
  // REQ-159 (GTM — milestone gate, NOT a code deliverable): this consumer is the M-H substrate. The
  // "heartbeat on real freight" that M-H exits on IS this path firing — pod.signed → invoice.issued →
  // evidence send — on a live tenant-0 shipment. The MECHANISM ships in this WP; the GTM unlock it
  // gates (R1 external selling) is a MILESTONE decision the owner makes at M-H exit per genesis/12 §01,
  // never something code turns on. External selling never precedes this heartbeat on real freight; there
  // is deliberately no in-repo flag that flips it — the gate is the milestone, evidenced by the M-H demo.
  //
  // REQ-039 / WP-06: the Biller consumer. Per-message ack/retry — one poison message never stalls the
  // batch. POISON (unparseable body, unknown tenant) is ACKed with a loud log: redelivery cannot fix
  // it, and retrying it forever would only delay real work (the DLQ + exceptions surface land WP-11).
  // A THROWN handler failure (retriable send, transient D1/DO fault) retries the MESSAGE — safe end to
  // end because the Biller's append id and email idempotency key are deterministic (dedupe both sides).
  async queue(batch: MessageBatch, env: AgentsEnv, ctx: ExecutionContext): Promise<void> {
    void ctx;
    for (const message of batch.messages) {
      const parsed = PodSignedMessage.safeParse(message.body);
      if (!parsed.success) {
        console.error(`agents queue: unparseable message ${message.id} — ack as poison: ${parsed.error.message}`);
        message.ack();
        continue;
      }
      let db: D1Database;
      try {
        db = tenantDb(env, parsed.data.tenant); // REQ-025 — the allowlist is the only tenant→D1 map
      } catch (err) {
        console.error(`agents queue: message ${message.id} names an unknown tenant — ack as poison:`, err);
        message.ack();
        continue;
      }
      const deps: BillerDeps = {
        db,
        seq: sequencerFor(env),
        sender: evidenceSender(env),
        referralBase: env.REFERRAL_BASE ?? DEFAULT_REFERRAL_BASE,
      };
      try {
        const outcome = await handlePodSigned(parsed.data, deps);
        // The outcome IS the log line until WP-11's exceptions queue lands (holds surface there).
        console.log(`biller: pod ${parsed.data.event_id} → ${JSON.stringify(outcome)}`);
        message.ack();
      } catch (err) {
        console.error(`biller: retriable failure for pod ${parsed.data.event_id} — message will redeliver:`, err);
        // A 429 from the send provider means we're being throttled: immediate redelivery would just
        // re-trip the limiter, so back the retry off. SendError.status is threaded exactly for this.
        if (err instanceof SendError && err.retriable && err.status === 429) {
          message.retry({ delaySeconds: RATE_LIMIT_RETRY_DELAY_S });
        } else {
          message.retry();
        }
      }
    }
  },
};
