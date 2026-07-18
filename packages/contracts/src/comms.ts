import { z } from "zod";
import { Bps } from "./money.js";
import { SafeInt } from "./json.js";
import { RateRequestPayload } from "./rating.js";

// WP-07 Concierge (REQ-026/093/099): typed payloads for the comms + quote-lifecycle kinds. These give the
// EXISTING kinds message.received / message.sent / quote.requested / quote.sent / quote.accepted a proper
// Zod shape (they were name-only JsonObject) so the inbound-email → parse → Rater → auto-reply loop can carry
// channel / direction / refs / intent / confidence THROUGH the append-only ledger. NO kind is added — the
// 35-catalog is unchanged (events.ts pins .length === 35). Organized as its own domain module and imported by
// events.ts, mirroring money.ts. quote.priced stays where it is (already typed); quote.expired +
// call.transcribed stay loose (voice/expiry deferred). Integer-only canonical law applies (SafeInt/Bps).

// The delivery channel. EXACT match to the D1 messages.channel CHECK IN ('email','sms','voice','portal',
// 'note') (db/tenant/migrations/0002_domain.sql) so Task 2's projection maps this verbatim into the row.
export const MessageChannel = z.enum(["email", "sms", "voice", "portal", "note"]);
export type MessageChannel = z.infer<typeof MessageChannel>;

// The intent the parser resolved for an inbound message — steers the Concierge routing (quote → Rater,
// status/claim → the right queue). "unknown" is an explicit low-confidence bucket, never a silent drop.
export const MessageIntent = z.enum(["quote", "status", "claim", "unknown"]);
export type MessageIntent = z.infer<typeof MessageIntent>;

// message.received — an inbound message. `from_ref` is the sender handle (email address / phone / party ref);
// `body_ref` is the R2 pointer to the stored raw body (the ledger carries the reference, never the bytes,
// mirroring evidence-at-capture). `thread` groups a conversation (maps to messages.thread). `parse_confidence`
// is the parser's confidence the intent is right (Bps, 0..10000) — distinct from the envelope `confidence`.
//
// INTERIM INLINE PARSE SOURCE (WP-07 Concierge, REQ-026/093): `subject`/`body` are the OPTIONAL de-MIME'd
// text the inbound-ingestion leg may attach so the Concierge can parse the email WITHOUT an R2 fetch until
// the R2 body-resolver lands (a later WP). `body_ref` stays the durable pointer — the ledger still carries
// the ref, not the bytes; once the resolver reads bytes by ref these become unnecessary. They are inert to
// the messages projection (which reads only channel/thread/body_ref) and, being absent on every existing
// fixture, leave the frozen canonical bytes of prior events unchanged.
//
// BOUNDED (REQ-010 canonical hash): these ride INLINE in the event and so in its canonical-JSON hash + the
// daily Merkle anchor, which would defeat "the ledger carries the ref, never the bytes" for a large body.
// So they are CAPPED — a subject line and a parse-sufficient body prefix. The future inbound-ingestion leg
// MUST truncate-to-`body_ref` past these caps (the full raw body always lives in R2 behind body_ref); the
// C1 corroboration re-parses the SAME bounded bytes, so a truncated body only ever makes a quote LESS likely
// to auto-send (fail-safe), never more.
export const MessageReceivedPayload = z
  .object({
    channel: MessageChannel,
    from_ref: z.string().min(1),
    subject: z.string().max(2_048).optional(), // interim inline parse source (de-MIME'd subject); bounded — see header
    body: z.string().max(32_768).optional(), // interim inline parse source (de-MIME'd body text); bounded — see header
    thread: z.string().min(1).optional(), // present ⇒ non-empty (an empty thread ref is a bug, not a value)
    body_ref: z.string().min(1),
    intent: MessageIntent.optional(),
    parse_confidence: Bps.optional(),
  })
  .strict();
export type MessageReceivedPayload = z.infer<typeof MessageReceivedPayload>;

// message.sent — an outbound message. `to_ref` is the recipient handle; `drafted_by_agent` names the agent
// that composed it (the Concierge auto-reply); `in_reply_to` links the inbound message event this answers.
export const MessageSentPayload = z
  .object({
    channel: MessageChannel,
    to_ref: z.string().min(1),
    thread: z.string().min(1).optional(), // present ⇒ non-empty
    body_ref: z.string().min(1),
    drafted_by_agent: z.string().min(1).optional(), // present ⇒ non-empty (a named agent, never "")
    in_reply_to: z.string().min(1).optional(), // present ⇒ non-empty (a real event id)
    // REQ-059/178 — the resolved honest transit window (business days), PINNED into the reply record at send
    // time so the redelivery fast path re-renders the SAME line from committed events (never a live config
    // re-read that could drift → a 409/spurious-hold). Absent ⇒ the reply omitted the "Estimated transit" line.
    transit_days: SafeInt.optional(),
    // REQ-032/178 (WP-11 Collector human-send) — the tenant "voice" (the config-seeded from-name that signs the
    // dunning body) PINNED into the sent record at send time, so the Collector's approve-and-send FAST PATH
    // re-renders the SAME signature from COMMITTED state — immune to a later from-name config change that would
    // otherwise drift the re-render → a 409 on the send's idempotency key (the exact transit_days lesson).
    // Bounded + React-escaped (body-only). Absent ⇒ an older send (e.g. the Concierge reply re-reads its
    // from-name from the env dep); present only on the Collector's dunning sends. Canonical-hash-safe: an
    // OPTIONAL field, absent on every prior event, so no stored event's frozen bytes change.
    from_name: z.string().min(1).max(200).optional(),
  })
  .strict();
export type MessageSentPayload = z.infer<typeof MessageSentPayload>;

// quote.requested — the request event. Carries the canonical rate request (RateRequestPayload, defined in
// rating.ts — a rate request is a rating concept; the rater aliases its RateRequest to that one type) and,
// when the request arrived over a message, `source_message_event_id` (provenance back to the inbound
// message.received event).
export const QuoteRequestedPayload = z
  .object({
    request: RateRequestPayload,
    source_message_event_id: z.string().min(1).optional(), // present ⇒ non-empty (a real message event id)
  })
  .strict();
export type QuoteRequestedPayload = z.infer<typeof QuoteRequestedPayload>;

// quote.sent — the quote was delivered. Links the priced quote event, the recipient, and the outbound
// message event that carried it (so the sent quote is traceable to both the price and the comms leg).
export const QuoteSentPayload = z
  .object({
    quote_event_id: z.string().min(1),
    to_ref: z.string().min(1),
    message_event_id: z.string().min(1),
  })
  .strict();
export type QuoteSentPayload = z.infer<typeof QuoteSentPayload>;

// quote.accepted — the counterparty accepted a quote; names the quote event accepted (the Booking agent's
// trigger downstream).
export const QuoteAcceptedPayload = z
  .object({ quote_event_id: z.string().min(1) })
  .strict();
export type QuoteAcceptedPayload = z.infer<typeof QuoteAcceptedPayload>;
