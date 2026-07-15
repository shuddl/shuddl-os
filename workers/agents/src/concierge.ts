// WP-07 — THE CONCIERGE CONSUMER (REQ-026 / REQ-093 / REQ-100). The Biller's sibling: a committed
// `message.received` triggers this consumer, which RESOLVES the inbound to a Party + Shipment (Task 4,
// pure over a ResolvePort), PRICES + DECIDES (Task 5 composeConcierge — auto_reply | queued), and then:
//   · auto_reply → appends quote.requested + quote.priced + message.sent THROUGH the sequencer DO, then
//     SENDS the reply via the EvidenceSender port;
//   · queued(reason) → appends quote.requested (the request is real, a human prices/answers it) + records
//     an internal DRAFT `messages` row (drafted_by_agent) — it does NOT send.
//
// LAWS THIS MODULE ENFORCES (carried from Tasks 4-5, review-mandated):
//   · IDEMPOTENCY (Task-4 I-1). Cloudflare Queues is at-least-once. BEFORE any resolve/create, skip if a
//     `quote.requested` carrying this message's id (`source_message_event_id`) already exists → the outcome
//     is `already_handled`. Belt-and-suspenders on top: the shipment/party ids AND every appended event id
//     are DETERMINISTICALLY derived from the message event id (no Date, no random), the sequencer dedupes
//     by event id, party/shipment INSERTs are `OR IGNORE`, and the sender dedupes by
//     `concierge-reply/<message.sent id>`. So even a redelivery in the create→append window reproduces the
//     SAME facts — twice in = once out.
//   · ATOMICITY / ORPHAN (Task-4 I-3). resolve does the direct party/shipment INSERTs (via the port) and
//     THEN we append `quote.requested` carrying `source_message_event_id`, so any orphan shipment (INSERT
//     landed, append lost) is correlatable and the redelivery completes it.
//   · AUTO-SEND ONLY VIA COMPOSE. Only `composeConcierge → status:"auto_reply"` sends. `queued` NEVER sends
//     — it records a draft for a human. The floor + corroboration + resolution gates already live in
//     compose (REQ-026/040/093); this consumer does NOT re-decide them.
//   · NO COMMS OUTSIDE THE LEDGER (REQ-100). The reply that IS sent gets a `message.sent` event appended
//     FIRST (the send references it via the idempotency key). A send failure NEVER unwinds the ledger facts
//     (the Biller law): a permanent SendError holds (send-pending outcome); a retriable one THROWS so the
//     queue redelivers (the appends + send are idempotent, so re-driving is safe).
//   · REQ-024. The LLM lives ONLY in the injected parse port (packages/agents); this consumer selects the
//     adapter at the composition root (NotConfiguredParser by default, ClaudeParser iff a key+model is
//     bound), exactly like the Biller's evidenceSender(). The consumer itself calls no LLM.

import { z } from "@shuddl/contracts";
import type { LedgerEvent, MessageReceivedPayload } from "@shuddl/contracts";
import { rowToEvent } from "@shuddl/ledger/lens";
import { resolveConcierge, composeConcierge, renderQuoteReply, SendError } from "@shuddl/agents";
import type {
  ConciergeParser,
  EvidenceMessage,
  EvidenceSender,
  InboundEmail,
  PartyKind,
  ResolvePort,
} from "@shuddl/agents";
import { loadTenantRatingConfig } from "./rate-config.js";
import type { SeqStubLike } from "./biller.js";

// ---- the queue payload (Zod at the boundary; the producer is the sequencer DO) ----------------------
// `shipment_id` is OPTIONAL: a fresh quote email arrives on a non-shipment stream (no shipment yet — the
// Concierge CREATES one), so the consumer locates the trigger event by its globally-unique id, never by a
// stream it may not know. When the inbound already sits on a shipment stream the DO forwards its id here.
export const MessageReceivedTrigger = z
  .object({
    kind: z.literal("message.received"),
    tenant: z.string().min(1),
    shipment_id: z.string().min(1).optional(),
    event_id: z.string().min(1),
  })
  .strict();
export type MessageReceivedTrigger = z.infer<typeof MessageReceivedTrigger>;

