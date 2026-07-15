import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { rowToEvent } from "@shuddl/ledger/lens";
import type { LedgerEvent } from "@shuddl/contracts";
import { DeterministicParser, RecordingSender, SendError, formatCents } from "@shuddl/agents";
import type { ConciergeParser, EvidenceMessage, EvidenceSender, InboundEmail, ParseResult, SendReceipt } from "@shuddl/agents";
import { handleMessageReceived, MessageReceivedTrigger } from "../../agents/src/concierge.js";
import type { ConciergeDeps } from "../../agents/src/concierge.js";
import type { SeqStubLike } from "../../agents/src/biller.js";
import {
  ANOMALY_RATE_CONFIG,
  TENANT_SLUG,
  TEST_RATE_CONFIG,
  ensureSchema,
  seedRateConfig,
} from "./helpers.js";

// ─── WP-07 — THE CONCIERGE CONSUMER (REQ-026 / REQ-093 / REQ-100) ───────────────────────────────────
//
// The integration proof of the Concierge loop: a committed `message.received` (a real inbound quote
// email, appended THROUGH the real sequencer DO so its `messages` read-model row projects) is handed to
// `handleMessageReceived` — the agents-worker consumer — against the same DO + D1 + a RecordingSender +
// a DeterministicParser. It RESOLVES the inbound to a Party + Shipment, PRICES it through the Rater,
// DECIDES auto_reply | queued, and on auto_reply appends quote.requested + quote.priced + message.sent
// and SENDS the reply.
//
// VENUE (like biller.test.ts): the ShipmentSequencer DO + migrated tenant D1 live only in THIS harness;
// the consumer FUNCTION is imported from the agents worker and driven directly. The queue() shell in
// workers/agents is thin dispatch (pinned by workers/agents/test/queue-dispatch.test.ts).
//
// LAWS UNDER TEST:
//   · REQ-093 — every quotable inbound auto-ties to Party + Shipment; a shaky tie queues.
//   · REQ-026/040 — only a floor-clean, independently-corroborated, resolution-confident quote auto-sends;
//     an anomalous ($222k/1-lb) or uncorroborated quote QUEUES with no reply.
//   · REQ-100 — the reply that IS sent gets a message.sent event appended FIRST; the messages read-model
//     carries the inbound + the sent rows.
//   · Idempotent under queue redelivery: the same message twice → one shipment, one quote.requested, one reply.
//   · A send failure NEVER unwinds the ledger facts (held send-pending).
//
// isolatedStorage is OFF (shared D1): every case scopes to its OWN inbound event id / derived stream.

const TENANT = TENANT_SLUG;
const FROM_NAME = "Shuddl Dispatch"; // REQ-098 tenant voice (config-seeded from-name; REQ-167-clean)

let clock = 1_732_000_000_000;

// ── consumer deps against the REAL DO + D1 (mirrors biller.test) ──────────────────────────────────────
const seqStub: SeqStubLike = {
  append: (req) =>
    (env.SHIPMENT_SEQ.get(env.SHIPMENT_SEQ.idFromName(`${req.tenant}|${req.streamId}`)) as unknown as SeqStubLike).append(req),
};
function depsWith(sender: EvidenceSender, parser: ConciergeParser): ConciergeDeps {
  return { db: env.TENANT_A_DB, seq: seqStub, sender, parser, tenantFromName: FROM_NAME };
}

// A sender that always fails — the send-isolation law (the reply lags; the ledger facts stand).
class ThrowingSender implements EvidenceSender {
  constructor(private readonly retriable: boolean) {}
  async send(_m: EvidenceMessage): Promise<SendReceipt> {
    throw new SendError(this.retriable ? "resend answered 503" : "resend rejected the send (422)", this.retriable);
  }
}

// A parser whose request DIVERGES from what the DeterministicParser re-extracts (the C1 corroboration
// gate's target): same lane, a DIFFERENT weight, so compose's independent re-parse disagrees → queued.
class DivergentWeightParser implements ConciergeParser {
  async parse(email: InboundEmail): Promise<ParseResult> {
    const det = await new DeterministicParser().parse(email);
    // Keep intent + party + lane, but claim a different (higher) weight than the email actually states.
    return { ...det, request: { ...(det.request ?? { origin_zip: "97201", dest_zip: "80012" }), weight_lb: 9_000 } } as ParseResult;
  }
}

