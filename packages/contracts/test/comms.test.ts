import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MessageChannel,
  MessageReceivedPayload,
  MAX_EMAIL_LEN,
  MessageSentPayload,
  RateRequestPayload,
  MAX_WEIGHT_LB,
  MAX_ZIP_LEN,
  QuoteRequestedPayload,
  QuoteSentPayload,
  QuoteAcceptedPayload,
  EVENT_KINDS,
  LedgerEvent,
  EventInput,
  eventFixture,
} from "../src/index.js";

// WP-07 Concierge (REQ-026/093/099): the comms + quote-lifecycle kinds carry PROPER typed payloads so the
// Concierge can move channel / direction / refs / intent / confidence through the ledger. This TYPES five
// EXISTING kinds — no kind is added (a test below re-pins .length === 35). quote.priced stays as-is (already
// typed); quote.expired + call.transcribed stay loose (voice/expiry deferred).

// A minimal valid EventInput envelope (client-suppliable subset); source "email" reflects the inbound leg.
const INPUT_BASE = {
  id: "00000000-0000-4000-8000-0000000000cc",
  ts: 1_720_000_000_000,
  actor: { party: "party-shipper" },
  party_refs: [] as string[],
  evidence: [] as never[],
  source: "email" as const,
  confidence: 10_000,
};

// The five kinds this task types. quote.priced is intentionally NOT here (already typed).
const TYPED_COMMS_KINDS = [
  "message.received",
  "message.sent",
  "quote.requested",
  "quote.sent",
  "quote.accepted",
] as const;

describe("REQ-011: typing the comms/quote kinds adds NO kind (the 35-catalog holds)", () => {
  it("EVENT_KINDS.length is still exactly 35", () => expect(EVENT_KINDS.length).toBe(35));
});

