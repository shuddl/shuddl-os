// WP-13 Task 10 (REQ-109/192) — OUTBOUND SIGNED WEBHOOKS: notify a subscribed pairing about ITS shipments.
//
// A pairing may subscribe to be notified when one of ITS shipments reaches a terminal milestone
// (booking.created / invoice.issued / delivery.evidenced). On such an event the mcp worker builds a
// counterparty-SAFE JSON payload, signs it (svix-style HMAC-SHA256), and POSTs it to the subscriber's URL —
// EXACTLY ONCE (an idempotent dedup marker per event). Every seam is fail-closed and injected, mirroring the
// translator's outbound-214 sweep discipline (deterministic dedupe key, sign-then-mark, per-item isolation).
//
// ── SUBSCRIPTION STORAGE — a `pairings` row, kind='webhook' (ADDITIVE; no new table, REQ-109 budget) ──────────
// The control-plane `pairings` table already permits kind='webhook' (0001_control.sql CHECK). A subscription is
// such a row whose `id` deterministically links the ORIGINATOR mcp pairing (webhookSubIdFor), whose `secret_ref`
// resolves (via the injected fail-closed SecretResolver) to the HMAC signing secret, and whose generic per-kind
// config JSON (`caps` column) carries `{ url, events? }` — the delivery URL + an optional terminal-kind allow-
// list. NO new column: `caps` is a per-kind JSON blob (spend/velocity/lanes for an mcp row; delivery config for
// a webhook row). tenant_id scopes it (REQ-025).
//
// ── ATTRIBUTION — refs.pairing (the ORIGINATOR), never the acting pairing ─────────────────────────────────────
// A terminal event is routed to the subscription of the pairing that ORIGINATED the shipment — `refs.pairing`,
// stamped at shipment creation (quote.ts). refs.pairing is used ONLY to SELECT the subscription; it is an
// internal field and NEVER rides the delivered payload (REQ-192).
//
// ── REQ-192: the payload carries ONLY the counterparty-safe projection ────────────────────────────────────────
// The signed body is exactly { id, type, shipment_id, occurred_at } — an event id, its kind, the shipment id,
// and a timestamp. No hashes, no refs, no money internals, no raw event payload. The signing proves authenticity;
// the projection guarantees no internal field can leak even to an authenticated subscriber.
//
// ── DELIVERY CRON — SCAFFOLDED; the LIVE event source is a documented go-live item ────────────────────────────
// The mcp worker holds NO tenant D1 (CONTROL_DB is auth-only, REQ-025) and reaches freight reality ONLY through
// the api service binding, which exposes a per-SHIPMENT lens read but no "recent terminal events for a tenant"
// endpoint. So the LIVE event source (a ledger/queue feed of new terminal events with their refs.pairing) is a
// go-live item, injected here as a port. The DEFAULT is NotConfiguredEventSource → [] (the production cron is a
// safe no-op until the feed is wired). What IS fully built + tested here: the subscription resolution, the
// signed-payload builder + signature + verification, the counterparty-safe projection, the fail-closed gating,
// and the idempotent deliver-once. See webhooks.test.ts for exactly what is tested vs scaffolded.
import { z } from "zod";
import { NotConfiguredSecretResolver, type SecretResolver } from "./principal.js";
import type { Env } from "./index.js";

// The terminal milestones a webhook fires on. Existing event kinds — NO new kind (the 35-kind catalog is
// untouched). A subscription MAY narrow to a subset via its `events` allow-list.
export const TERMINAL_WEBHOOK_KINDS = ["booking.created", "invoice.issued", "delivery.evidenced"] as const;
export type TerminalWebhookKind = (typeof TERMINAL_WEBHOOK_KINDS)[number];

function isTerminalKind(kind: string): kind is TerminalWebhookKind {
  return (TERMINAL_WEBHOOK_KINDS as readonly string[]).includes(kind);
}