// ---- deps ------------------------------------------------------------------------------------------
export interface ConciergeDeps {
  /** The message tenant's OWN D1 (the caller resolves it via the tenant allowlist — REQ-025). */
  db: D1Database;
  /** The sequencer DO append surface (the ONLY write path — I2/visibility/projections run there). */
  seq: SeqStubLike;
  /** The reply-send port (RecordingSender in tests; Resend/NotConfigured at the composition root). */
  sender: EvidenceSender;
  /** The parse port (REQ-024) — Deterministic in tests; Claude/NotConfigured at the composition root. */
  parser: ConciergeParser;
  /** REQ-098 tenant voice — the config-seeded from-name that signs the reply (bounded, never model output). */
  tenantFromName: string;
}

// ---- outcome ---------------------------------------------------------------------------------------
export type ConciergeOutcome =
  | {
      status: "issued_replied";
      shipment_id: string;
      party_id: string;
      party_created: boolean;
      quote_requested_event_id: string;
      quote_priced_event_id: string;
      message_sent_event_id: string;
      provider: string;
      provider_id: string;
    }
  | {
      status: "issued_send_pending";
      shipment_id: string;
      party_id: string;
      quote_requested_event_id: string;
      quote_priced_event_id: string;
      message_sent_event_id: string;
      reason: "send_failed";
      detail: string;
    }
  | {
      status: "queued";
      shipment_id: string;
      party_id: string;
      quote_requested_event_id: string;
      reason: "below_floor" | "not_corroborated" | "unknown_price" | "low_resolution";
      detail: string;
    }
  | { status: "unresolved"; reason: "not_quote_intent" | "no_party_signal" | "no_request" | "low_confidence"; detail: string }
  | { status: "already_handled"; detail: string }
  | { status: "skipped"; reason: "message_not_found"; detail: string };