describe("REQ-093: MessageReceivedPayload (inbound message → channel + from_ref + body_ref)", () => {
  // §1530 — THE HANDLE THAT LEAVES THE BUILDING. `subject` (2,048) and `body` (32,768) were bounded and
  // said so; `from_ref` was `z.string().min(1)` and accepted **100,000 characters** (measured §1530). It is
  // stored VERBATIM in an append-only event AND read back by the Concierge as the reply RECIPIENT, so an
  // unbounded value is permanent storage and a mail header at once. `mailSafe` refuses CR/LF in it (§1501);
  // nothing refused length. Bounded to `MAX_EMAIL_LEN` — RFC 5321's 254 is the widest of the three handle
  // forms (address / phone / party ref), so one constant bounds their union.
  // §1532 — THE OUTBOUND HANDLES, bounded with the same constant. §1530 bounded the INBOUND one and left the
  // two OUTBOUND ones (message.sent, quote.sent) unbounded two fields away — and `to_ref` is the address a
  // send actually goes to, stored verbatim in an append-only event. A party contact can still supply it
  // (`parties.contacts` is unbounded JSON), so bounding `from_ref` alone did not close the path.
  it("§1532: both OUTBOUND to_ref fields carry the same ceiling as from_ref", () => {
    const sent = { channel: "email" as const, to_ref: "a".repeat(MAX_EMAIL_LEN + 1), body_ref: "r2://m/1" };
    expect(() => MessageSentPayload.parse(sent)).toThrow();
    expect(MessageSentPayload.parse({ ...sent, to_ref: "ap@acme.example" }).to_ref).toBe("ap@acme.example");
  });

  it("§1530: rejects an over-length from_ref, and accepts a real address at the ceiling", () => {
    const base = { channel: "email" as const, body_ref: "r2://msg/1" };
    expect(() => MessageReceivedPayload.parse({ ...base, from_ref: "a".repeat(100_000) })).toThrow();
    expect(() => MessageReceivedPayload.parse({ ...base, from_ref: "a".repeat(MAX_EMAIL_LEN + 1) })).toThrow();
    expect(MessageReceivedPayload.parse({ ...base, from_ref: "a".repeat(MAX_EMAIL_LEN) }).from_ref).toHaveLength(MAX_EMAIL_LEN);
    expect(MessageReceivedPayload.parse({ ...base, from_ref: "ops@acme.example" }).from_ref).toBe("ops@acme.example");
  });

  const valid = { channel: "email", from_ref: "shipper@example.com", body_ref: "r2://msg/inbound-1" };
  it("accepts a minimal inbound message", () => {
    expect(MessageReceivedPayload.parse(valid).channel).toBe("email");
  });
  it("accepts the optional intent + parse_confidence (Bps)", () => {
    const p = MessageReceivedPayload.parse({ ...valid, thread: "th-1", intent: "quote", parse_confidence: 8_200 });
    expect(p.intent).toBe("quote");
    expect(p.parse_confidence).toBe(8_200);
  });
  it("accepts the optional inline subject + body (WP-07 interim parse source, pre-R2 resolver)", () => {
    const p = MessageReceivedPayload.parse({ ...valid, subject: "Quote request", body: "97201 to 80012, 1000 lbs, 48x40x48" });
    expect(p.subject).toBe("Quote request");
    expect(p.body).toBe("97201 to 80012, 1000 lbs, 48x40x48");
  });
  it("rejects a missing from_ref (required)", () => {
    const { from_ref: _drop, ...rest } = valid;
    expect(() => MessageReceivedPayload.parse(rest)).toThrow();
  });
  it("rejects an empty body_ref (min 1)", () => {
    expect(() => MessageReceivedPayload.parse({ ...valid, body_ref: "" })).toThrow();
  });
  it("rejects a channel outside the D1 CHECK set", () => {
    expect(() => MessageReceivedPayload.parse({ ...valid, channel: "fax" })).toThrow();
  });
  it("rejects an intent outside the enum", () => {
    expect(() => MessageReceivedPayload.parse({ ...valid, intent: "invoice" })).toThrow();
  });
  it("rejects a parse_confidence above Bps (0..10000)", () => {
    expect(() => MessageReceivedPayload.parse({ ...valid, parse_confidence: 10_001 })).toThrow();
  });
  it("rejects a NEGATIVE parse_confidence (Bps floor is 0; kills a .min(0)→unbounded mutation)", () => {
    expect(() => MessageReceivedPayload.parse({ ...valid, parse_confidence: -1 })).toThrow();
  });
  it("rejects an empty-string thread (present ⇒ non-empty)", () => {
    expect(() => MessageReceivedPayload.parse({ ...valid, thread: "" })).toThrow();
  });
  it("rejects an unknown extra key (.strict)", () => {
    expect(() => MessageReceivedPayload.parse({ ...valid, from: "shipper@example.com" })).toThrow();
  });
});

describe("REQ-093: MessageSentPayload (outbound reply → channel + to_ref + body_ref + drafted_by_agent)", () => {
  const valid = { channel: "email", to_ref: "shipper@example.com", body_ref: "r2://msg/outbound-1" };
  it("accepts a minimal outbound message", () => {
    expect(MessageSentPayload.parse(valid).to_ref).toBe("shipper@example.com");
  });
  it("accepts drafted_by_agent + in_reply_to + thread", () => {
    const p = MessageSentPayload.parse({ ...valid, thread: "th-1", drafted_by_agent: "concierge", in_reply_to: "evt-msg-1" });
    expect(p.drafted_by_agent).toBe("concierge");
    expect(p.in_reply_to).toBe("evt-msg-1");
  });
  it("rejects a missing to_ref (required)", () => {
    const { to_ref: _drop, ...rest } = valid;
    expect(() => MessageSentPayload.parse(rest)).toThrow();
  });
  it("rejects an empty body_ref (min 1)", () => {
    expect(() => MessageSentPayload.parse({ ...valid, body_ref: "" })).toThrow();
  });
  it("rejects a channel outside the D1 CHECK set", () => {
    expect(() => MessageSentPayload.parse({ ...valid, channel: "slack" })).toThrow();
  });
  it("rejects an empty-string drafted_by_agent / in_reply_to (present ⇒ non-empty)", () => {
    expect(() => MessageSentPayload.parse({ ...valid, drafted_by_agent: "" })).toThrow();
    expect(() => MessageSentPayload.parse({ ...valid, in_reply_to: "" })).toThrow();
  });
  it("rejects an unknown extra key (.strict)", () => {
    expect(() => MessageSentPayload.parse({ ...valid, to: "shipper@example.com" })).toThrow();
  });
  it("MessageChannel matches the D1 messages.channel CHECK set exactly", () => {
    expect(MessageChannel.options).toEqual(["email", "sms", "voice", "portal", "note"]);
  });
});

