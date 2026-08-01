// REQ-014 / REQ-039. This worker owns the daily Merkle -> TSA anchor cron AND the agent queue
// consumers (WP-06: the Biller — src/biller.ts). LLM calls live here and in packages/agents — never
// in the ledger (REQ-024); the Biller itself is deterministic and LLM-free.

import { z } from "@shuddl/contracts";
import { runDailyAnchor } from "@shuddl/ledger/anchor";
import { FakeTsaClient, HttpTsaClient, UnavailableTsaClient, type TsaClient } from "@shuddl/ledger/tsa/client";
import { ClaudeParser, NotConfiguredParser, NotConfiguredSender, ParseError, ResendSender, SendError, renderEvidenceEmail } from "@shuddl/agents";
import type { ConciergeParser, EvidenceEmailData, EvidenceMessage, EvidenceSender } from "@shuddl/agents";
import { PodSignedMessage, handlePodSigned, type BillerDeps, type SeqStubLike } from "./biller.js";
import { handleInterlineSplit } from "./interline-split.js";
import { MessageReceivedTrigger, handleMessageReceived, type ConciergeDeps } from "./concierge.js";
import { QuoteAcceptedTrigger, handleQuoteAccepted, type BookingDeps } from "./booking.js";
import { sweepTenantOverdueInbound } from "./sla-sweep.js";
import { sweepTenantUnbilledRedrive } from "./recon-sweep.js";
import { sweepTenantCreditGaps } from "./credit-recon-sweep.js";
import { sweepTenantOverdueInvoices } from "./collector.js";
import { sweepTenantLegacyMirror, NotConfiguredFeedReader, LEGACY_MIRROR_INTEGRATION_ID, type FeedReader } from "./mirror-sweep.js";
import { runWatchtowerSweep } from "./watchtower.js";
import { runWatchtowerSnapshots } from "./watchtower-snapshot.js";
import { sweepTenantExpiredDocuments } from "@shuddl/ledger/documents/retention";
import { allTenantSlugs, resolveTenantDb, type AgentsEnv } from "./tenants.js";
import { sparkGateFor } from "./spark-caps.js";

// WP-14 Task 8 (REQ-122/125) — the per-tenant Spark convenience meter DO MUST be re-exported from the worker's
// main module (the runtime binds `class_name = "SparkMeter"` to this export). Mirrors workers/mcp re-exporting
// CapsMeter and workers/api re-exporting ShipmentSequencer.
export { SparkMeter } from "./spark-meter.js";

// The queue's message union (REQ-039): a committed pod.signed fans out to the Biller, a committed
// message.received to the Concierge, a committed quote.accepted to the Booking agent. Discriminated on `kind`,
// so a body matching no member — or one missing a member's required fields — fails safeParse and is ACKed as
// poison (redelivery cannot fix a shape).
const AgentTrigger = z.discriminatedUnion("kind", [PodSignedMessage, MessageReceivedTrigger, QuoteAcceptedTrigger]);
type AgentTrigger = z.infer<typeof AgentTrigger>;

// Exhaustiveness guard for the queue() dispatch — mirrors the DO's own assertNever. A future AgentTrigger
// member added WITHOUT a matching dispatch case makes `trigger` no longer `never` at the final branch → a
// COMPILE error, never a silent fall-through to the Booking branch (which would Zod-reject the foreign kind
// and DLQ it). Belt (compile) + suspenders (throws at runtime → retry(), the loud path).
function assertNever(x: never): never {
  throw new Error(`unreachable agent dispatch for ${JSON.stringify(x)}`);
}

// REQ-098 tenant voice fallback — a generic, REQ-167-clean from-name when none is configured.
const DEFAULT_CONCIERGE_FROM_NAME = "Shuddl Dispatch";

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