// A parser (the LLM's role) whose `party_hint.email` is model-authored to an ATTACKER address — every
// price-affecting field still corroborates, so the quote auto-sends. The I2 target: the reply must go to
// the AUTHENTICATED envelope sender, never this model-supplied address (anti quote-spam-relay).
const SPOOF_RECIPIENT = "attacker@evil.example.com";
class SpoofedRecipientParser implements ConciergeParser {
  async parse(email: InboundEmail): Promise<ParseResult> {
    const det = await new DeterministicParser().parse(email);
    return { ...det, party_hint: { email: SPOOF_RECIPIENT } } as ParseResult;
  }
}

// ── append an inbound message.received THROUGH the real DO (its `messages` row projects) ──────────────
// A fresh quote email lands on a non-shipment intake stream (`q:…`) — no shipment exists yet.
async function appendInbound(payload: Record<string, unknown>, streamSuffix: string): Promise<string> {
  const id = crypto.randomUUID();
  const appended = await seqStub.append({
    tenant: TENANT,
    streamId: `q:concierge-${streamSuffix}`,
    input: {
      id,
      ts: clock++,
      actor: { party: "party-shipper" },
      party_refs: [],
      evidence: [],
      source: "email",
      confidence: 10_000,
      kind: "message.received",
      payload,
    },
  });
  return (appended as { id: string }).id;
}

function quoteEmail(from: string, body: string): Record<string, unknown> {
  return { channel: "email", from_ref: from, body_ref: "r2://msg/inbound", subject: "Rate please", body };
}

// ── DB probes ────────────────────────────────────────────────────────────────────────────────────────
async function eventsBySourceMessage(messageEventId: string): Promise<LedgerEvent[]> {
  const res = await env.TENANT_A_DB.prepare(
    "SELECT * FROM events WHERE json_extract(payload, '$.source_message_event_id') = ? ORDER BY seq",
  )
    .bind(messageEventId)
    .all();
  return (res.results as Record<string, string | number | null>[]).map((r) => rowToEvent(r));
}
async function streamEvents(shipmentId: string): Promise<LedgerEvent[]> {
  const res = await env.TENANT_A_DB.prepare("SELECT * FROM events WHERE stream_id = ? ORDER BY seq")
    .bind(`s:${shipmentId}`)
    .all();
  return (res.results as Record<string, string | number | null>[]).map((r) => rowToEvent(r));
}
async function shipmentRow(id: string): Promise<{ id: string; shipper_party_id: string } | null> {
  return env.TENANT_A_DB.prepare("SELECT id, shipper_party_id FROM shipments WHERE id = ?")
    .bind(id)
    .first<{ id: string; shipper_party_id: string }>();
}
async function messagesForShipment(shipmentId: string): Promise<{ id: string; direction: string; drafted_by_agent: string | null }[]> {
  const res = await env.TENANT_A_DB.prepare(
    "SELECT id, direction, drafted_by_agent FROM messages WHERE shipment_id = ? ORDER BY id",
  )
    .bind(shipmentId)
    .all<{ id: string; direction: string; drafted_by_agent: string | null }>();
  return res.results;
}
async function messageRow(eventId: string): Promise<{ id: string; direction: string } | null> {
  return env.TENANT_A_DB.prepare("SELECT id, direction FROM messages WHERE id = ?")
    .bind(`msg:${eventId}`)
    .first<{ id: string; direction: string }>();
}

beforeAll(async () => {
  await ensureSchema(env);
});