// ─── Drift guard (Task 2 depends on this): the MessageChannel enum MUST equal the D1 messages.channel CHECK
// set verbatim, or the message projection would accept a channel the DB rejects (or vice-versa). SQL can't
// import TS, so this test reads the migration and asserts the two sets are byte-identical — a future edit to
// EITHER side that diverges fails LOUD here. ───────────────────────────────────────────────────────────────
describe("REQ-093 drift guard: MessageChannel === the messages.channel SQL CHECK set", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const MIGRATION = resolve(HERE, "../../../db/tenant/migrations/0002_domain.sql");

  it("the enum options equal the CHECK (channel IN (...)) literals, in order", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const check = /channel\s+IN\s*\(([^)]*)\)/i.exec(sql);
    expect(check, "could not locate `channel IN (...)` in 0002_domain.sql").not.toBeNull();
    const literals = [...check![1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]);
    expect(literals).toEqual(MessageChannel.options);
  });
});

describe("REQ-099: RateRequestPayload (the measured-physics request a quote is priced from)", () => {
  const valid = { origin_zip: "97201", dest_zip: "98101" };
  it("accepts a minimal request (origin + dest; missing physics is legal — no price on air, REQ-004)", () => {
    expect(RateRequestPayload.parse(valid).origin_zip).toBe("97201");
  });
  it("accepts weight + dims + accessorials", () => {
    const p = RateRequestPayload.parse({
      ...valid,
      weight_lb: 1_200,
      dims: { l_in: 48, w_in: 40, h_in: 60, pieces: 4 },
      accessorials: ["liftgate"],
    });
    expect(p.weight_lb).toBe(1_200);
    expect(p.dims?.pieces).toBe(4);
  });
  it("accepts null dims (explicit missing physics, mirrors the /rate boundary)", () => {
    expect(RateRequestPayload.parse({ ...valid, dims: null }).dims).toBeNull();
  });
  it("rejects a missing origin_zip", () => {
    const { origin_zip: _drop, ...rest } = valid;
    expect(() => RateRequestPayload.parse(rest)).toThrow();
  });
  it("rejects a missing dest_zip (both endpoints are required, not just origin)", () => {
    const { dest_zip: _drop, ...rest } = valid;
    expect(() => RateRequestPayload.parse(rest)).toThrow();
  });
  it("rejects an empty-string origin or dest (min 1)", () => {
    expect(() => RateRequestPayload.parse({ ...valid, origin_zip: "" })).toThrow();
    expect(() => RateRequestPayload.parse({ ...valid, dest_zip: "" })).toThrow();
  });
  // §1514 (REQ-004/051) — THE CEILING, which is a different law from the floor above it. `min(1)` says a
  // shipment weighs something; `max(MAX_WEIGHT_LB)` says the pricing chain can express the answer. The chain
  // forms `weight × cwt_cents` in BigInt and THROWS rather than lose precision, and §1513 measured that throw
  // reaching an HTTP 500 on the UNAUTHENTICATED `/pub/quote`. The three pricing surfaces now derive their
  // bound from this schema's constant — and this case is the reason that constant means anything: without it,
  // deleting the `.max()` here left contracts 331/331 green (measured §1514).
  it("rejects a weight ABOVE the physical ceiling, and accepts the ceiling itself (§1513's 500)", () => {
    expect(() => RateRequestPayload.parse({ ...valid, weight_lb: MAX_WEIGHT_LB + 1 })).toThrow();
    expect(() => RateRequestPayload.parse({ ...valid, weight_lb: 1e15 })).toThrow();
    expect(() => RateRequestPayload.parse({ ...valid, weight_lb: Number.MAX_SAFE_INTEGER })).toThrow();
    // INCLUSIVE, and a real truckload still parses — a ceiling that refuses real freight is the worse defect.
    expect(RateRequestPayload.parse({ ...valid, weight_lb: MAX_WEIGHT_LB }).weight_lb).toBe(MAX_WEIGHT_LB);
    expect(RateRequestPayload.parse({ ...valid, weight_lb: 80_000 }).weight_lb).toBe(80_000);
  });
  // §1515 — THE STRINGS BESIDE IT, same law. `z.string()` bounds a TYPE, never a VALUE: measured at §1515,
  // this payload accepted a 100,000-character `origin_zip`, and that string lands in an append-only
  // `quote.priced` payload — permanent bloat from one request. 20 holds a US ZIP+4 twice over.
  it("rejects a zip longer than the physical ceiling, and accepts a real ZIP+4", () => {
    expect(() => RateRequestPayload.parse({ ...valid, origin_zip: "a".repeat(MAX_ZIP_LEN + 1) })).toThrow();
    expect(() => RateRequestPayload.parse({ ...valid, dest_zip: "a".repeat(100_000) })).toThrow();
    expect(RateRequestPayload.parse({ ...valid, origin_zip: "97201-1234" }).origin_zip).toBe("97201-1234");
    expect(RateRequestPayload.parse({ ...valid, origin_zip: "a".repeat(MAX_ZIP_LEN) }).origin_zip).toHaveLength(MAX_ZIP_LEN);
  });
  it("rejects a FLOAT weight_lb (integer-only canonical law)", () => {
    expect(() => RateRequestPayload.parse({ ...valid, weight_lb: 12.5 })).toThrow();
  });
  it("rejects weight_lb: 0 (a real request weighs ≥ 1 lb; kills a .min(1)→.min(0) mutation)", () => {
    expect(() => RateRequestPayload.parse({ ...valid, weight_lb: 0 })).toThrow();
  });
  it("rejects dims.pieces: 0 (≥ 1; a zero-piece measurement is degenerate)", () => {
    expect(() => RateRequestPayload.parse({ ...valid, dims: { l_in: 48, w_in: 40, h_in: 60, pieces: 0 } })).toThrow();
  });
  it("rejects an unknown extra key (.strict)", () => {
    expect(() => RateRequestPayload.parse({ ...valid, class_code: "50" })).toThrow();
  });
});