// Anchor every tenant — the static roster plus every CLAIMED pool tenant (2026-08-01 audit C3). Exported so
// the cron test and a manual backfill both drive the identical path. A per-tenant failure is contained — one
// tenant's TSA outage, or a claimed slug un-claimed mid-sweep, never stalls the rest (the containment this
// header always claimed now includes resolution: runDailyAnchor contains its own scan faults, but a
// resolveTenantDb/tsaFor throw used to abort every remaining tenant).
export async function runAllTenants(env: AgentsEnv, now: () => Date = () => new Date()): Promise<void> {
  for (const slug of await allTenantSlugs(env)) {
    try {
      const db = await resolveTenantDb(env, slug);
      const tsa = await tsaFor(env, db);
      await runDailyAnchor({ db, r2: env.EVIDENCE, tsa, tenant: slug, now });
    } catch (err) {
      console.error(`anchor cron: tenant ${slug} failed before/at anchoring (contained; next run retries):`, err);
    }
  }
}

// REQ-095 — the SLA overdue sweep across every allowlisted tenant (REQ-025 isolation: one tenant's D1 per
// iteration; each append names its tenant so the DO re-derives identity). Exported so the cron test and a
// manual re-drive both hit the identical path. Idempotent + aggressive-safe (the deterministic signal id
// dedupes at the DO), so re-running every tick is safe; a per-tenant fault is contained + logged so one
// tenant never stalls the rest. The cron reads wall-clock for `now` (deterministic in tests).
export async function runSlaSweep(env: AgentsEnv, now: () => number = () => Date.now()): Promise<void> {
  const seq = sequencerFor(env);
  const at = now();
  for (const slug of await allTenantSlugs(env)) {
    try {
      const result = await sweepTenantOverdueInbound(await resolveTenantDb(env, slug), seq, slug, at);
      console.log(`concierge sla-sweep: tenant ${slug} → ${JSON.stringify(result)}`);
    } catch (err) {
      console.error(`concierge sla-sweep: tenant ${slug} failed (re-run next tick — the sweep is idempotent):`, err);
    }
  }
}

// REQ-169 — the Biller reconciliation sweep across every allowlisted tenant (REQ-025 isolation: one tenant's D1
// per iteration; each re-enqueued trigger names ONLY that tenant, so it CANNOT re-drive another). It RE-ENQUEUES
// the Biller trigger for any stream with a committed pod.signed but NO invoice.issued AND no terminal hold-marker,
// older than the window — closing the commit→enqueue lost-trigger gap. Self-clearing + BOUNDED: once a POD is
// billed (invoice.issued) or held (the marker the Biller writes), it drops out of the anti-join, so a permanently-
// held POD is re-enqueued at most until its marker lands, then never again. Idempotent (deterministic invoice id +
// DO dedupe), so re-driving every tick is safe; a per-tenant fault is contained + logged so one tenant never
// stalls the rest. The cron reads wall-clock for `now` (deterministic in tests).
export async function runReconSweep(env: AgentsEnv, now: () => number = () => Date.now()): Promise<void> {
  const at = now();
  for (const slug of await allTenantSlugs(env)) {
    try {
      const result = await sweepTenantUnbilledRedrive(await resolveTenantDb(env, slug), env.AGENT_QUEUE, slug, at);
      console.log(`recon-sweep: tenant ${slug} → ${JSON.stringify(result)}`);
    } catch (err) {
      console.error(`recon-sweep: tenant ${slug} failed (re-run next tick — the sweep is idempotent):`, err);
    }
  }
}

