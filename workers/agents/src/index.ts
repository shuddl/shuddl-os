// REQ-014 / REQ-039. This worker owns the daily Merkle -> TSA anchor cron AND the agent queue
// consumers (WP-06: the Biller — src/biller.ts). LLM calls live here and in packages/agents — never
// in the ledger (REQ-024); the Biller itself is deterministic and LLM-free.

import { runDailyAnchor } from "@shuddl/ledger/anchor";
import { FakeTsaClient, HttpTsaClient, UnavailableTsaClient, type TsaClient } from "@shuddl/ledger/tsa/client";
import { NotConfiguredSender, ResendSender, SendError, renderEvidenceEmail } from "@shuddl/agents";
import type { EvidenceEmailData, EvidenceMessage, EvidenceSender } from "@shuddl/agents";
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

// ====================================================================================================
// THE GUARDED, DEV-ONLY EVIDENCE LIVE-SEND PROBE — POST /_dev/evidence-test-send (REQ-092 wiring proof)
//
// This composes the REAL evidence email (renderEvidenceEmail) and sends it through the REAL sender
// selection (evidenceSender — the SAME logic the Biller uses) to a SINK recipient the OPERATOR controls,
// so the operator can prove the live-send wiring end-to-end (a real Resend id in their dashboard) with
// ZERO risk of mailing a real consignee. It is a WIRING PROBE, not production sending: there is no flag
// here that turns real evidence sending on (that is a milestone decision — see the queue() header).
//
// It is engineered so it is IMPOSSIBLE for this route to email an arbitrary/attacker-supplied address:
//   · the whole route is INERT unless ALLOW_TEST_SEND === "1" (any prod/normal deploy 404s — the route
//     is indistinguishable from not existing);
//   · it is bearer-token gated, and FAIL-CLOSED — the flag alone, without TEST_SEND_TOKEN, 500s rather
//     than exposing an unauthenticated outbound-email route;
//   · the recipient is OPERATOR-CONTROLLED ONLY (env.TEST_SEND_TO, else the documented Resend sink
//     "delivered@resend.dev"); a request body that tries to set `to`/`recipient` is REFUSED (400) —
//     the load-bearing safety property.
// ====================================================================================================

const TEST_SEND_PATH = "/_dev/evidence-test-send";
// Resend's documented delivery-sink address: it always accepts and never affects sending reputation, so
// the probe can run against it forever without risk. The operator may point the sink at their OWN inbox
// via env.TEST_SEND_TO to eyeball the rendered email — still operator-controlled, never client-controlled.
const DEFAULT_TEST_SEND_TO = "delivered@resend.dev";