describe("REQ-099: QuoteRequestedPayload (a request carries its rate request + optional source message)", () => {
  const valid = { request: { origin_zip: "97201", dest_zip: "98101" } };
  it("accepts a request-only payload", () => {
    expect(QuoteRequestedPayload.parse(valid).request.dest_zip).toBe("98101");
  });
  it("accepts the optional source_message_event_id (provenance to the inbound message)", () => {
    expect(QuoteRequestedPayload.parse({ ...valid, source_message_event_id: "evt-msg-1" }).source_message_event_id).toBe("evt-msg-1");
  });
  it("rejects a missing request", () => {
    expect(() => QuoteRequestedPayload.parse({ source_message_event_id: "evt-msg-1" })).toThrow();
  });
  it("rejects a malformed nested request (bubbles up)", () => {
    expect(() => QuoteRequestedPayload.parse({ request: { origin_zip: "97201" } })).toThrow();
  });
  it("rejects an empty-string source_message_event_id (present ⇒ non-empty)", () => {
    expect(() => QuoteRequestedPayload.parse({ ...valid, source_message_event_id: "" })).toThrow();
  });
  it("rejects an unknown extra key (.strict)", () => {
    expect(() => QuoteRequestedPayload.parse({ ...valid, priority: "high" })).toThrow();
  });
});

