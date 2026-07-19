// WP-12 Task 7 · REQ-200 — THE TRANSLATOR WORKER ENTRY. It owns the outbound 214 status sweep (this task,
// cron-driven) and will own the inbound 204 handler (Task 8). It BINDS to existing resources (the api
// sequencer DO, the per-tenant D1s, the evidence R2) — it never owns or migrates them.
//
// The core X12 serialize/parse logic is the PURE @shuddl/edi adapter (REQ-035); the byte-stable status
// PROJECTION is src/core/build-214.ts (Task 6). This entry is only composition + I/O wiring: it selects the
// outbound transport port at the composition root (transportFor — creds via `wrangler secret`, never the
// toml, REQ-154) and drives the sweep. No LLM calls (this worker is deterministic, EDI-format only).
import { run214Sweep } from "./sweep-214.js";
import { NotConfiguredTransport, type EdiTransport } from "./transport.js";
import {
  handleInbound204,
  NotConfiguredSecretResolver,
  INBOUND_204_PATH,
  type InboundDeps,
  type SecretResolver,
  type SeqStubLike,
} from "./inbound.js";
import { tenantDb, type TranslatorEnv } from "./tenants.js";

// THE COMPOSITION ROOT for the outbound transport (mirrors evidenceSender/conciergeParser in workers/agents).
// A LIVE EdiTransport adapter (AS2/SFTP/VAN) is a CONFIRM-gated flip that binds HERE once EDI_TRANSPORT_URL +
// EDI_TRANSPORT_TOKEN exist (secrets, never the toml — REQ-154) AND the partner is replay-certified (Task 9 /
// REQ-203). That adapter is deliberately NOT built in this WP, so this FAILS CLOSED: with or without creds,
// no environment can transmit real EDI yet. NotConfiguredTransport rejects safely, and the sweep writes the
// "sent" marker ONLY after a successful send, so an unwired env never records a phantom transmission.
export function transportFor(env: TranslatorEnv): EdiTransport {
  void env; // read here when the live adapter binds — see the header
  return new NotConfiguredTransport();
}

// THE COMPOSITION ROOT for the inbound-204 HMAC secret resolution (mirrors transportFor's fail-closed default).
// Resolving a partner's shared secret from a real secret store is the CONFIRM-gated live flip (REQ-154 — secrets
// never in the toml); until then this FAILS CLOSED (every 204 401s). The handler logic ships fully tested via an
// injected resolver — going live is a config flip, not code.
export function secretResolverFor(env: TranslatorEnv): SecretResolver {
  void env; // read here when the live secret store binds — see the header
  return new NotConfiguredSecretResolver();
}

// Route each append to the api worker's (tenant|stream) sequencer DO — the SAME id derivation the api routes +
// the agents worker use, so the DO's identity re-derivation (REQ-025) accepts it. The 204 handler appends the
// gated chain THROUGH this stub, up to and INCLUDING quote.accepted; it never appends booking.created.
function sequencerFor(env: TranslatorEnv): SeqStubLike {
  return {
    append: (req) => (env.SHIPMENT_SEQ.get(env.SHIPMENT_SEQ.idFromName(`${req.tenant}|${req.streamId}`)) as unknown as SeqStubLike).append(req),
  };
}

// The composition root for the inbound-204 handler deps — every port selected HERE, none read from inside the
// orchestration (mirrors the agents worker's queue() composition).
function inboundDeps(env: TranslatorEnv): InboundDeps {
  return {
    controlDb: env.CONTROL_DB,
    tenantDbFor: (slug) => tenantDb(env, slug),
    evidence: env.EVIDENCE,
    seq: sequencerFor(env),
    transport: transportFor(env),
    secrets: secretResolverFor(env),
    now: () => Date.now(),
  };
}

export default {
  // The ONLY public HTTP surface: the inbound 204 webhook (POST INBOUND_204_PATH), authenticated by the
  // partner's shared secret (HMAC over the raw body), NOT a JWT. Every other path/method 404s — defensive and
  // explicit; the webhook is exposed via an explicit route only (workers_dev = false).
  async fetch(request: Request, env: TranslatorEnv, ctx: ExecutionContext): Promise<Response> {
    void ctx;
    if (request.method === "POST" && new URL(request.url).pathname === INBOUND_204_PATH) {
      return handleInbound204(request, inboundDeps(env));
    }
    return new Response("Not Found", { status: 404 });
  },
  // REQ-200 — the outbound 214 status sweep. The transport is selected at the composition root (transportFor)
  // and injected, so the sweep code is a pure function of (env, transport) — the test drives the SAME path
  // with a recording transport. The sweep contains its own per-tenant + per-shipment faults (Biller-style),
  // so a partner outage never stalls the tick; it is idempotent (an R2 dedupe marker per newest-status event),
  // so re-running every 5 minutes is safe.
  async scheduled(controller: ScheduledController, env: TranslatorEnv, ctx: ExecutionContext): Promise<void> {
    void controller;
    void ctx;
    await run214Sweep(env, transportFor(env));
  },
};