// Task 6 (REQ-042/183) — the CREDIT projection-gap reconciliation sweep across every allowlisted tenant (REQ-025
// isolation: one tenant's D1 per iteration; the sweep reconciles only that tenant's parties/anomalies). It drives
// the SAME shared @shuddl/ledger reconciler the DO booking gate uses, applying the latest valid credit decision
// once the party materializes and marking the gap resolved. FAIL CLOSED + idempotent + self-clearing (a party
// still absent / with no decision leaves the gap open; a resolved gap drops out of the scan), so re-running every
// tick is safe; a per-tenant fault is contained + logged so one tenant never stalls the rest. Time-independent
// (reconcile depends on ledger state, not the clock). Exported so the cron test + a manual re-drive hit the
// identical path.
export async function runCreditReconSweep(env: AgentsEnv): Promise<void> {
  for (const slug of await allTenantSlugs(env)) {
    try {
      const result = await sweepTenantCreditGaps(await resolveTenantDb(env, slug));
      console.log(`credit-recon-sweep: tenant ${slug} → ${JSON.stringify(result)}`);
    } catch (err) {
      console.error(`credit-recon-sweep: tenant ${slug} failed (re-run next tick — the sweep is idempotent):`, err);
    }
  }
}

// REQ-032 — the Collector dunning sweep across every allowlisted tenant (REQ-025 isolation: one tenant's D1 per
// iteration; the sweep appends no event and names no tenant, so it CANNOT touch another). It DRAFTS tone-matched
// dunning `messages` rows for OPEN overdue invoices and NEVER sends — no sequencer, no sender. Exported so the
// cron test and a manual re-drive both hit the identical path. Idempotent (deterministic per-(invoice,bucket)
// draft id + INSERT OR IGNORE), so re-running every tick is safe; a per-tenant fault is contained + logged so
// one tenant never stalls the rest. The cron reads wall-clock for `now` (deterministic in tests).
export async function runCollectorSweep(env: AgentsEnv, now: () => number = () => Date.now()): Promise<void> {
  const at = now();
  for (const slug of await allTenantSlugs(env)) {
    try {
      const result = await sweepTenantOverdueInvoices(await resolveTenantDb(env, slug), at);
      console.log(`collector dunning-sweep: tenant ${slug} → ${JSON.stringify(result)}`);
    } catch (err) {
      console.error(`collector dunning-sweep: tenant ${slug} failed (re-run next tick — the sweep is idempotent):`, err);
    }
  }
}

// REQ-036 / REQ-008 — the Watchtower alarm sweep across every allowlisted tenant (REQ-025 isolation: one tenant's
// D1 per iteration; each append names ONLY that tenant, so it CANNOT touch another). It raises/clears the unbilled,
// pricing_anomaly, floor_breach, agent_drift, and parity_drift alarms as durable `anomalies` rows (NO new table,
// NO new kind). The parity_drift rule ALSO auto-falls-back a drifted native module to legacy by appending the
// FROZEN authority.flipped #35 on t:root THROUGH the api sequencer DO (sequencerFor) — the ONLY ledger write the
// sweep makes, and ALWAYS to:'legacy' (the overlay asymmetry). Exported so the cron test and a manual re-drive both
// hit the identical path. Idempotent + self-clearing (deterministic alarm ids + ON-CONFLICT upsert; the fallback's
// deterministic per-episode id dedupes at the DO), so re-running every tick is safe; a per-tenant fault is
// contained + logged so one tenant never stalls the rest. The cron reads wall-clock for `now` (deterministic in
// tests); it stamps the fallback ts and feeds the unbilled age→severity.
export async function runWatchtower(env: AgentsEnv, now: () => number = () => Date.now()): Promise<void> {
  // WP-15 Task 8 (REQ-008) — the parity_drift rule's auto-fallback appends authority.flipped on t:root through the
  // SAME api sequencer DO seam every other append uses (sequencerFor), so the flip is gate-checked + projected by
  // the ONE chokepoint. The other 4 rules ignore it (they only UPSERT anomalies rows).
  const seq = sequencerFor(env);
  const at = now();
  for (const slug of await allTenantSlugs(env)) {
    try {
      const result = await runWatchtowerSweep(await resolveTenantDb(env, slug), slug, at, {}, seq);
      console.log(`watchtower: tenant ${slug} → ${JSON.stringify(result)}`);
    } catch (err) {
      console.error(`watchtower: tenant ${slug} failed (re-run next tick — the sweep is idempotent):`, err);
    }
  }
}