// The canonical REQ-167-clean fictional sample (verbatim from apps/portal/src/evidence-email.tsx and
// tools/live/render-email.ts) — no real tenant/person/customer names, ever (REQ-167).
const PROBE_EMAIL_DATA: EvidenceEmailData = {
  shipment_ref: "SHP-40206",
  delivered_at: "2026-07-10 · 14:32 MT",
  signed_by: "J. NAVARRO · RECEIVING",
  location: "DENVER, CO 80216",
  invoice_ref: "INV-40206",
  total_cents: 148_000,
  photos: {},
  referral_url: "https://shuddl.tech?ref=SHP-40206",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// Constant-time-ish bearer comparison: length check + full char sweep (never short-circuit on the first
// mismatched char). The token is operator-set (not high-value), but a timing side channel on an
// outbound-email gate is not worth leaving open.
function tokensEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// The probe handler. Returns AFTER the gates in strict order — each gate is pinned by test/test-send.test.ts.
async function handleTestSend(request: Request, env: AgentsEnv): Promise<Response> {
  const url = new URL(request.url);

  // GATE 1 — the flag makes the route INERT. Off (or ≠ "1") ⇒ 404 for EVERYTHING; on ⇒ only the exact
  // POST route lives, any other method/path 404s. A prod deploy (no flag) cannot tell this route exists.
  if (env.ALLOW_TEST_SEND !== "1") return new Response("Not Found", { status: 404 });
  if (request.method !== "POST" || url.pathname !== TEST_SEND_PATH) return new Response("Not Found", { status: 404 });

  // GATE 2 — bearer token, FAIL-CLOSED. The flag alone must NEVER open an unauthenticated outbound-email
  // route: no/empty TEST_SEND_TOKEN ⇒ 500 misconfigured (not "open"). Missing/≠ bearer ⇒ 401.
  const token = env.TEST_SEND_TOKEN;
  if (token === undefined || token === "") {
    return json(500, { error: "misconfigured: set TEST_SEND_TOKEN" });
  }
  const authz = request.headers.get("Authorization") ?? "";
  const presented = authz.startsWith("Bearer ") ? authz.slice("Bearer ".length) : "";
  if (presented === "" || !tokensEqual(presented, token)) {
    return json(401, { error: "unauthorized" });
  }

  // Parse the OPTIONAL body: it may carry only `probe_id` (to vary the idempotency key). It may NEVER
  // carry a recipient — a body that supplies `to`/`recipient` is refused LOUDLY (the safety property).
  let probeId = "manual";
  const rawBody = await request.text();
  if (rawBody.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return json(400, { error: "body must be JSON" });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json(400, { error: "body must be a JSON object" });
    }
    const b = parsed as Record<string, unknown>;
    // SAFETY: the recipient is operator-controlled ONLY. Refuse a client-supplied recipient outright —
    // it must be impossible for this route to email a body-supplied address.
    if ("to" in b || "recipient" in b) {
      return json(400, {
        error:
          "the recipient is operator-controlled (env TEST_SEND_TO, else the built-in delivered@resend.dev sink) — " +
          "it CANNOT be set from the request body; remove `to`/`recipient`",
      });
    }
    if (b["probe_id"] !== undefined) {
      const pid = b["probe_id"];
      if (typeof pid !== "string" || pid === "") {
        return json(400, { error: "probe_id must be a non-empty string" });
      }
      // probe_id rides verbatim into the Idempotency-Key HTTP header AND into idempotency_key (≤256 chars,
      // Resend's documented max). A CRLF or an over-long value would otherwise surface as an OPAQUE 500
      // (the sender's Zod boundary rejects it downstream) — a bad CLIENT input is a clean 400, not a 500.
      if (/[\r\n]/.test(pid) || `evidence-test-send/${pid}`.length > 256) {
        return json(400, { error: "probe_id must be CRLF-free and short" });
      }
      probeId = pid;
    }
  }

  // GATE 3 — the recipient: env.TEST_SEND_TO (operator-set), else the hardcoded sink. NEVER client-derived.
  const recipient = env.TEST_SEND_TO !== undefined && env.TEST_SEND_TO !== "" ? env.TEST_SEND_TO : DEFAULT_TEST_SEND_TO;

  // GATE 4 — the SAME sender selection the Biller uses (ResendSender iff key+from bound, else NotConfigured).
  const sender = evidenceSender(env);

  // GATE 5 — compose the real email + send. Reusing a probe_id returns the ORIGINAL send (Resend dedupes
  // by the Idempotency-Key), so vary probe_id to force a fresh send.
  const rendered = renderEvidenceEmail(PROBE_EMAIL_DATA);
  const message: EvidenceMessage = {
    channel: "email",
    to: recipient,
    subject: rendered.subject,
    html: rendered.html,
    shipment_id: "SHP-40206",
    idempotency_key: `evidence-test-send/${probeId}`,
  };

  try {
    const receipt = await sender.send(message);
    return json(200, { ok: true, provider: receipt.provider, provider_id: receipt.provider_id, sent_to: recipient });
  } catch (err) {
    // NotConfigured ⇒ the probe doubles as a "is the key wired yet?" check: 200 with the actionable text,
    // NOT a crash (and nothing was sent — NotConfiguredSender never touches the network).
    if (sender instanceof NotConfiguredSender && err instanceof SendError) {
      return json(200, { ok: false, configured: false, error: err.message });
    }
    // A real provider failure. Surface retriable/status (SendError messages never carry the api key).
    if (err instanceof SendError) {
      return json(502, { ok: false, error: err.message, retriable: err.retriable, status: err.status });
    }
    // Anything else (a render/validation fault) — surface without leaking the environment.
    return json(500, { error: err instanceof Error ? err.message : String(err) });
  }
}

export default {
  // The ONLY http surface this worker serves: the guarded, dev-only evidence live-send probe
  // (handleTestSend above). Inert (404) unless ALLOW_TEST_SEND === "1"; token-gated; sink-only. Every
  // other path/method 404s. This never touches the queue()/scheduled() paths.
  async fetch(request: Request, env: AgentsEnv, ctx: ExecutionContext): Promise<Response> {
    void ctx;
    return handleTestSend(request, env);
  },
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