describe("REQ-099: QuoteSentPayload (links the sent quote to the message that carried it)", () => {
  const valid = { quote_event_id: "evt-quote-1", to_ref: "shipper@example.com", message_event_id: "evt-msg-2" };
  it("accepts a fully-referenced sent quote", () => {
    expect(QuoteSentPayload.parse(valid).message_event_id).toBe("evt-msg-2");
  });
  it("rejects a missing message_event_id (required)", () => {
    const { message_event_id: _drop, ...rest } = valid;
    expect(() => QuoteSentPayload.parse(rest)).toThrow();
  });
  it("rejects an empty quote_event_id (min 1)", () => {
    expect(() => QuoteSentPayload.parse({ ...valid, quote_event_id: "" })).toThrow();
  });
  it("rejects an unknown extra key (.strict)", () => {
    expect(() => QuoteSentPayload.parse({ ...valid, cc: "ops@example.com" })).toThrow();
  });
});

describe("REQ-099: QuoteAcceptedPayload (names the accepted quote)", () => {
  it("accepts a quote_event_id", () => {
    expect(QuoteAcceptedPayload.parse({ quote_event_id: "evt-quote-1" }).quote_event_id).toBe("evt-quote-1");
  });
  it("rejects a missing quote_event_id", () => {
    expect(() => QuoteAcceptedPayload.parse({})).toThrow();
  });
  it("rejects an unknown extra key (.strict)", () => {
    expect(() => QuoteAcceptedPayload.parse({ quote_event_id: "evt-quote-1", accepted_by: "x" })).toThrow();
  });
});

// ─── Union wiring — kind narrows payload in BOTH LedgerEvent and EventInput, and a full event survives a
// JSON round-trip through LedgerEvent.parse with field integrity intact (the honest form; the frozen-byte
// hash pin lives in packages/ledger roundtrip.test.ts.snap). ──────────────────────────────────────────────
describe("union wiring: the five comms kinds narrow to their typed payload", () => {
  it("LedgerEvent.parse round-trips each typed comms kind and preserves every field across a JSON trip", () => {
    for (const kind of TYPED_COMMS_KINDS) {
      const f = eventFixture(kind);
      const parsed = LedgerEvent.parse(JSON.parse(JSON.stringify(f)) as unknown);
      expect(parsed.kind).toBe(kind);
      expect(parsed).toEqual(f); // determinism + field integrity, no re-canonicalization here
    }
  });
  it("LedgerEvent REJECTS a typed comms kind carrying the old loose {} payload", () => {
    for (const kind of TYPED_COMMS_KINDS) {
      expect(() => LedgerEvent.parse({ ...eventFixture(kind), payload: {} })).toThrow();
    }
  });
  it("EventInput.parse accepts each typed comms kind's payload", () => {
    const payloads: Record<(typeof TYPED_COMMS_KINDS)[number], Record<string, unknown>> = {
      "message.received": { channel: "email", from_ref: "shipper@example.com", body_ref: "r2://in-1" },
      "message.sent": { channel: "email", to_ref: "shipper@example.com", body_ref: "r2://out-1" },
      "quote.requested": { request: { origin_zip: "97201", dest_zip: "98101" } },
      "quote.sent": { quote_event_id: "evt-q-1", to_ref: "shipper@example.com", message_event_id: "evt-m-1" },
      "quote.accepted": { quote_event_id: "evt-q-1" },
    };
    for (const kind of TYPED_COMMS_KINDS) {
      expect(EventInput.parse({ ...INPUT_BASE, kind, payload: payloads[kind] }).kind).toBe(kind);
    }
  });
  it("EventInput REJECTS a typed comms kind carrying an empty payload", () => {
    for (const kind of TYPED_COMMS_KINDS) {
      expect(() => EventInput.parse({ ...INPUT_BASE, kind, payload: {} })).toThrow();
    }
  });
});