// REQ-116 — the R2 RETENTION sweep across every allowlisted tenant (REQ-025 isolation: one tenant's D1 + its
// `evidence/<tenant>/` key scope per iteration; the sweep never deletes outside that namespace). It DELETEs
// expired NON-POD R2 bytes and TOMBSTONES the documents row, preserving the row-iff-bytes invariant (never
// orphaned in either direction) — a POD is the 7-year compliance class and is never swept. Exported so the cron
// test and a manual re-drive both hit the identical path. Idempotent + self-healing (an already-tombstoned doc
// is no longer a candidate; delete-then-tombstone re-heals a torn tick), so re-running every tick is safe; a
// per-tenant fault is contained + logged so one tenant never stalls the rest. The cron reads wall-clock for `now`.
export async function runRetentionSweep(env: AgentsEnv, now: () => number = () => Date.now()): Promise<void> {
  const at = now();
  for (const slug of await allTenantSlugs(env)) {
    try {
      const result = await sweepTenantExpiredDocuments(await resolveTenantDb(env, slug), env.EVIDENCE, slug, at);
      console.log(`retention-sweep: tenant ${slug} → ${JSON.stringify(result)}`);
    } catch (err) {
      console.error(`retention-sweep: tenant ${slug} failed (re-run next tick — the sweep is idempotent):`, err);
    }
  }
}

// WP-15 Task 4 (REQ-021/022/035) — the FeedReader composition root. FAIL-CLOSED by default: the incumbent's
// legacy export is mirrored ONLY once a tenant pack deliberately wires a real feed at Phase-0 cutover
// (genesis/13) — the SAME NotConfigured posture as evidenceSender/conciergeParser. So the mirror cron below is
// INERT (a no-op) in every environment today, exactly as the overlay's authority map ships unflipped. Wiring a
// live R2/API feed reader here is a CONFIRM-gated config step, not code that turns on by itself.
function feedReaderFor(_env: AgentsEnv, _slug: string): FeedReader {
  return new NotConfiguredFeedReader();
}