describe("Concierge consumer — message.received → resolve/price/reply (REQ-026/093/100)", () => {
  it("AUTO-REPLY GOLDEN PATH: a clean quote email → party+shipment created, quote.requested+priced+sent, ONE reply, penny-exact", async () => {
    await seedRateConfig(env.TENANT_A_DB, TEST_RATE_CONFIG);
    const from = "newshipper@shipper.example.com";
    const msgId = await appendInbound(
      quoteEmail(from, "Please quote a shipment from 97201 to 80012, 1000 lbs, 48x40x48, 2 pallets."),
      "happy",
    );

    const sender = new RecordingSender();
    const outcome = await handleMessageReceived({ kind: "message.received", tenant: TENANT, event_id: msgId }, depsWith(sender, new DeterministicParser()));
    expect(outcome.status, JSON.stringify(outcome)).toBe("issued_replied");
    if (outcome.status !== "issued_replied") throw new Error("unreachable");

    // A party+shipment were resolved/created; the shipment is a real row (the requester is its shipper).
    expect(outcome.party_created).toBe(true);
    const shp = await shipmentRow(outcome.shipment_id);
    expect(shp).not.toBeNull();
    expect(shp!.shipper_party_id).toBe(outcome.party_id);

    // quote.requested + quote.priced + message.sent on the shipment stream, in order, carrying provenance.
    const events = await streamEvents(outcome.shipment_id);
    expect(events.map((e) => e.kind)).toEqual(["quote.requested", "quote.priced", "message.sent"]);
    const [req, priced, sent] = events;
    expect((req!.payload as { source_message_event_id?: string }).source_message_event_id).toBe(msgId);
    expect(req!.id).toBe(outcome.quote_requested_event_id);
    expect(priced!.id).toBe(outcome.quote_priced_event_id);
    expect(sent!.id).toBe(outcome.message_sent_event_id);

    // The recorded sell is what the reply shows (penny-consistent with the Rater's quote.priced).
    const pricedPayload = priced!.payload as { sell: number; lines: { amount_cents: number }[] };
    expect(pricedPayload.lines.reduce((s, l) => s + l.amount_cents, 0)).toBe(pricedPayload.sell);

    // Exactly ONE reply email, to the requester, whose html shows the Rater's sell; key = the message.sent id.
    expect(sender.messages).toHaveLength(1);
    const mail = sender.messages[0]!;
    expect(mail.to).toBe(from);
    expect(mail.shipment_id).toBe(outcome.shipment_id);
    expect(mail.idempotency_key).toBe(`concierge-reply/${outcome.message_sent_event_id}`);
    expect(mail.html).toContain(formatCents(pricedPayload.sell));
    expect(mail.html).toContain(FROM_NAME);

    // The messages read-model carries the inbound (projected from message.received) + the sent rows.
    expect(await messageRow(msgId)).toEqual({ id: `msg:${msgId}`, direction: "in" });
    expect(await messageRow(outcome.message_sent_event_id)).toEqual({ id: `msg:${outcome.message_sent_event_id}`, direction: "out" });
  });

  it("BELOW-FLOOR ($222k/1-lb anomaly) → QUEUED, quote.requested + a DRAFT recorded, NO message.sent, NO reply (REQ-040)", async () => {
    await seedRateConfig(env.TENANT_A_DB, ANOMALY_RATE_CONFIG);
    const msgId = await appendInbound(
      quoteEmail("anom@shipper.example.com", "Quote from 97201 to 80016, 1 lb, 48x40x48."),
      "anom",
    );

    const sender = new RecordingSender();
    const outcome = await handleMessageReceived({ kind: "message.received", tenant: TENANT, event_id: msgId }, depsWith(sender, new DeterministicParser()));
    expect(outcome.status, JSON.stringify(outcome)).toBe("queued");
    if (outcome.status !== "queued") throw new Error("unreachable");
    expect(outcome.reason).toBe("below_floor");

    // quote.requested recorded (a human prices it); a DRAFT messages row recorded; NO message.sent, NO send.
    const events = await streamEvents(outcome.shipment_id);
    expect(events.map((e) => e.kind)).toEqual(["quote.requested"]);
    const msgs = await messagesForShipment(outcome.shipment_id);
    expect(msgs.some((m) => m.drafted_by_agent === "concierge" && m.direction === "out")).toBe(true);
    expect(events.some((e) => e.kind === "message.sent")).toBe(false);
    expect(sender.messages).toHaveLength(0);
  });

  it("NOT CORROBORATED (model weight ≠ the email's) → QUEUED, NO reply (the C1 re-parse gate fires through the consumer)", async () => {
    await seedRateConfig(env.TENANT_A_DB, TEST_RATE_CONFIG);
    const msgId = await appendInbound(
      quoteEmail("shaky@shipper.example.com", "Quote from 97201 to 80012, 1000 lbs, 48x40x48."),
      "shaky",
    );

    const sender = new RecordingSender();
    const outcome = await handleMessageReceived({ kind: "message.received", tenant: TENANT, event_id: msgId }, depsWith(sender, new DivergentWeightParser()));
    expect(outcome.status, JSON.stringify(outcome)).toBe("queued");
    if (outcome.status !== "queued") throw new Error("unreachable");
    expect(outcome.reason).toBe("not_corroborated");
    expect(sender.messages).toHaveLength(0);
    expect((await streamEvents(outcome.shipment_id)).some((e) => e.kind === "message.sent")).toBe(false);
  });

  it("IDEMPOTENCY (auto-reply): the same message twice → ONE shipment, ONE quote.requested, ONE reply (fast-path re-send dedupes)", async () => {
    await seedRateConfig(env.TENANT_A_DB, TEST_RATE_CONFIG);
    const msgId = await appendInbound(
      quoteEmail("idem@shipper.example.com", "Please quote from 97201 to 80012, 1200 lbs, 48x40x48, 3 skids."),
      "idem",
    );

    const sender = new RecordingSender();
    const first = await handleMessageReceived({ kind: "message.received", tenant: TENANT, event_id: msgId }, depsWith(sender, new DeterministicParser()));
    const second = await handleMessageReceived({ kind: "message.received", tenant: TENANT, event_id: msgId }, depsWith(sender, new DeterministicParser())); // redelivery
    expect(first.status).toBe("issued_replied");
    // The redelivery takes the FAST PATH — it re-sends from the committed events (dedupe-safe), so the
    // customer still gets exactly one reply, and a transient send-failure would have self-healed here.
    expect(second.status).toBe("issued_replied");

    // One quote.requested for this inbound; one shipment; one reply (the sender's key dedupes the re-send).
    const requested = (await eventsBySourceMessage(msgId)).filter((e) => e.kind === "quote.requested");
    expect(requested).toHaveLength(1);
    if (first.status !== "issued_replied") throw new Error("unreachable");
    const events = await streamEvents(first.shipment_id);
    expect(events.filter((e) => e.kind === "quote.requested")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "message.sent")).toHaveLength(1);
    expect(sender.messages).toHaveLength(1);
  });

  it("IDEMPOTENCY (queued): a held message redelivered → already_handled, NO duplicate draft, NO send", async () => {
    await seedRateConfig(env.TENANT_A_DB, ANOMALY_RATE_CONFIG);
    const msgId = await appendInbound(
      quoteEmail("qredeliver@shipper.example.com", "Quote from 97201 to 80016, 1 lb, 48x40x48."),
      "qredeliver",
    );

    const sender = new RecordingSender();
    const first = await handleMessageReceived({ kind: "message.received", tenant: TENANT, event_id: msgId }, depsWith(sender, new DeterministicParser()));
    const second = await handleMessageReceived({ kind: "message.received", tenant: TENANT, event_id: msgId }, depsWith(sender, new DeterministicParser())); // redelivery
    expect(first.status, JSON.stringify(first)).toBe("queued");
    // A queued inbound has a quote.requested but NO message.sent — the human owns it; redelivery does NOT
    // re-parse/re-judge/send (no LLM re-run), it returns already_handled.
    expect(second.status).toBe("already_handled");
    if (first.status !== "queued") throw new Error("unreachable");

    const events = await streamEvents(first.shipment_id);
    expect(events.filter((e) => e.kind === "quote.requested")).toHaveLength(1);
    expect(events.some((e) => e.kind === "message.sent")).toBe(false);
    expect(sender.messages).toHaveLength(0);
  });

  it("I2 — the auto-reply goes to the AUTHENTICATED envelope sender, never the model's party_hint (anti quote-spam-relay)", async () => {
    await seedRateConfig(env.TENANT_A_DB, TEST_RATE_CONFIG);
    const from = "realsender@shipper.example.com";
    const msgId = await appendInbound(
      quoteEmail(from, "Please quote from 97201 to 80012, 1000 lbs, 48x40x48, 2 pallets."),
      "spoof",
    );

    // The (model) parser claims a different recipient; every price field still corroborates → auto-reply.
    const sender = new RecordingSender();
    const outcome = await handleMessageReceived({ kind: "message.received", tenant: TENANT, event_id: msgId }, depsWith(sender, new SpoofedRecipientParser()));
    expect(outcome.status, JSON.stringify(outcome)).toBe("issued_replied");
    expect(sender.messages).toHaveLength(1);
    expect(sender.messages[0]!.to).toBe(from); // the envelope sender — NOT the model's SPOOF_RECIPIENT
    expect(sender.messages[0]!.to).not.toBe(SPOOF_RECIPIENT);
  });

  it("UNRESOLVED (a status email, not a quote) → nothing resolved/quoted/sent", async () => {
    await seedRateConfig(env.TENANT_A_DB, TEST_RATE_CONFIG);
    // A genuine STATUS email — no quote/rate keyword anywhere (the subject too), so intent resolves to
    // `status` and the Concierge routes it away (WP-07's DoD is quoting, not status).
    const msgId = await appendInbound(
      { channel: "email", from_ref: "tracking@shipper.example.com", body_ref: "r2://msg/inbound", subject: "Shipment status", body: "Where is my shipment? Any tracking update on the ETA?" },
      "status",
    );

    const sender = new RecordingSender();
    const outcome = await handleMessageReceived({ kind: "message.received", tenant: TENANT, event_id: msgId }, depsWith(sender, new DeterministicParser()));
    expect(outcome.status, JSON.stringify(outcome)).toBe("unresolved");
    if (outcome.status !== "unresolved") throw new Error("unreachable");
    expect(outcome.reason).toBe("not_quote_intent");

    // Nothing tied, nothing quoted, nothing sent.
    expect(await eventsBySourceMessage(msgId)).toHaveLength(0);
    expect(sender.messages).toHaveLength(0);
  });

  it("SEND-FAILURE (retriable): the send THROWS for redelivery, the ledger facts STAND, and a redelivery self-heals (REQ-100)", async () => {
    await seedRateConfig(env.TENANT_A_DB, TEST_RATE_CONFIG);
    const msgId = await appendInbound(
      quoteEmail("sendfail@shipper.example.com", "Quote from 97201 to 80012, 900 lbs, 48x40x48, 2 pallets."),
      "sendfail",
    );

    // A retriable send failure THROWS so the queue redelivers (mirrors the Biller) — a transient blip must
    // never silently lose the quote. The quote/reply facts were appended BEFORE the send, so they stand.
    await expect(
      handleMessageReceived({ kind: "message.received", tenant: TENANT, event_id: msgId }, depsWith(new ThrowingSender(true), new DeterministicParser())),
    ).rejects.toThrow(SendError);

    // Redelivery with a working sender → the FAST PATH re-sends from the committed events and completes;
    // the facts still stand (never unwound), and the customer gets exactly one reply.
    const sender = new RecordingSender();
    const redelivered = await handleMessageReceived({ kind: "message.received", tenant: TENANT, event_id: msgId }, depsWith(sender, new DeterministicParser()));
    expect(redelivered.status, JSON.stringify(redelivered)).toBe("issued_replied");
    if (redelivered.status !== "issued_replied") throw new Error("unreachable");
    const events = await streamEvents(redelivered.shipment_id);
    expect(events.map((e) => e.kind)).toEqual(["quote.requested", "quote.priced", "message.sent"]);
    expect(sender.messages).toHaveLength(1);
  });

  it("SEND-FAILURE (permanent): a non-retriable send → issued_send_pending, HELD (not thrown), facts stand (REQ-100)", async () => {
    await seedRateConfig(env.TENANT_A_DB, TEST_RATE_CONFIG);
    const msgId = await appendInbound(
      quoteEmail("permfail@shipper.example.com", "Quote from 97201 to 80012, 1100 lbs, 48x40x48, 2 pallets."),
      "permfail",
    );

    // A permanent send failure cannot be helped by redelivery: HOLD send-pending, never throw, never unwind.
    const outcome = await handleMessageReceived({ kind: "message.received", tenant: TENANT, event_id: msgId }, depsWith(new ThrowingSender(false), new DeterministicParser()));
    expect(outcome.status, JSON.stringify(outcome)).toBe("issued_send_pending");
    if (outcome.status !== "issued_send_pending") throw new Error("unreachable");

    const events = await streamEvents(outcome.shipment_id);
    expect(events.map((e) => e.kind)).toEqual(["quote.requested", "quote.priced", "message.sent"]);
    expect(events.find((e) => e.id === outcome.message_sent_event_id)).toBeDefined();
  });

  it("POISON: a trigger whose event_id has no matching message.received → skipped, nothing appended", async () => {
    const sender = new RecordingSender();
    const bogus = crypto.randomUUID();
    const outcome = await handleMessageReceived({ kind: "message.received", tenant: TENANT, event_id: bogus }, depsWith(sender, new DeterministicParser()));
    expect(outcome.status).toBe("skipped");
    if (outcome.status !== "skipped") throw new Error("unreachable");
    expect(outcome.reason).toBe("message_not_found");
    expect(await eventsBySourceMessage(bogus)).toHaveLength(0);
    expect(sender.messages).toHaveLength(0);
  });

  it("the trigger's Zod boundary rejects a malformed message", () => {
    expect(() => MessageReceivedTrigger.parse({ kind: "message.received", tenant: TENANT })).toThrow(); // no event_id
    expect(MessageReceivedTrigger.parse({ kind: "message.received", tenant: TENANT, event_id: "evt-1" }).event_id).toBe("evt-1");
  });
});