// ---- deterministic ids (no Date, no random — redelivery must reproduce them exactly) ----------------
async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A domain-separated SHA-256 of the message event id, shaped into a v4-variant UUID so it satisfies
// EventInput's z.string().uuid() — the same shaping rate.ts/biller.ts use. The sequencer dedupes by this
// id, so a redelivered message returns the ORIGINAL event, never a second.
async function conciergeEventId(domain: string, messageEventId: string): Promise<string> {
  const h = (await sha256Hex(`concierge:${domain}:${messageEventId}`)).slice(0, 32);
  const variant = ((parseInt(h.slice(16, 17) || "0", 16) & 0x3) | 0x8).toString(16); // 8/9/a/b
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// The created shipment id (word-chars only ⇒ a valid `s:<id>` stream). Deterministic from the message id so
// redelivery reproduces it and the INSERT OR IGNORE is a no-op.
async function shipmentIdFor(messageEventId: string): Promise<string> {
  return `shp_${(await sha256Hex(`concierge:shipment:${messageEventId}`)).slice(0, 16)}`;
}

// A created party's id — deterministic from the requester email so re-creation is stable.
async function partyIdFor(email: string): Promise<string> {
  return `party_${(await sha256Hex(`concierge:party:${email}`)).slice(0, 16)}`;
}

// ---- SLA timers on an inbound OWED a reply but NOT auto-answered (Task 8, REQ-095) -------------------
// The first-response window. A SINGLE DOCUMENTED DEFAULT until a per-tenant SLA-config source exists — NO
// config table/kind is invented here (that per-tenant override is a later-WP obligation, doc 02 §6). 4h:
// a freight-brokerage first-response norm — long enough to absorb ordinary handling latency, short enough
// that a quote request left unworked surfaces the SAME business day (before a competitor's quote wins the
// load). If a tenant SLA-config kind lands later, resolve this per-tenant and keep this the fallback.
export const SLA_REPLY_WINDOW_MS = 4 * 60 * 60 * 1000; // 14_400_000

// Set the first-response SLA on the inbound's OWN messages row (msg:<event id>, direction 'in'). `messages`
// is a MUTABLE read-model with no append-only guard (projection/messages.ts), so this UPDATE is legal — it
// is the resolution write that projection deliberately left NULL at receipt (sla_due_ts is Task 8's column).
// DETERMINISTIC: the due ts is `recorded_at + WINDOW` off the EVENT's recorded_at (never a fresh clock), so a
// redelivery re-computes the IDENTICAL value — re-setting is an exact no-op. Called ONLY on the queued paths
// (a human owns the reply); the auto_reply path answered instantly and sets nothing.
async function setInboundSla(db: D1Database, inboundEventId: string, recordedAt: number): Promise<void> {
  await db
    .prepare("UPDATE messages SET sla_due_ts = ?1 WHERE id = ?2 AND direction = 'in'")
    .bind(recordedAt + SLA_REPLY_WINDOW_MS, `msg:${inboundEventId}`)
    .run();
}

// The tenant's effective rating config is loaded via the SHARED mirror (workers/agents/src/rate-config.ts,
// a byte-identical copy of workers/api/src/rate-config.ts guarded by test/rate-config-parity.test.ts). The
// agents worker does not depend on @shuddl/api, so the file is duplicated rather than imported — but the
// parity test fails CI on any drift, closing the "a fix to one loader silently mis-prices the other" gap.

// ---- record loading --------------------------------------------------------------------------------
type SqlRow = Record<string, string | number | null>;

// An event by its globally-unique id + kind (the consumer may not know the stream). A missing row on the
// trigger is POISON (redelivery cannot conjure it → skip); on the redelivery guards it means "not yet".
async function loadEventById(db: D1Database, eventId: string, kind: string): Promise<LedgerEvent | null> {
  const row = await db.prepare("SELECT * FROM events WHERE id = ? AND kind = ?").bind(eventId, kind).first<SqlRow>();
  return row === null ? null : rowToEvent(row);
}

// A recipient safe to interpolate into a mail send — a plausible address, never a header-injection vector.
// The send port's schema ALSO rejects CR/LF, but as a ZodError (not a SendError); we pre-check here so an
// undeliverable recipient HOLDS deterministically instead of throwing a non-retriable ZodError into a
// redelivery loop (Biller `plausibleEmail` parity).
function mailSafe(to: string): boolean {
  return to.includes("@") && !/[\r\n]/.test(to);
}

// ---- the tenant-scoped ResolvePort over D1 (REQ-025 — bound to ONE tenant's db) ---------------------
// findPartyByEmail matches an `email` inside any party's `contacts` JSON array (the same json_each shape the
// sequencer uses for device keys, and the honest email-bearing column the Biller reads). createParty writes
// the requester as a `shipper` with a primary contact; createShipment writes a quote-stage shipment with the
// consumer-supplied created_ts (the pure resolve module has no clock — that is this port's job).
function makeResolvePort(db: D1Database, messageEventId: string, createdTs: number): ResolvePort {
  return {
    findPartyByEmail: async (email) => {
      const row = await db
        .prepare("SELECT p.id AS id FROM parties p, json_each(p.contacts) je WHERE json_extract(je.value, '$.email') = ?1 LIMIT 1")
        .bind(email)
        .first<{ id: string }>();
      return row === null ? null : { id: row.id };
    },
    createParty: async (p: { kind: PartyKind; email: string; name?: string }) => {
      const id = await partyIdFor(p.email);
      const names = JSON.stringify(p.name !== undefined && p.name !== "" ? { legal: p.name } : {});
      const contacts = JSON.stringify([{ kind: "primary", email: p.email }]);
      await db
        .prepare("INSERT OR IGNORE INTO parties (id, kind, names, contacts) VALUES (?,?,?,?)")
        .bind(id, p.kind, names, contacts)
        .run();
      return { id };
    },
    createShipment: async (s) => {
      const id = await shipmentIdFor(messageEventId);
      await db
        .prepare(
          "INSERT OR IGNORE INTO shipments (id, shipper_party_id, consignee_party_id, bill_to_party_id, refs, created_ts) VALUES (?,?,?,?,?,?)",
        )
        .bind(id, s.shipper_party_id, s.consignee_party_id, s.bill_to_party_id, s.refs, createdTs)
        .run();
      return { id };
    },
  };
}

// ---- the consumer ------------------------------------------------------------------------------------
export async function handleMessageReceived(message: MessageReceivedTrigger, deps: ConciergeDeps): Promise<ConciergeOutcome> {
  const msg = MessageReceivedTrigger.parse(message); // Zod at the boundary even when the caller pre-parsed
  const { db, seq, sender, parser, tenantFromName } = deps;

  // GUARD 1 — the trigger event must exist as a message.received on this tenant's ledger. A message that
  // references a nonexistent/foreign event is POISON: skip (non-retriable), never append.
  const inbound = await loadEventById(db, msg.event_id, "message.received");
  if (inbound === null || inbound.kind !== "message.received") {
    return { status: "skipped", reason: "message_not_found", detail: `message.received ${msg.event_id} not on tenant ${msg.tenant} — poison message` };
  }

  // The deterministic ids — the shipment id + every appended event id derive from the message event id (no
  // Date, no random), so a redelivery reproduces them EXACTLY. Computed once, up front, for the redelivery
  // fast/queued guards below AND the fresh flow.
  const shipmentId = await shipmentIdFor(msg.event_id);
  const quoteRequestedEventId = await conciergeEventId("quote-requested", msg.event_id);
  const quotePricedEventId = await conciergeEventId("quote-priced", msg.event_id);
  const messageSentEventId = await conciergeEventId("message-sent", msg.event_id);

  // REDELIVERY FAST PATH (mirror the Biller, REQ-100). If this inbound's auto-reply message.sent ALREADY
  // committed, compose + every gate ran and PASSED when it did; a redelivery goes STRAIGHT to the send,
  // re-derived from the committed events (re-send is dedupe-safe via the idempotency key). We do NOT re-parse
  // (no repeat LLM call, no model drift), re-resolve, or re-judge — re-judging under context drift could flip
  // a decision. THIS is what lets a retriable send THROW below and self-heal on redelivery (a transient blip
  // no longer silently loses the customer's quote — the C1 fix).
  const sentEvent = await loadEventById(db, messageSentEventId, "message.sent");
  if (sentEvent !== null) {
    return resendCommittedReply(db, sender, tenantFromName, shipmentId, sentEvent, { quoteRequestedEventId, quotePricedEventId, messageSentEventId });
  }

  // REDELIVERY (QUEUED). A quote.requested exists but NO message.sent ⇒ this inbound was already DECIDED as
  // queued (a human owns it) — there is nothing to auto-send. Return already_handled (no re-parse/re-judge).
  // Both this and the fast path are PRIMARY-KEY lookups on deterministic ids — no json_extract table scan (I1).
  // KNOWN GAP (WP-11 reconciliation sweep, same class as REQ-169's Biller commit→enqueue window): if a FRESH
  // auto-reply died AFTER appending quote.requested but BEFORE message.sent, this guard also returns
  // already_handled, so that reply never completes. The sweep detects it structurally (quote.priced present,
  // message.sent absent, no draft row ⇒ an unfinished auto-reply) and re-drives it; the send stays idempotent.
  if ((await loadEventById(db, quoteRequestedEventId, "quote.requested")) !== null) {
    return { status: "already_handled", detail: `quote.requested already recorded (queued) for message ${msg.event_id}` };
  }

  // ── FRESH ─────────────────────────────────────────────────────────────────────────────────────────────
  const payload: MessageReceivedPayload = inbound.payload;
  // The raw email the parser reads. `subject`/`body` are the interim inline parse source (see comms.ts);
  // absent ⇒ empty text, which the parser turns into an UNKNOWN/unresolved outcome (a documented gap, never
  // a crash) until the R2 body-resolver lands.
  const email: InboundEmail = { from: payload.from_ref, subject: payload.subject ?? "", body: payload.body ?? "" };

  // PARSE (REQ-024) — the ONLY LLM seam, injected. A NotConfigured/network/5xx failure THROWS (retriable via
  // the parse port) and the queue redelivers; we deliberately do NOT catch it here (the send-port law).
  const parse = await parser.parse(email);

  // RESOLVE (REQ-093) — tie the inbound to a Party + Shipment, or explain why it can't. The port does the
  // direct party/shipment INSERTs; the appended quote.requested (below) carries the provenance link. The
  // returned shipment_id equals the precomputed `shipmentId` above (same derivation from msg.event_id).
  const port = makeResolvePort(db, msg.event_id, inbound.recorded_at);
  const resolved = await resolveConcierge(parse, port, msg.event_id);
  if (resolved.status === "unresolved") {
    // No shipment/party created, nothing quoted or sent. The outcome is the loud log until WP-11's queue.
    return { status: "unresolved", reason: resolved.reason, detail: `message ${msg.event_id} unresolved: ${resolved.reason}` };
  }

  const streamId = `s:${resolved.shipment_id}`;

  // PRICE → DECIDE (REQ-026/093/098). No tariff ⇒ can't auto-price: record the request + a draft, queue it.
  const ratingConfig = await loadTenantRatingConfig(db, inbound.recorded_at);
  if (ratingConfig === null) {
    // Owed a reply, not auto-answered → SET the SLA FIRST (before the appends). If a crash lands between
    // the quote.requested append and here, the redelivery guard returns already_handled — so setting the
    // SLA before the append guarantees an owed inbound always carries its due ts (deterministic, no-op re-set).
    await setInboundSla(db, msg.event_id, inbound.recorded_at);
    await appendQuoteRequested(seq, msg, streamId, resolved, parse, quoteRequestedEventId, inbound.recorded_at);
    await recordDraft(db, msg.event_id, resolved, payload.thread);
    return { status: "queued", shipment_id: resolved.shipment_id, party_id: resolved.party_id, quote_requested_event_id: quoteRequestedEventId, reason: "unknown_price", detail: `no rate_config in effect for tenant ${msg.tenant} — queued for a human` };
  }

  const decision = await composeConcierge({
    parse,
    email,
    resolved: { party_id: resolved.party_id, shipment_id: resolved.shipment_id, resolution_confidence: resolved.resolution_confidence },
    ratingConfig,
    tenantFromName,
  });

  // QUEUED — the gates in compose held (below_floor / not_corroborated / unknown_price / low_resolution). We
  // still RECORD the request (it is real; a human prices/answers it) + a DRAFT `messages` row, but NEVER send.
  if (decision.status === "queued") {
    // Owed a reply, not auto-answered → SET the SLA FIRST (see the unknown_price branch above for why order matters).
    await setInboundSla(db, msg.event_id, inbound.recorded_at);
    await appendQuoteRequested(seq, msg, streamId, resolved, parse, quoteRequestedEventId, inbound.recorded_at);
    await recordDraft(db, msg.event_id, resolved, payload.thread);
    return {
      status: "queued",
      shipment_id: resolved.shipment_id,
      party_id: resolved.party_id,
      quote_requested_event_id: quoteRequestedEventId,
      reason: decision.reason,
      detail: `message ${msg.event_id} composed but held: ${decision.reason} (no reply sent)`,
    };
  }

  // AUTO-REPLY — every gate passed. Append the ledger facts FIRST (quote.requested → quote.priced →
  // message.sent), THEN send. The reply's send references the message.sent event id (REQ-100).
  await appendQuoteRequested(seq, msg, streamId, resolved, parse, quoteRequestedEventId, inbound.recorded_at);

  await seq.append({
    tenant: msg.tenant,
    streamId,
    input: {
      id: quotePricedEventId,
      shipment_id: resolved.shipment_id,
      ts: inbound.recorded_at, // the inbound's commit instant this quote projects from — deterministic
      actor: { party: "agent:concierge" },
      party_refs: [resolved.party_id],
      evidence: [],
      source: "native",
      confidence: 10_000,
      kind: "quote.priced",
      payload: decision.quote_priced,
    },
  });

  const idempotencyKey = `concierge-reply/${messageSentEventId}`;
  // I2 — the reply recipient is the AUTHENTICATED envelope sender (`from_ref`), NEVER the model's
  // `party_hint.email`. That hint is model output over an untrusted body: a crafted email could steer it to
  // an arbitrary third party and the auto-reply would spray the tenant's firm-priced quote — from its
  // verified sending domain — at that address (a quote-spam relay on the tenant's reputation). The
  // deterministic parser's hint IS `from_ref` anyway; only the LLM's could diverge.
  const toRef = payload.from_ref;
  await seq.append({
    tenant: msg.tenant,
    streamId,
    input: {
      id: messageSentEventId,
      shipment_id: resolved.shipment_id,
      ts: inbound.recorded_at,
      actor: { party: "agent:concierge" },
      party_refs: [resolved.party_id],
      evidence: [],
      source: "native",
      confidence: 10_000,
      kind: "message.sent",
      payload: {
        channel: "email",
        to_ref: toRef,
        body_ref: idempotencyKey, // the durable pointer at the reply body (R2 persistence is a later WP)
        drafted_by_agent: "concierge",
        in_reply_to: msg.event_id,
        ...(payload.thread !== undefined ? { thread: payload.thread } : {}),
      },
    },
  });

  // THE SEND — downstream of the committed facts. A retriable failure THROWS (redelivery re-sends via the
  // fast path above); a permanent one HOLDS. Nothing here unwinds the ledger (REQ-100 / Biller law).
  const sendMsg: EvidenceMessage = {
    channel: "email",
    to: toRef,
    subject: decision.reply.subject,
    html: decision.reply.html,
    shipment_id: resolved.shipment_id,
    idempotency_key: idempotencyKey, // one message.sent event, one reply — dedupe under redelivery
  };
  return sendConciergeReply({
    sender,
    message: sendMsg,
    shipmentId: resolved.shipment_id,
    partyId: resolved.party_id,
    partyCreated: resolved.party_created,
    quoteRequestedEventId,
    quotePricedEventId,
    messageSentEventId,
  });
}

// ---- the reply-send tail — shared by the fresh auto-reply path and the redelivery fast path -----------
// Everything here is DOWNSTREAM of the committed quote.requested/priced/message.sent: it may complete, hold,
// or throw for redelivery, but it NEVER unwinds those facts (REQ-100 / Biller law).
interface ReplySendCtx {
  sender: EvidenceSender;
  message: EvidenceMessage;
  shipmentId: string;
  partyId: string;
  partyCreated: boolean;
  quoteRequestedEventId: string;
  quotePricedEventId: string;
  messageSentEventId: string;
}

async function sendConciergeReply(cx: ReplySendCtx): Promise<ConciergeOutcome> {
  const { sender, message, shipmentId, partyId, partyCreated, quoteRequestedEventId, quotePricedEventId, messageSentEventId } = cx;
  const pending = (detail: string): ConciergeOutcome => {
    console.error(`concierge: ${detail}`);
    return { status: "issued_send_pending", shipment_id: shipmentId, party_id: partyId, quote_requested_event_id: quoteRequestedEventId, quote_priced_event_id: quotePricedEventId, message_sent_event_id: messageSentEventId, reason: "send_failed", detail };
  };

  // An undeliverable recipient can NEVER succeed (redelivery re-validates the same bytes): HOLD, do not send.
  if (!mailSafe(message.to)) {
    return pending(`concierge reply recipient ${JSON.stringify(message.to)} is not a deliverable email (message.sent ${messageSentEventId}) — held send-pending, ledger facts stand`);
  }
  try {
    const receipt = await sender.send(message);
    return {
      status: "issued_replied",
      shipment_id: shipmentId,
      party_id: partyId,
      party_created: partyCreated,
      quote_requested_event_id: quoteRequestedEventId,
      quote_priced_event_id: quotePricedEventId,
      message_sent_event_id: messageSentEventId,
      provider: receipt.provider,
      provider_id: receipt.provider_id,
    };
  } catch (err) {
    if (err instanceof SendError) {
      // RETRIABLE ⇒ THROW so the queue redelivers; the redelivery FAST PATH re-sends from the committed
      // events (dedupe-safe via the idempotency key). Mirrors the Biller — a transient blip self-heals, and
      // the ledger facts already stand. PERMANENT ⇒ redelivery cannot help; HOLD for a human (WP-11).
      if (err.retriable) throw err;
      return pending(`concierge reply permanently failed for message.sent ${messageSentEventId}: ${err.message} — held send-pending, ledger facts stand`);
    }
    // A non-SendError (an unexpected bug/fault) ⇒ THROW so the queue redelivers and it surfaces loudly.
    throw err;
  }
}

// REDELIVERY FAST PATH body — re-derive the EXACT reply from the committed events (a pure re-render of the
// recorded lane + sell) and re-send under the recorded idempotency key. Byte-identical to the original send,
// so the sender's key-dedupe returns the original receipt when it already went out, or delivers it when a
// prior send failed transiently. No re-parse, no re-judge.
async function resendCommittedReply(
  db: D1Database,
  sender: EvidenceSender,
  tenantFromName: string,
  shipmentId: string,
  sentEvent: LedgerEvent,
  ids: { quoteRequestedEventId: string; quotePricedEventId: string; messageSentEventId: string },
): Promise<ConciergeOutcome> {
  const requested = await loadEventById(db, ids.quoteRequestedEventId, "quote.requested");
  const priced = await loadEventById(db, ids.quotePricedEventId, "quote.priced");
  const sent = sentEvent.payload as { to_ref: string; body_ref: string };
  const partyId = sentEvent.party_refs[0] ?? "";
  if (requested === null || priced === null) {
    // message.sent committed but a preceding quote event is missing — cannot reconstruct the exact payload
    // to re-send safely (a mismatched payload would 409 the idempotency key). Nothing more to auto-do here.
    return { status: "already_handled", detail: `message.sent ${ids.messageSentEventId} committed but quote events missing — no safe re-send` };
  }
  const req = (requested.payload as { request: { origin_zip: string; dest_zip: string } }).request;
  const sell = (priced.payload as { sell: number }).sell;
  const reply = renderQuoteReply({ shipment_ref: shipmentId, lane: { origin_zip: req.origin_zip, dest_zip: req.dest_zip }, sell_cents: sell, tenant_from_name: tenantFromName });
  const message: EvidenceMessage = { channel: "email", to: sent.to_ref, subject: reply.subject, html: reply.html, shipment_id: shipmentId, idempotency_key: sent.body_ref };
  return sendConciergeReply({ sender, message, shipmentId, partyId, partyCreated: false, quoteRequestedEventId: ids.quoteRequestedEventId, quotePricedEventId: ids.quotePricedEventId, messageSentEventId: ids.messageSentEventId });
}

// ---- append helpers ---------------------------------------------------------------------------------
// quote.requested — the request event, carrying the canonical rate request AND source_message_event_id (the
// provenance link the idempotency guard + Task-4 orphan-correlation both key off). Appended on BOTH the
// auto_reply and queued paths (the request is real either way; only the SEND differs).
async function appendQuoteRequested(
  seq: SeqStubLike,
  msg: MessageReceivedTrigger,
  streamId: string,
  resolved: { party_id: string },
  parse: { request?: unknown },
  eventId: string,
  ts: number,
): Promise<void> {
  await seq.append({
    tenant: msg.tenant,
    streamId,
    input: {
      id: eventId,
      shipment_id: streamId.slice(2),
      ts,
      actor: { party: "agent:concierge" },
      party_refs: [resolved.party_id],
      evidence: [],
      source: "native",
      confidence: 10_000,
      kind: "quote.requested",
      payload: { request: parse.request, source_message_event_id: msg.event_id },
    },
  });
}

// The internal DRAFT artifact for a human (queued path). `messages` is a MUTABLE read-model (no append-only
// guard), so a direct INSERT OR IGNORE on a deterministic id is legal + idempotent — and it never clobbers a
// resolution the sequencer's projection already wrote (that path is INSERT OR IGNORE too). NOT a message.sent
// (a draft was never sent — appending message.sent would falsely record a send, REQ-100).
async function recordDraft(
  db: D1Database,
  messageEventId: string,
  resolved: { party_id: string; shipment_id: string; resolution_confidence: number },
  thread: string | undefined,
): Promise<void> {
  await db
    .prepare(
      "INSERT OR IGNORE INTO messages (id, channel, direction, party_id, shipment_id, resolved_conf, thread, body_ref, drafted_by_agent, sla_due_ts) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      `msg:draft:${messageEventId}`,
      "email",
      "out",
      resolved.party_id,
      resolved.shipment_id,
      resolved.resolution_confidence,
      thread ?? null,
      `concierge-draft/${messageEventId}`,
      "concierge",
      null,
    )
    .run();
}