// REQ-021/022/035 — the continuous legacy-mirror sweep across every allowlisted tenant (REQ-025 isolation: one
// tenant's D1 per iteration; each append names ONLY that tenant, so it CANNOT touch another). It mirrors every
// NEW/CHANGED legacy-export row into the ledger as a `source:'legacy'` event THROUGH the api sequencer DO
// (Task-6 parity's legacy side), re-raises a gap `anomalies` row for every unmapped column (continuous no-silent-
// drop), skips SHUDDL echoes + dedupes on deterministic ids (no ping-pong), and advances the per-tenant watermark
// on integrations.config. Idempotent + BOUNDED + FAIL-CLOSED: absent a wired feed/integration it no-ops, so
// re-running every tick is safe; a per-tenant fault is contained + logged so one tenant never stalls the rest.
// Exported so the cron test + a manual re-drive hit the identical path. The cron reads wall-clock for `now`.
export async function runMirrorSweep(env: AgentsEnv, now: () => number = () => Date.now()): Promise<void> {
  const seq = sequencerFor(env);
  const at = now();
  for (const slug of await allTenantSlugs(env)) {
    try {
      const result = await sweepTenantLegacyMirror({
        db: await resolveTenantDb(env, slug),
        seq,
        feed: feedReaderFor(env, slug),
        integrationId: LEGACY_MIRROR_INTEGRATION_ID,
        tenant: slug,
        now: at,
      });
      console.log(`legacy-mirror: tenant ${slug} → ${JSON.stringify(result)}`);
    } catch (err) {
      console.error(`legacy-mirror: tenant ${slug} failed (re-run next tick — the sweep is idempotent):`, err);
    }
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

// REQ-024 — the LLM parse port is selected HERE (never inside the consumer): BOTH an ANTHROPIC_API_KEY
// (secret) and a model id bound ⇒ ClaudeParser; anything less ⇒ NotConfiguredParser, which rejects LOUDLY
// (retriable) so an unconfigured environment can never silently swallow an inbound parse. Mirrors
// evidenceSender()'s composition-root discipline. Going live is a CONFIRM-gated config flip, not code.
function conciergeParser(env: AgentsEnv): ConciergeParser {
  const apiKey = env.ANTHROPIC_API_KEY;
  const model = env.ANTHROPIC_MODEL;
  if (apiKey !== undefined && apiKey !== "" && model !== undefined && model !== "") {
    return new ClaudeParser({ apiKey, model });
  }
  return new NotConfiguredParser();
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
    // REQ-095 — the SLA overdue sweep rides the SAME cron tick, anchored to the fired-at instant so
    // "overdue" is deterministic and a delayed/retried invocation still evaluates against a stable clock. It
    // is DECOUPLED from the anchor via try/finally: a per-tenant anchor fault (a TSA outage) must NOT skip
    // the sweep for that tick. runSlaSweep contains its own per-tenant faults, so the finally never masks
    // the anchor's error — the anchor throw still surfaces (and the cron retries) after the sweep runs.
    // REQ-032 — the Collector dunning sweep ALSO rides this tick (DRAFTS only; no send). It is DECOUPLED from
    // the anchor via the same finally so a per-tenant anchor fault never skips it; each sweep contains its own
    // per-tenant faults, so the anchor's throw still surfaces (and the cron retries) after both sweeps run.
    try {
      await runAllTenants(env, () => new Date(controller.scheduledTime));
    } finally {
      await runSlaSweep(env, () => controller.scheduledTime);
      await runCollectorSweep(env, () => controller.scheduledTime);
      // REQ-169 — the Biller reconciliation sweep rides this SAME tick, anchored to the fired-at instant so the
      // age cutoff is deterministic. DECOUPLED from the anchor via the same finally so a per-tenant anchor fault
      // never skips it; it contains its own per-tenant faults, so the anchor's throw still surfaces after it runs.
      // It re-enqueues any lost-trigger pod.signed (unbilled + unheld, older than the window) so the Biller
      // re-drives; self-clearing + idempotent (a billed/held stream drops out of the anti-join).
      await runReconSweep(env, () => controller.scheduledTime);
      // Task 6 (REQ-042/183) — the CREDIT projection-gap reconciliation sweep rides this SAME tick. DECOUPLED from
      // the anchor via the same finally so a per-tenant anchor fault never skips it; it contains its own per-tenant
      // faults, so the anchor's throw still surfaces after it runs. It reconciles any historical/imported credit
      // gap once the party materializes (applies the latest decision, resolves the gap). Idempotent + self-clearing;
      // time-independent (no `now` — reconcile keys off ledger state, not the clock).
      await runCreditReconSweep(env);
      // REQ-036 — the Watchtower alarm sweep rides the SAME tick, anchored to the fired-at instant so severity
      // is deterministic. DECOUPLED from the anchor via the same finally so a per-tenant anchor fault never
      // skips it; it contains its own per-tenant faults, so the anchor's throw still surfaces after it runs.
      await runWatchtower(env, () => controller.scheduledTime);
      // REQ-116 — the R2 RETENTION sweep rides this SAME tick, anchored to the fired-at instant so "expired" is
      // deterministic. DECOUPLED via the same finally so a per-tenant anchor fault never skips it; it contains
      // its own per-tenant faults, so the anchor's throw still surfaces after it runs. It DELETEs expired non-POD
      // R2 bytes + tombstones the row (row-iff-bytes preserved); a POD is 7yr and never swept. Idempotent.
      await runRetentionSweep(env, () => controller.scheduledTime);
      // REQ-021/022/035 — the continuous LEGACY-MIRROR sweep rides this SAME tick, anchored to the fired-at
      // instant so the re-raised gap-anomaly ids are deterministic. DECOUPLED via the same finally so a per-tenant
      // anchor fault never skips it; it contains its own per-tenant faults, so the anchor's throw still surfaces
      // after it runs. FAIL-CLOSED: with no wired feed/integration it no-ops (the overlay stays dormant until a
      // Phase-0 cutover wires a real feed — genesis/13), so this is inert in every environment today.
      await runMirrorSweep(env, () => controller.scheduledTime);
      // REQ-160 — the WEEKLY Watchtower telemetry snapshot rides this SAME daily tick but is DAY-OF-WEEK GATED
      // (isSnapshotDay): it persists each tenant's 7-metric R2 manifest only on SNAPSHOT_DOW, a no-op every other
      // day — so the daily cron carries the weekly snapshot with no new cron expression. DECOUPLED via the same
      // finally; it contains its own per-tenant faults (write-once per ISO week, idempotent). NO external publish
      // (CONFIRM-gated) — the R2 manifest IS the telemetry.
      await runWatchtowerSnapshots(env, () => controller.scheduledTime);
    }
  },
  // REQ-159 (GTM — milestone gate, NOT a code deliverable): this consumer is the M-H substrate. The
  // "heartbeat on real freight" that M-H exits on IS this path firing — pod.signed → invoice.issued →
  // evidence send — on a live tenant-0 shipment. The MECHANISM ships in this WP; the GTM unlock it
  // gates (R1 external selling) is a MILESTONE decision the owner makes at M-H exit per genesis/12 §01,
  // never something code turns on. External selling never precedes this heartbeat on real freight; there
  // is deliberately no in-repo flag that flips it — the gate is the milestone, evidenced by the M-H demo.
  //
  // REQ-039 / WP-06/07: the agent consumers, dispatched by `kind` — pod.signed → Biller, message.received
  // → Concierge. Per-message ack/retry — one poison message never stalls the batch. POISON (a body matching
  // neither trigger shape) is ACKed with a loud log: redelivery cannot fix a shape, and there is no tenant
  // to recover it for. An UNKNOWN TENANT is NOT poison (2026-08-01 audit, C3): the api worker + sequencer DO
  // serve claimed pool tenants this worker's static roster cannot resolve, so "unknown" can mean "not yet
  // rostered here" — the trigger RETRIES toward the configured DLQ (shuddl-agent-dlq-*, max_retries then
  // dead_letter_queue in wrangler.toml), parking a recoverable record instead of destroying an invoice
  // trigger the REQ-169 sweep can never rebuild (the crons enumerate only the static roster). A THROWN
  // handler failure (a retriable parse/send, a transient D1/DO fault) retries the MESSAGE — safe end to end
  // because BOTH consumers' append ids + send idempotency keys are deterministic (dedupe both sides).
  async queue(batch: MessageBatch, env: AgentsEnv, ctx: ExecutionContext): Promise<void> {
    void ctx;
    for (const message of batch.messages) {
      const parsed = AgentTrigger.safeParse(message.body);
      if (!parsed.success) {
        console.error(`agents queue: unparseable message ${message.id} — ack as poison: ${parsed.error.message}`);
        message.ack();
        continue;
      }
      const trigger: AgentTrigger = parsed.data;
      let db: D1Database;
      try {
        db = await resolveTenantDb(env, trigger.tenant); // REQ-025 — static allowlist + server-side claimed-pool resolution, nothing else
      } catch (err) {
        // NOT an ack: an unrostered tenant may be a CLAIMED POOL tenant the api worker fully serves. Retry
        // toward the DLQ so the trigger survives as a recoverable record (see the queue() doc note above).
        console.error(`agents queue: message ${message.id} names a tenant outside this worker's static roster — retrying toward the DLQ (a pool tenant's trigger must survive):`, err);
        message.retry();
        continue;
      }
      try {
        if (trigger.kind === "pod.signed") {
          const deps: BillerDeps = {
            db,
            seq: sequencerFor(env),
            sender: evidenceSender(env),
            referralBase: env.REFERRAL_BASE ?? DEFAULT_REFERRAL_BASE,
            // Task 9 (REQ-170) — wire the evidence R2 bucket so the Biller REQUIRES stored POD bytes before the
            // proof email. Production always provides it here, so the byte precondition always runs in prod.
            evidence: env.EVIDENCE,
          };
          const outcome = await handlePodSigned(trigger, deps);
          // The outcome IS the log line until WP-11's exceptions queue lands (holds surface there).
          console.log(`biller: pod ${trigger.event_id} → ${JSON.stringify(outcome)}`);
          // WP-11 (REQ-019): the SAME committed pod.signed also settles the interline AP split — DERIVED
          // from the recorded custody legs and appended through the sequencer (server-emitted money; a
          // client can never supply an allocation). Independent of the AR invoice above; a direct move
          // produces nothing, a below-floor executing share HOLDS (REQ-040). Runs AFTER the Biller so the
          // <5s AR golden path is never behind the AP settlement. Idempotent (deterministic id + sequencer
          // dedupe), so a redelivery that re-runs both is safe; a transient fault here retries the message.
          const splitOutcome = await handleInterlineSplit(trigger, { db, seq: sequencerFor(env) });
          console.log(`interline-split: pod ${trigger.event_id} → ${JSON.stringify(splitOutcome)}`);
        } else if (trigger.kind === "message.received") {
          const deps: ConciergeDeps = {
            db,
            seq: sequencerFor(env),
            sender: evidenceSender(env),
            parser: conciergeParser(env),
            tenantFromName: env.CONCIERGE_FROM_NAME ?? DEFAULT_CONCIERGE_FROM_NAME,
            // REQ-122/125 — the Spark convenience cap, resolved per-tenant at the composition root. A non-Spark
            // tenant → UNCAPPED (no-op). This gate is built ONLY here (the message.received/Concierge branch) —
            // the pod.signed (Biller) and quote.accepted (Booking) branches construct NO gate, so the physical-
            // truth append + invoicing are never throttled (the carve-out is structural). A control-read fault
            // throws → the message redelivers (truth is never on this path); it never runs the LLM un-metered.
            sparkGate: await sparkGateFor(env, trigger.tenant),
          };
          const outcome = await handleMessageReceived(trigger, deps);
          console.log(`concierge: message ${trigger.event_id} → ${JSON.stringify(outcome)}`);
        } else if (trigger.kind === "quote.accepted") {
          // WP-08 (REQ-028/030): a committed quote.accepted → the Booking agent, which appends a gated
          // booking.created THROUGH the sequencer DO. No sender/parser — it is LLM-free and sends nothing; a
          // GATE_BLOCK is caught INSIDE the agent and returned as `held` (never a throw → DLQ loop), so only a
          // genuine transient fault reaches the retry() below.
          const deps: BookingDeps = { db, seq: sequencerFor(env) };
          const outcome = await handleQuoteAccepted(trigger, deps);
          console.log(`booking: quote.accepted ${trigger.event_id} → ${JSON.stringify(outcome)}`);
        } else {
          // Every AgentTrigger kind is handled above — this is unreachable. If a new member is added without a
          // case, `trigger` is no longer `never` here and this stops compiling (the fail-loud contract).
          assertNever(trigger);
        }
        message.ack();
      } catch (err) {
        console.error(`agents queue: retriable failure for ${trigger.kind} ${trigger.event_id} — message will redeliver:`, err);
        // A 429 from a provider (Resend send OR the Anthropic parse) means we're being throttled: immediate
        // redelivery would re-trip the limiter, so back the retry off. Both SendError and ParseError thread
        // `.status` exactly for this.
        const status = err instanceof SendError || err instanceof ParseError ? err.status : undefined;
        if ((err instanceof SendError || err instanceof ParseError) && err.retriable && status === 429) {
          message.retry({ delaySeconds: RATE_LIMIT_RETRY_DELAY_S });
        } else {
          message.retry();
        }
      }
    }
  },
};