// ── the subscription (a pairings kind='webhook' row) ─────────────────────────────────────────────────────────
/** The delivery config stored in a webhook pairing's `caps` JSON. `.strict()` — an unknown field is rejected. */
const WebhookConfig = z
  .object({
    url: z
      .string()
      .min(1)
      .max(2000)
      // https ONLY (2026-08-01 audit): the signature proves authenticity, never confidentiality, and the
    // body carries shipment ids + milestone kinds. Cleartext delivery of shipment milestones is refused.
    .refine((u) => u.startsWith("https://"), "url must be an https:// URL — cleartext delivery of shipment milestones is refused"),
    // Optional allow-list of terminal kinds; absent ⇒ all three terminal kinds are delivered.
    events: z.array(z.enum(TERMINAL_WEBHOOK_KINDS)).max(TERMINAL_WEBHOOK_KINDS.length).optional(),
  })
  .strict();

/** A resolved webhook subscription for one originator pairing. */
export interface WebhookSubscription {
  /** The webhook pairing row id (webhookSubIdFor(originatorPairingId)). */
  id: string;
  /** The mcp pairing whose shipments this subscription is notified about (the originator, refs.pairing). */
  originatorPairingId: string;
  tenantId: string;
  url: string;
  /** The signing secret's ref — resolved to bytes via the injected SecretResolver at delivery time (fail-closed). */
  secretRef: string;
  /** The subscribed terminal kinds (all three when the config omits an allow-list). */
  events: readonly TerminalWebhookKind[];
}

/** The deterministic 1:1 link from an originator mcp pairing to its webhook-subscription pairing row id. */
export function webhookSubIdFor(originatorPairingId: string): string {
  return `webhook:${originatorPairingId}`;
}

/**
 * Resolve the ACTIVE webhook subscription for an originator pairing, or null (fail-closed). The predicate
 * kind='webhook' + status='active' is the gate: an absent row, a non-webhook row, a suspended row, or a
 * malformed/`caps` that does not parse all resolve to null ⇒ NOTHING is delivered. Control plane = auth/config
 * resolution only, never a tenant data path (REQ-025).
 */
export async function resolveWebhookSubscription(db: D1Database, originatorPairingId: string): Promise<WebhookSubscription | null> {
  const id = webhookSubIdFor(originatorPairingId);
  const row = await db
    .prepare("SELECT id, tenant_id, caps, secret_ref, status FROM pairings WHERE id = ?1 AND kind = 'webhook' LIMIT 1")
    .bind(id)
    .first<{ id: string; tenant_id: string; caps: string; secret_ref: string; status: string }>();
  if (row === null || row.status !== "active") return null;
  // TENANT PARITY (REQ-025, 2026-08-01 convergence audit): the subscription's tenant was loaded and never
  // compared to the ORIGINATOR's. `pairings.id` is a global primary key, so a `webhook:<pairing-A>` row
  // provisioned under tenant B would route tenant A's milestones to tenant B's endpoint. Both rows must
  // name the same tenant, or nothing is delivered.
  const originator = await db
    .prepare("SELECT tenant_id FROM pairings WHERE id = ?1 AND kind = 'mcp' LIMIT 1")
    .bind(originatorPairingId)
    .first<{ tenant_id: string }>();
  if (originator === null || originator.tenant_id !== row.tenant_id) return null;
  let parsedCaps: unknown;
  try {
    parsedCaps = JSON.parse(row.caps);
  } catch {
    return null; // a malformed config is unusable — fail closed
  }
  const config = WebhookConfig.safeParse(parsedCaps);
  if (!config.success) return null;
  return {
    id: row.id,
    originatorPairingId,
    tenantId: row.tenant_id,
    url: config.data.url,
    secretRef: row.secret_ref,
    events: config.data.events ?? TERMINAL_WEBHOOK_KINDS,
  };
}

// ── the terminal event + the counterparty-safe payload ───────────────────────────────────────────────────────
/** A terminal event as the (injected) event source yields it — carrying its ORIGINATOR pairing for routing. The
 *  `originatorPairing` is used ONLY to select the subscription; it NEVER rides the delivered payload (REQ-192). */
export interface TerminalEvent {
  id: string;
  kind: string;
  shipmentId: string;
  /** Event timestamp (ms epoch). */
  ts: number;
  /** refs.pairing — the shipment originator; the routing key, never a payload field. */
  originatorPairing: string;
}

/** THE counterparty-safe projection (REQ-192) — the ONLY fields that ever leave. No internal field can appear
 *  here: the shape is a fixed whitelist, built field-by-field from the event, never a spread of the raw event. */
