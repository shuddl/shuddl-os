import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { readEvents, rowToEvent } from "@shuddl/ledger/lens";
import type { LedgerEvent } from "@shuddl/contracts";
import { DeterministicParser, RecordingSender, SendError, formatCents } from "@shuddl/agents";
import type { ConciergeParser, EvidenceMessage, EvidenceSender, InboundEmail, ParseResult, SendReceipt } from "@shuddl/agents";
import { handleMessageReceived, MessageReceivedTrigger, SLA_REPLY_WINDOW_MS } from "../../agents/src/concierge.js";
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
// Task 8 (REQ-095) probes: the inbound event's recorded_at (the deterministic SLA base) + the inbound's
// own messages row's sla_due_ts.
async function inboundRecordedAt(eventId: string): Promise<number> {
  const row = await env.TENANT_A_DB.prepare("SELECT recorded_at FROM events WHERE id = ?")
    .bind(eventId)
    .first<{ recorded_at: number }>();
  return row!.recorded_at;
}
async function slaRow(eventId: string): Promise<{ direction: string; sla_due_ts: number | null } | null> {
  return env.TENANT_A_DB.prepare("SELECT direction, sla_due_ts FROM messages WHERE id = ?")
    .bind(`msg:${eventId}`)
    .first<{ direction: string; sla_due_ts: number | null }>();
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

  it("REQ-172 — party IDENTITY keys off the AUTHENTICATED from_ref, never the model's party_hint.email (no attacker party)", async () => {
    await seedRateConfig(env.TENANT_A_DB, TEST_RATE_CONFIG);
    const from = "realshipper@shipper.example.com";
    const msgId = await appendInbound(
      quoteEmail(from, "Please quote from 97201 to 80012, 1000 lbs, 48x40x48, 2 pallets."),
      "req172-identity",
    );

    // The (model) parser names an ATTACKER address as party_hint.email — it must NOT drive identity.
    const sender = new RecordingSender();
    const outcome = await handleMessageReceived({ kind: "message.received", tenant: TENANT, event_id: msgId }, depsWith(sender, new SpoofedRecipientParser()));
    expect(outcome.status, JSON.stringify(outcome)).toBe("issued_replied");
    if (outcome.status !== "issued_replied") throw new Error("unreachable");

    // The created party + the shipment's shipper are keyed off from_ref — the party's contact email is the
    // AUTHENTICATED envelope sender, NEVER the attacker's party_hint.email.
    const shp = await shipmentRow(outcome.shipment_id);
    expect(shp!.shipper_party_id).toBe(outcome.party_id);
    const party = await env.TENANT_A_DB.prepare("SELECT contacts FROM parties WHERE id = ?").bind(outcome.party_id).first<{ contacts: string }>();
    const emails = (JSON.parse(party!.contacts) as { email?: string }[]).map((c) => c.email);
    expect(emails).toContain(from); // identity = from_ref
    expect(emails).not.toContain(SPOOF_RECIPIENT); // the attacker address never becomes the party
    // Every appended event attributes to the from_ref-keyed party (party_refs), not the attacker.
    const events = await streamEvents(outcome.shipment_id);
    expect(events.every((e) => e.party_refs.includes(outcome.party_id))).toBe(true);
  });

  it("REQ-172 — a spoofed EXISTING-party email in party_hint cannot force a victim match / resolution bump", async () => {
    await seedRateConfig(env.TENANT_A_DB, TEST_RATE_CONFIG);
    // Seed a VICTIM party already on file, keyed by the email the attacker will name in party_hint.
    const victimEmail = "victim-req172@bigco.example.com";
    const victimId = "party-victim-req172";
    await env.TENANT_A_DB.prepare("INSERT OR IGNORE INTO parties (id, kind, names, contacts) VALUES (?,?,?,?)")
      .bind(victimId, "shipper", "{}", JSON.stringify([{ kind: "primary", email: victimEmail }]))
      .run();

    // An inbound from a BRAND-NEW sender, but the (model) parser names the victim's on-file email in party_hint.
    const from = "stranger-req172@shipper.example.com";
    const msgId = await appendInbound(
      quoteEmail(from, "Please quote from 97201 to 80012, 1000 lbs, 48x40x48, 2 pallets."),
      "req172-victim",
    );
    class VictimHintParser implements ConciergeParser {
      async parse(email: InboundEmail): Promise<ParseResult> {
        const det = await new DeterministicParser().parse(email);
        return { ...det, party_hint: { email: victimEmail } } as ParseResult;
      }
    }
    const sender = new RecordingSender();
    const outcome = await handleMessageReceived({ kind: "message.received", tenant: TENANT, event_id: msgId }, depsWith(sender, new VictimHintParser()));
    expect(outcome.status, JSON.stringify(outcome)).toBe("issued_replied");
    if (outcome.status !== "issued_replied") throw new Error("unreachable");

    // The tie is a NEW party on from_ref — the victim was NOT matched (no existing-party bump off the model
    // email). Under the pre-fix behavior findPartyByEmail(party_hint.email) would have matched the victim.
    expect(outcome.party_created).toBe(true);
    expect(outcome.party_id).not.toBe(victimId);
    const shp = await shipmentRow(outcome.shipment_id);
    expect(shp!.shipper_party_id).toBe(outcome.party_id);
    expect(shp!.shipper_party_id).not.toBe(victimId);
  });

  it("REQ-173 — an unpriceable request (accessorial absent from the schedule) QUEUES (unknown_price), never throws into the redelivery loop", async () => {
    // A config with an EMPTY accessorial schedule; the email requests 'liftgate' → the Rater compose THROWS
    // ("no silent drop", Migrator law). That throw must be CAUGHT and turned into queued(unknown_price) —
    // never propagate (the queue would blanket-retry it into the DLQ, silently losing the customer quote).
    await seedRateConfig(env.TENANT_A_DB, {
      ...TEST_RATE_CONFIG,
      accessorials: { kind: "accessorials", id: "acc-empty", version: "v1", items: {} },
    });
    const from = "unpriceable@shipper.example.com";
    const msgId = await appendInbound(
      quoteEmail(from, "Please quote from 97201 to 80012, 1000 lbs, 48x40x48, 2 pallets, liftgate required."),
      "req173-unpriceable",
    );

    const sender = new RecordingSender();
    const outcome = await handleMessageReceived({ kind: "message.received", tenant: TENANT, event_id: msgId }, depsWith(sender, new DeterministicParser()));
    expect(outcome.status, JSON.stringify(outcome)).toBe("queued");
    if (outcome.status !== "queued") throw new Error("unreachable");
    expect(outcome.reason).toBe("unknown_price");

    // quote.requested recorded (a human prices it) + a DRAFT messages row; NO message.sent, NO reply.
    const events = await streamEvents(outcome.shipment_id);
    expect(events.map((e) => e.kind)).toEqual(["quote.requested"]);
    const msgs = await messagesForShipment(outcome.shipment_id);
    expect(msgs.some((m) => m.drafted_by_agent === "concierge" && m.direction === "out")).toBe(true);
    expect(events.some((e) => e.kind === "message.sent")).toBe(false);
    expect(sender.messages).toHaveLength(0);
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

  // ─── Task 8 (REQ-095) — SLA timers on an inbound that is OWED a reply but was NOT auto-answered ───────
  it("SLA SET (queued): a held quote inbound gets sla_due_ts = its recorded_at + WINDOW (deterministic, on its OWN inbound row)", async () => {
    // A below-floor ($222k/1-lb) quote QUEUES (a human owns it) → the inbound is owed a first-response SLA.
    await seedRateConfig(env.TENANT_A_DB, ANOMALY_RATE_CONFIG);
    const msgId = await appendInbound(
      quoteEmail("sla-queued@shipper.example.com", "Quote from 97201 to 80016, 1 lb, 48x40x48."),
      "sla-queued",
    );
    const outcome = await handleMessageReceived({ kind: "message.received", tenant: TENANT, event_id: msgId }, depsWith(new RecordingSender(), new DeterministicParser()));
    expect(outcome.status, JSON.stringify(outcome)).toBe("queued");

    // The SLA is on the INBOUND'S OWN row (msg:<inbound id>, direction 'in') — DETERMINISTIC from the
    // event's recorded_at (never a fresh clock), so a redelivery re-computes the SAME due ts.
    const rec = await inboundRecordedAt(msgId);
    const row = await slaRow(msgId);
    expect(row).toEqual({ direction: "in", sla_due_ts: rec + SLA_REPLY_WINDOW_MS });
  });

  it("SLA SET (auto-reply backstop, REQ-174): an auto-answered inbound ALSO gets sla_due_ts = recorded_at + WINDOW — the backstop for a partial-append death", async () => {
    await seedRateConfig(env.TENANT_A_DB, TEST_RATE_CONFIG);
    const msgId = await appendInbound(
      quoteEmail("sla-answered@shipper.example.com", "Please quote from 97201 to 80012, 1000 lbs, 48x40x48, 2 pallets."),
      "sla-answered",
    );
    const outcome = await handleMessageReceived({ kind: "message.received", tenant: TENANT, event_id: msgId }, depsWith(new RecordingSender(), new DeterministicParser()));
    expect(outcome.status, JSON.stringify(outcome)).toBe("issued_replied");
    // REQ-174: the auto-reply path sets the SLA at the TOP (before its appends), so a partial-append death
    // (quote.requested committed, no answering message.sent) is caught by the T8 sweep. A SUCCESSFUL
    // auto-reply carries a message.sent(in_reply_to) so the sweep's ANSWERED check does not flag it — proven
    // in sla-sweep.test.ts. Here we pin that the SLA is deterministically set on the inbound's own row.
    const rec = await inboundRecordedAt(msgId);
    expect(await slaRow(msgId)).toEqual({ direction: "in", sla_due_ts: rec + SLA_REPLY_WINDOW_MS });
  });
});

// ─── WP-07 Task 7 — TIMELINE VISIBILITY + "no comms outside the ledger" (REQ-094/099/100) ──────────────
//
// The end-to-end proof that the Concierge's comms/quote lane rides the SAME visibility lens as every
// other event: a shipment's timeline is `readEvents(db, lens)` — the exact fn the /v1 timeline route
// calls — and it is the SOLE gate. Here we drive the REAL consumer + DO + D1, then read the resulting
// stream through a counterparty (party) lens, and separately prove an internal note is a first-class
// LEDGER event (redacted from the counterparty), never a side-table record.
describe("Timeline visibility + no-comms-outside-the-ledger (REQ-094/099/100)", () => {
  it("TIMELINE: the Concierge's quote.requested / quote.priced / message.sent surface on the counterparty (party) lens; the counterparty sees `sell` but the floors/basis/versions are REDACTED (REQ-094)", async () => {
    await seedRateConfig(env.TENANT_A_DB, TEST_RATE_CONFIG);
    const from = "timeline@shipper.example.com";
    const msgId = await appendInbound(
      quoteEmail(from, "Please quote from 97201 to 80012, 1000 lbs, 48x40x48, 2 pallets."),
      "task7-timeline",
    );
    const sender = new RecordingSender();
    const outcome = await handleMessageReceived({ kind: "message.received", tenant: TENANT, event_id: msgId }, depsWith(sender, new DeterministicParser()));
    expect(outcome.status, JSON.stringify(outcome)).toBe("issued_replied");
    if (outcome.status !== "issued_replied") throw new Error("unreachable");

    // The shipment timeline THROUGH THE REAL LENS (readEvents), scoped to the counterparty party_id.
    const timeline = await readEvents(env.TENANT_A_DB, { scope: "party", partyId: outcome.party_id }, { shipment_id: outcome.shipment_id });
    expect(timeline.map((e) => e.kind).sort()).toEqual(["message.sent", "quote.priced", "quote.requested"]);
    // each reaches the lens BECAUSE the Concierge stamped party_refs = [the counterparty] on every append
    expect(timeline.every((e) => e.party_refs.includes(outcome.party_id))).toBe(true);
    // REQ-094 counterparty redaction: `sell` is visible; the margin internals are stripped (real payload
    // DOES carry floors/basis/versions — this is a genuine redaction, not a trivially-absent key).
    const priced = timeline.find((e) => e.kind === "quote.priced")!;
    const pp = priced.payload as Record<string, unknown>;
    expect(pp.sell).toBeDefined();
    expect(pp.floors).toBeUndefined();
    expect(pp.basis).toBeUndefined();
    expect(pp.versions).toBeUndefined();
  });

  it("REQ-100 no-orphan-send: the ONE reply the sender recorded maps 1:1 to the committed message.sent event (keyed by its id); the inbound message.received is the DOCUMENTED deferred-ingestion gap (party_refs [] until the webhook lands)", async () => {
    await seedRateConfig(env.TENANT_A_DB, TEST_RATE_CONFIG);
    const from = "noorphan@shipper.example.com";
    const msgId = await appendInbound(
      quoteEmail(from, "Please quote from 97201 to 80012, 1000 lbs, 48x40x48, 2 pallets."),
      "task7-noorphan",
    );
    const sender = new RecordingSender();
    const outcome = await handleMessageReceived({ kind: "message.received", tenant: TENANT, event_id: msgId }, depsWith(sender, new DeterministicParser()));
    expect(outcome.status, JSON.stringify(outcome)).toBe("issued_replied");
    if (outcome.status !== "issued_replied") throw new Error("unreachable");

    // NO comm exists outside the ledger: the reply that WENT OUT has exactly one message.sent event, and
    // the send references THAT event by its idempotency key (the append precedes the send, REQ-100).
    const sent = (await streamEvents(outcome.shipment_id)).filter((e) => e.kind === "message.sent");
    expect(sent).toHaveLength(1);
    expect(sender.messages).toHaveLength(1);
    expect(sent[0]!.id).toBe(outcome.message_sent_event_id);
    expect(sender.messages[0]!.idempotency_key).toBe(`concierge-reply/${sent[0]!.id}`);

    // DOCUMENTED DEFERRED GAP (real inbound-ingestion webhook is a LATER WP): the inbound message.received
    // was appended (by the test harness — and, in prod, by that webhook) with party_refs [], so it does
    // NOT yet reach the counterparty lens. The Concierge never appends the inbound; it appends only the
    // three events above, which DO carry party_refs=[counterparty]. It IS a ledger event today — projected
    // as an inbound row in the messages read-model — so once the webhook stamps party_refs the SAME
    // message.received->counterparty default surfaces it. Pinned here so the gap is explicit, not silent.
    expect(await messageRow(msgId)).toEqual({ id: `msg:${msgId}`, direction: "in" });
  });

  it("REQ-100/094 internal note: an internal note IS a message.received{channel:note, visibility:internal} ledger event (projected into the messages read-model) — not a side table — and is REDACTED from the counterparty lens while its sibling counterparty message stays visible", async () => {
    const party = "party-note-task7";
    const shipmentId = `note-${crypto.randomUUID()}`;
    const streamId = `s:${shipmentId}`;
    // Both appended THROUGH THE REAL SEQUENCER DO (the only write path) on ONE shipment stream, both
    // referencing the SAME party — so the ONLY thing that redacts the note is its internal visibility.
    const customer = await seqStub.append({
      tenant: TENANT,
      streamId,
      input: {
        id: crypto.randomUUID(),
        shipment_id: shipmentId,
        ts: clock++,
        actor: { party: "party-shipper" },
        party_refs: [party],
        evidence: [],
        source: "email",
        confidence: 10_000,
        kind: "message.received",
        payload: { channel: "email", from_ref: "cust@example.com", body_ref: "r2://note/cust" },
      },
    });
    const note = await seqStub.append({
      tenant: TENANT,
      streamId,
      input: {
        id: crypto.randomUUID(),
        shipment_id: shipmentId,
        ts: clock++,
        actor: { party: "agent:concierge" },
        party_refs: [party],
        evidence: [],
        source: "native",
        confidence: 10_000,
        requested_visibility: "internal", // an ops note narrows message.received (counterparty) -> internal
        kind: "message.received",
        payload: { channel: "note", from_ref: "ops@internal", body_ref: "r2://note/internal" },
      },
    });

    // (a) the note is a FIRST-CLASS ledger event; the server-side resolver stamped it internal.
    const noteRow = await env.TENANT_A_DB.prepare(
      "SELECT kind, visibility, json_extract(payload,'$.channel') AS channel FROM events WHERE id = ?",
    )
      .bind(note.id)
      .first<{ kind: string; visibility: string; channel: string }>();
    expect(noteRow).toEqual({ kind: "message.received", visibility: "internal", channel: "note" });

    // (b) NOT a side table — it projects into the SAME `messages` read-model every comms event does.
    const noteMsg = await env.TENANT_A_DB.prepare("SELECT id, channel, direction FROM messages WHERE id = ?")
      .bind(`msg:${note.id}`)
      .first<{ id: string; channel: string; direction: string }>();
    expect(noteMsg).toEqual({ id: `msg:${note.id}`, channel: "note", direction: "in" });

    // (c) REDACTED from the counterparty lens; the sibling counterparty message stays visible (load-bearing:
    //     both carry [party]; only visibility differs). If the note leaked as counterparty this goes red.
    const timeline = await readEvents(env.TENANT_A_DB, { scope: "party", partyId: party }, { shipment_id: shipmentId });
    expect(timeline.map((e) => e.id)).toEqual([customer.id]);
    expect(timeline.some((e) => (e.payload as Record<string, unknown>).channel === "note")).toBe(false);
  });
});