export interface WebhookPayload {
  /** The event id (the delivery is keyed off this for idempotency). */
  id: string;
  /** The terminal event kind (one of TERMINAL_WEBHOOK_KINDS). */
  type: string;
  /** The shipment the milestone occurred on. */
  shipment_id: string;
  /** When it occurred (ms epoch). */
  occurred_at: number;
}

/** Build the safe payload from a terminal event. A fixed whitelist — refs/hash/payload/actor never appear. */
export function buildWebhookPayload(event: TerminalEvent): WebhookPayload {
  return { id: event.id, type: event.kind, shipment_id: event.shipmentId, occurred_at: event.ts };
}

// ── svix-style HMAC-SHA256 signing + verification ────────────────────────────────────────────────────────────
// Header names mirror the svix/Standard-Webhooks convention so an off-the-shelf receiver library can verify.
export const WEBHOOK_ID_HEADER = "webhook-id";
export const WEBHOOK_TIMESTAMP_HEADER = "webhook-timestamp";
export const WEBHOOK_SIGNATURE_HEADER = "webhook-signature";

// The signed content is `${id}.${timestamp}.${body}` (Standard Webhooks). The secret string is used as the raw
// HMAC key bytes (the same raw-secret treatment as the translator's inbound HMAC — repo precedent).
function signedContent(id: string, timestamp: string, body: string): string {
  return `${id}.${timestamp}.${body}`;
}

async function hmacBase64(secret: string, content: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(content));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

// Constant-time-ish compare (length gate + full sweep, never short-circuit) — no timing side channel on the MAC.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The signed request: the serialized safe body + the three signature headers. `body` is what MUST be sent on
 *  the wire verbatim (the signature is over these exact bytes; re-serializing differently would break it). */
export interface SignedWebhook {
  body: string;
  headers: Record<string, string>;
}

/** Sign a safe payload for delivery. `msgId` uniquely names the message (the event id); `timestampSec` is the
 *  send time (unix seconds, injected for determinism in tests). The signature header is `v1,<base64>`. */
export async function signWebhook(secret: string, payload: WebhookPayload, msgId: string, timestampSec: number): Promise<SignedWebhook> {
  const body = JSON.stringify(payload);
  const ts = String(timestampSec);
  const sig = await hmacBase64(secret, signedContent(msgId, ts, body));
  return {
    body,
    headers: {
      "content-type": "application/json",
      [WEBHOOK_ID_HEADER]: msgId,
      [WEBHOOK_TIMESTAMP_HEADER]: ts,
      [WEBHOOK_SIGNATURE_HEADER]: `v1,${sig}`,
    },
  };
}

/**
 * Verify a received webhook (the RECEIVER side of the contract — exercised by the test to prove authenticity).
 * Recomputes the MAC over the exact `${id}.${timestamp}.${rawBody}` and compares constant-time. A tampered body,
 * a tampered signature, a wrong secret, or a missing header all return false. Multiple space-separated `v1,`
 * signatures are supported (svix key-rotation form); ANY match verifies.
 */
export async function verifyWebhook(secret: string, headers: Record<string, string | null>, rawBody: string): Promise<boolean> {
  const get = (name: string): string | null => headers[name] ?? headers[name.toLowerCase()] ?? null;
  const id = get(WEBHOOK_ID_HEADER);
  const ts = get(WEBHOOK_TIMESTAMP_HEADER);
  const sigHeader = get(WEBHOOK_SIGNATURE_HEADER);
  if (id === null || ts === null || sigHeader === null) return false;
  const expected = await hmacBase64(secret, signedContent(id, ts, rawBody));
  for (const token of sigHeader.split(" ")) {
    const [version, value] = token.split(",");
    if (version === "v1" && value !== undefined && timingSafeEqual(value, expected)) return true;
  }
  return false;
}

// ── the injected delivery ports (all fail-closed defaults) ───────────────────────────────────────────────────
/** The outbound HTTP port — POSTs the signed webhook. Injected so tests record delivery + so production can bind
 *  a real/fail-closed transport without this module ever calling `fetch` directly. */
export interface WebhookTransport {
  send(url: string, headers: Record<string, string>, body: string): Promise<{ ok: boolean; status: number }>;
}

/** Fail-closed default: never delivers (throws). The symmetric twin of the translator's NotConfiguredTransport —
 *  the delivery LOGIC ships tested via an injected transport; going live is a config flip, not code. */
export class NotConfiguredWebhookTransport implements WebhookTransport {
  async send(_url: string, _headers: Record<string, string>, _body: string): Promise<{ ok: boolean; status: number }> {
    void _url;
    void _headers;
    void _body;
    throw new Error("webhook transport not configured — outbound delivery is fail-closed until wired");
  }
}

/** The idempotency marker store: PRESENCE of a per-event marker means "already delivered". KV-backed in prod. */
export interface DeliveryMarkers {
  has(key: string): Promise<boolean>;
  mark(key: string): Promise<void>;
}

/** The KV-backed marker store (production). Mark-on-success only; a marker's presence is the "delivered" record —
 *  no new table (budget-safe), mirroring the translator's R2 sent-marker. */
export class KvDeliveryMarkers implements DeliveryMarkers {
  constructor(private readonly kv: KVNamespace) {}
  async has(key: string): Promise<boolean> {
    return (await this.kv.get(key)) !== null;
  }
  async mark(key: string): Promise<void> {
    await this.kv.put(key, "1");
  }
}

/** The (go-live) source of NEW terminal events to deliver, each tagged with its originator pairing. */
export interface WebhookEventSource {
  recentTerminalEvents(): Promise<TerminalEvent[]>;
}

/** Fail-closed default: yields NOTHING, so the production cron is a safe no-op until the live ledger/queue feed
 *  is wired (documented go-live item — the mcp worker has no tenant-wide terminal-event read today). */
export class NotConfiguredEventSource implements WebhookEventSource {
  async recentTerminalEvents(): Promise<TerminalEvent[]> {
    return [];
  }
}

/** The per-event idempotency marker key: scoped by the subscription + the event id (never the bare event id, so
 *  two subscriptions to the same event each deliver once). */
export function deliveryMarkerKey(subId: string, eventId: string): string {
  return `whmark:${subId}:${eventId}`;
}

/** The ports a delivery/sweep needs — every one injected (composition root selects live ones; tests inject fakes). */
export interface WebhookDeps {
  secrets: SecretResolver;
  transport: WebhookTransport;
  markers: DeliveryMarkers;
  eventSource: WebhookEventSource;
  /** Resolve the subscription for an originator pairing (defaults to resolveWebhookSubscription over CONTROL_DB). */
  resolveSubscription: (originatorPairingId: string) => Promise<WebhookSubscription | null>;
  /** The send clock (unix-seconds source for the signature timestamp) — injected for deterministic test sigs. */
  now: () => number;
}

export type DeliveryOutcome = "delivered" | "already" | "skipped-no-secret" | "skipped-kind";

/**
 * Deliver ONE terminal event to a subscription, exactly once PER SEQUENTIAL RE-RUN. Fail-closed at every step:
 *   · the event's kind is not in the subscription's allow-list → "skipped-kind" (nothing sent).
 *   · the signing secret does not resolve (NotConfiguredSecretResolver, or an unbound ref) → "skipped-no-secret"
 *     (NOTHING is POSTed — no unsigned/unauthenticated request ever leaves).
 *   · the per-event marker already exists → "already" (no re-delivery — idempotent).
 * Otherwise: sign the safe payload, POST it, and mark delivered ONLY on a successful send (a failed send leaves
 * no marker, so the next tick re-attempts — never a phantom "delivered").
 *
 * NOT EXACTLY-ONCE ACROSS OVERLAPPING CRON TICKS (audit §236). The marker is a presence CHECK, not a CLAIM,
 * and Cloudflare gives `scheduled()` no mutual exclusion — a five-minute tick that outruns its own interval
 * overlaps the next, both see the marker absent, and both POST. MEASURED at 2 deliveries by driving two
 * sweeps concurrently. NOTE the probe result depends on the marker store's latency: with the in-memory test
 * fake it reports a FALSE 1, because a `Map` resolves in a microtask; production is KV over the network, and
 * making the fake await a macrotask reproduces the double-POST.
 *
 * This is the ORDINARY webhook contract (at-least-once; the payload carries an event id, so a consumer can
 * dedupe) and it is dormant regardless — NotConfiguredWebhookTransport refuses to deliver by construction.
 * Wiring a real transport is what activates it: either document at-least-once to subscribers, or claim
 * before POSTing. Proposed, unregistered scope (audit §236).
 */
export async function deliverWebhook(deps: WebhookDeps, sub: WebhookSubscription, event: TerminalEvent): Promise<DeliveryOutcome> {
  if (!isTerminalKind(event.kind) || !sub.events.includes(event.kind)) return "skipped-kind";

  // FAIL-CLOSED: resolve the signing secret FIRST. No secret ⇒ no signature ⇒ we send NOTHING (an unsigned POST
  // would be unverifiable by the receiver and is exactly what the fail-closed gate must prevent).
  const secret = await deps.secrets.resolve(sub.secretRef);
  if (secret === null) return "skipped-no-secret";

  const markerKey = deliveryMarkerKey(sub.id, event.id);
  if (await deps.markers.has(markerKey)) return "already";

  const payload = buildWebhookPayload(event);
  const signed = await signWebhook(secret, payload, event.id, Math.floor(deps.now() / 1000));
  const res = await deps.transport.send(sub.url, signed.headers, signed.body);
  if (!res.ok) {
    // A non-2xx receiver response leaves NO marker — the next tick retries. Throw so the sweep's per-item
    // isolation logs it (and a single failing subscriber never stalls the rest).
    throw new Error(`webhook delivery to ${sub.url} failed: ${res.status}`);
  }
  await deps.markers.mark(markerKey); // mark-on-success — the idempotency record
  return "delivered";
}

export interface WebhookSweepSummary {
  scanned: number;
  delivered: number;
  already: number;
  skipped: number;
  failed: number;
}

/**
 * THE DELIVERY SWEEP (the `scheduled` cron body). Pulls NEW terminal events from the injected source, routes each
 * to the ORIGINATOR pairing's subscription (refs.pairing), and delivers-once. Per-event fault isolation (log +
 * continue) so one failing subscriber never stalls the tick; the whole sweep is idempotent (safe every tick).
 *
 * With the DEFAULT NotConfiguredEventSource the source yields [] and this is a no-op — the live event feed is the
 * documented go-live item. With the DEFAULT NotConfiguredSecretResolver / no subscription, delivery is fail-closed.
 */
export async function runWebhookSweep(deps: WebhookDeps): Promise<WebhookSweepSummary> {
  const summary: WebhookSweepSummary = { scanned: 0, delivered: 0, already: 0, skipped: 0, failed: 0 };
  const events = await deps.eventSource.recentTerminalEvents();
  for (const event of events) {
    summary.scanned += 1;
    try {
      const sub = await deps.resolveSubscription(event.originatorPairing);
      if (sub === null) {
        summary.skipped += 1; // no active subscription for this originator — fail-closed, nothing delivered
        continue;
      }
      const outcome = await deliverWebhook(deps, sub, event);
      if (outcome === "delivered") summary.delivered += 1;
      else if (outcome === "already") summary.already += 1;
      else summary.skipped += 1;
    } catch (err) {
      summary.failed += 1;
      console.error(`webhook-sweep: event ${event.id} — delivery failed (retry next tick):`, err);
    }
  }
  return summary;
}

// ── the composition root (production defaults — every seam fail-closed until wired) ──────────────────────────
/**
 * Assemble the production webhook deps. The transport + event source are fail-closed defaults (nothing delivers
 * until they are wired — a go-live config flip, not code); the secret resolver is the SAME NotConfigured default
 * the OAuth/principal layer uses; the marker store rides the grants KV under the `whmark:` prefix (a benign
 * idempotency marker, never a grant). Subscriptions are read from the control plane (auth/config only, REQ-025).
 */
export function webhookDepsFor(env: Env): WebhookDeps {
  return {
    secrets: new NotConfiguredSecretResolver(),
    transport: new NotConfiguredWebhookTransport(),
    markers: new KvDeliveryMarkers(env.GRANTS),
    eventSource: new NotConfiguredEventSource(),
    resolveSubscription: (originatorPairingId) => resolveWebhookSubscription(env.CONTROL_DB, originatorPairingId),
    now: () => Date.now(),
  };
}
