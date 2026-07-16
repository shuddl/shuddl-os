import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { rowToEvent } from "@shuddl/ledger/lens";
import type { LedgerEvent } from "@shuddl/contracts";
import { handleQuoteAccepted, QuoteAcceptedTrigger, bookingEventIdFor } from "../../agents/src/booking.js";
import type { BookingDeps } from "../../agents/src/booking.js";
import type { SeqStubLike } from "../../agents/src/biller.js";
import type { Env } from "../src/index.js";
import { TENANT_SLUG, ensureSchema, seedShipment } from "./helpers.js";

// ─── WP-08 T8 — THE BOOKING AGENT (REQ-028 / REQ-042 / REQ-182 / REQ-030) ───────────────────────────
//
// The Biller/Concierge sibling: a committed `quote.accepted` (naming the accepted quote.priced via
// quote_event_id) is handed to `handleQuoteAccepted` — the agents-worker consumer — which appends
// `booking.created` THROUGH the real sequencer DO. The T6 credit + evidence-recipient gates and the T4
// shipment/leg materialization run atomically INSIDE that append (REQ-030: the agent has no gate logic of
// its own; it books through the same DO every API path hits). The parties come from the ACCEPTED
// SHIPMENT'S existing rows — a quote-accept carries no new parties.
//
// VENUE (like biller.test.ts / concierge.test.ts): the ShipmentSequencer DO + migrated tenant D1 live only
// in THIS harness; the consumer FUNCTION is imported from the agents worker and driven directly. The
// queue() shell in workers/agents is thin dispatch (pinned by workers/agents/test/queue-dispatch.test.ts).
//
// LAWS UNDER TEST (the DoD):
//   · (a) quote.accepted → booking.created appended through the GATED DO; the shipment projects to `booked`
//     + the skeleton legs materialize (T5); the booking parties come from the accepted shipment.
//   · (b) IDEMPOTENT: the same quote.accepted twice → ONE booking.created (deterministic id + DO dedupe),
//     the second returns already_booked.
//   · (c) GATE-BLOCK HOLDS: a bill_to on a credit hold → held(credit_clear); a bill_to with no deliverable
//     contact + no opt-out → held(evidence_recipient). NO booking, and the agent NEVER throws (no DLQ loop).
//   · (d) POISON: a trigger whose quote.accepted id isn't on the stream → skipped, nothing appended.
//   · producer: a committed quote.accepted enqueues EXACTLY the consumer's trigger (the sequencer wiring).
//
// isolatedStorage is OFF (shared D1): every case scopes to its OWN shipment/stream ids + party ids.

const TENANT = TENANT_SLUG;
let clock = 1_733_000_000_000;

// ── consumer deps against the REAL DO + D1 (mirrors biller.test / concierge.test) ─────────────────────
const seqStub: SeqStubLike = {
  append: (req) =>
    (env.SHIPMENT_SEQ.get(env.SHIPMENT_SEQ.idFromName(`${req.tenant}|${req.streamId}`)) as unknown as SeqStubLike).append(req),
};
function deps(): BookingDeps {
  return { db: env.TENANT_A_DB, seq: seqStub };
}
function triggerFor(shipmentId: string, acceptEventId: string): QuoteAcceptedTrigger {
  return { kind: "quote.accepted", tenant: TENANT, shipment_id: shipmentId, event_id: acceptEventId };
}

// ── seed a real quote.priced + quote.accepted on a shipment stream THROUGH the real DO ─────────────────
// A penny-parity-valid QuotePricedPayload (mirrors the events.ts fixture); quote.accepted names it.
async function seedQuotePriced(shipmentId: string): Promise<string> {
  const id = crypto.randomUUID();
  await seqStub.append({
    tenant: TENANT,
    streamId: `s:${shipmentId}`,
    input: {
      id,
      shipment_id: shipmentId,
      ts: clock++,
      actor: { party: "agent:concierge" },
      party_refs: [],
      evidence: [],
      source: "native",
      confidence: 10_000,
      kind: "quote.priced",
      payload: {
        sell: 120_000,
        lines: [
          { kind: "freight", code: "freight", amount_cents: 90_000 },
          { kind: "fsc", code: "fsc", amount_cents: 12_000 },
          { kind: "accessorial", code: "liftgate", amount_cents: 18_000 },
        ],
        floors: { contribution: 60_000, full: 90_000, target: 100_000 },
        versions: { rate_config_ids: ["rc-booking-test-v1"] },
        basis: {},
      },
    },
  });
  return id;
}
async function seedAccepted(shipmentId: string, quoteEventId: string): Promise<string> {
  const id = crypto.randomUUID();
  await seqStub.append({
    tenant: TENANT,
    streamId: `s:${shipmentId}`,
    input: {
      id,
      shipment_id: shipmentId,
      ts: clock++,
      actor: { party: "party-shipper" },
      party_refs: [],
      evidence: [],
      source: "native",
      confidence: 10_000,
      kind: "quote.accepted",
      payload: { quote_event_id: quoteEventId },
    },
  });
  return id;
}

async function seedShipmentWithBillTo(id: string, billTo: string): Promise<void> {
  await env.TENANT_A_DB.prepare(
    "INSERT OR IGNORE INTO shipments (id, shipper_party_id, consignee_party_id, bill_to_party_id, created_ts) VALUES (?,?,?,?,0)",
  )
    .bind(id, "party-shipper", "party-consignee", billTo)
    .run();
}

// ── DB probes ────────────────────────────────────────────────────────────────────────────────────────
async function streamEvents(shipmentId: string): Promise<LedgerEvent[]> {
  const res = await env.TENANT_A_DB.prepare("SELECT * FROM events WHERE stream_id = ? ORDER BY seq").bind(`s:${shipmentId}`).all();
  return (res.results as Record<string, string | number | null>[]).map((r) => rowToEvent(r));
}
async function bookingEvents(shipmentId: string): Promise<LedgerEvent[]> {
  return (await streamEvents(shipmentId)).filter((e) => e.kind === "booking.created");
}
async function shipmentState(id: string): Promise<string | undefined> {
  const row = await env.TENANT_A_DB.prepare("SELECT json_extract(status_cache, '$.state') AS state FROM shipments WHERE id = ?")
    .bind(id)
    .first<{ state: string | null }>();
  return row?.state ?? undefined;
}
async function legKinds(shipmentId: string): Promise<string[]> {
  const res = await env.TENANT_A_DB.prepare("SELECT id, kind FROM legs WHERE shipment_id = ? ORDER BY seq")
    .bind(shipmentId)
    .all<{ id: string; kind: string }>();
  return res.results.map((r) => `${r.id}|${r.kind}`);
}

// ── producer-side observation (mirrors biller.test's patchAgentQueue) ─────────────────────────────────
async function patchAgentQueue(shipmentId: string, send: (m: unknown) => Promise<void>): Promise<void> {
  const stub = env.SHIPMENT_SEQ.get(env.SHIPMENT_SEQ.idFromName(`${TENANT}|s:${shipmentId}`));
  await runInDurableObject(stub, (instance) => {
    const inst = instance as unknown as { env: Env };
    inst.env = { ...inst.env, AGENT_QUEUE: { send } as unknown as Env["AGENT_QUEUE"] };
  });
}
async function settle(cond: () => boolean, ms = 1_000): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 10));
}

beforeAll(async () => {
  await ensureSchema(env);
  // A bill_to on a credit HOLD (with a deliverable email, so ONLY credit blocks → reason credit_clear).
  await env.TENANT_A_DB.prepare("INSERT OR IGNORE INTO parties (id, kind, names, contacts, credit_status) VALUES (?,?,?,?,?)")
    .bind("party-booking-held", "broker", "{}", JSON.stringify([{ kind: "billing", email: "held@bill-to.test" }]), "hold")
    .run();
  // A bill_to that is credit-clear but has NO deliverable contact + no opt-out → reason evidence_recipient.
  await env.TENANT_A_DB.prepare("INSERT OR IGNORE INTO parties (id, kind, names, contacts, credit_status) VALUES (?,?,?,?,?)")
    .bind("party-booking-nocontact", "broker", "{}", "[]", null)
    .run();
});

describe("Booking agent — quote.accepted → gated booking.created (REQ-028/042/182/030)", () => {
  it("(a) GOLDEN: quote.accepted → booking.created appended through the gated DO; shipment → booked + skeleton legs; parties from the accepted shipment", async () => {
    const shp = "booking-happy";
    await seedShipment(shp); // shipper=party-shipper, consignee=party-consignee, bill_to=party-bill-to (deliverable email)
    const quoteId = await seedQuotePriced(shp);
    const acceptId = await seedAccepted(shp, quoteId);

    const outcome = await handleQuoteAccepted(triggerFor(shp, acceptId), deps());
    expect(outcome.status, JSON.stringify(outcome)).toBe("booked");
    if (outcome.status !== "booked") throw new Error("unreachable");

    // EXACTLY one booking.created on the stream, id = the deterministic derivation from the accept id.
    const bookings = await bookingEvents(shp);
    expect(bookings).toHaveLength(1);
    const booking = bookings[0]!;
    expect(booking.id).toBe(outcome.booking_event_id);
    expect(booking.id).toBe(await bookingEventIdFor(acceptId));

    // The parties come from the ACCEPTED SHIPMENT'S rows (never guessed); quote_event_id anchors the quote.
    const payload = booking.payload as {
      quote_event_id: string;
      shipper_party_id: string;
      consignee_party_id: string;
      bill_to_party_id: string;
      division: string;
    };
    expect(payload.quote_event_id).toBe(quoteId);
    expect(payload.shipper_party_id).toBe("party-shipper");
    expect(payload.consignee_party_id).toBe("party-consignee");
    expect(payload.bill_to_party_id).toBe("party-bill-to");
    expect(payload.division).toBe("main");
    // ts is the accept's commit instant (deterministic, no clock read in the agent).
    const accept = (await streamEvents(shp)).find((e) => e.id === acceptId)!;
    expect(booking.ts).toBe(accept.recorded_at);

    // The T4 projection ran in the SAME batch: the shipment is `booked` + BOTH skeleton legs materialized (T5).
    expect(await shipmentState(shp)).toBe("booked");
    expect(await legKinds(shp)).toEqual([`${shp}:pickup|pickup`, `${shp}:delivery|delivery`]);
  });

  it("(b) IDEMPOTENT: the same quote.accepted twice → ONE booking.created; the second returns already_booked", async () => {
    const shp = "booking-idem";
    await seedShipment(shp);
    const quoteId = await seedQuotePriced(shp);
    const acceptId = await seedAccepted(shp, quoteId);

    const first = await handleQuoteAccepted(triggerFor(shp, acceptId), deps());
    const second = await handleQuoteAccepted(triggerFor(shp, acceptId), deps()); // queue redelivery
    expect(first.status).toBe("booked");
    expect(second.status).toBe("already_booked");
    if (first.status !== "booked" || second.status !== "already_booked") throw new Error("unreachable");
    expect(second.booking_event_id).toBe(first.booking_event_id); // deterministic id — derived, never minted

    expect(await bookingEvents(shp)).toHaveLength(1); // the sequencer deduped by event id
  });

  it("(b2) RE-BOOK SKIP (REQ-191, WP-09 exit-audit C-2): a DIFFERENT accept on an already-booked shipment → already_booked, still ONE booking", async () => {
    // The exploit the exit audit found: a portal party re-rates + re-accepts an ALREADY-booked shipment. The
    // second quote.accepted has a NEW id, so the deterministic-id fast path (test b) does NOT catch it — GUARD 3
    // (any prior booking.created on the stream) does. Without the fix this appended a SECOND booking.created,
    // polluting the append-only ledger and regressing the status_cache.
    const shp = "booking-rebook-c2";
    await seedShipment(shp);
    const first = await handleQuoteAccepted(triggerFor(shp, await seedAccepted(shp, await seedQuotePriced(shp))), deps());
    expect(first.status).toBe("booked");
    const stateAfterFirst = await shipmentState(shp);

    // a SECOND priced quote + accept, DISTINCT ids (quote.priced/quote.accepted are ungated, so they append)
    const second = await handleQuoteAccepted(triggerFor(shp, await seedAccepted(shp, await seedQuotePriced(shp))), deps());
    expect(second.status).toBe("already_booked"); // skipped cleanly — no second append, no DLQ
    expect(await bookingEvents(shp)).toHaveLength(1); // STILL exactly one booking.created
    expect(await shipmentState(shp)).toBe(stateAfterFirst); // no read-model regression
  });

  it("(c1) GATE-BLOCK HOLDS (credit): a bill_to on a credit hold → held(credit_clear), NO booking, NO throw/DLQ", async () => {
    const shp = "booking-held-credit";
    await seedShipmentWithBillTo(shp, "party-booking-held");
    const quoteId = await seedQuotePriced(shp);
    const acceptId = await seedAccepted(shp, quoteId);

    const outcome = await handleQuoteAccepted(triggerFor(shp, acceptId), deps());
    expect(outcome.status, JSON.stringify(outcome)).toBe("held");
    if (outcome.status !== "held") throw new Error("unreachable");
    expect(outcome.reason).toBe("credit_clear");
    expect(outcome.required_evidence).toContain("credit_clear");

    expect(await bookingEvents(shp)).toHaveLength(0); // nothing appended (the gate aborted the append)
    expect(await shipmentState(shp)).toBeUndefined(); // never projected to booked
  });

  it("(c2) GATE-BLOCK HOLDS (recipient): a credit-clear bill_to with no deliverable contact + no opt-out → held(evidence_recipient), NO booking, NO throw/DLQ", async () => {
    const shp = "booking-held-recipient";
    await seedShipmentWithBillTo(shp, "party-booking-nocontact");
    const quoteId = await seedQuotePriced(shp);
    const acceptId = await seedAccepted(shp, quoteId);

    const outcome = await handleQuoteAccepted(triggerFor(shp, acceptId), deps());
    expect(outcome.status, JSON.stringify(outcome)).toBe("held");
    if (outcome.status !== "held") throw new Error("unreachable");
    expect(outcome.reason).toBe("evidence_recipient");
    expect(outcome.required_evidence).toContain("evidence_recipient");

    expect(await bookingEvents(shp)).toHaveLength(0);
    expect(await shipmentState(shp)).toBeUndefined();
  });

  it("(d) POISON: a trigger whose quote.accepted id is not on the stream → skipped, nothing appended", async () => {
    const shp = "booking-poison";
    await seedShipment(shp);
    await seedQuotePriced(shp); // a quote exists — only the accept reference is bogus

    const outcome = await handleQuoteAccepted(triggerFor(shp, crypto.randomUUID()), deps());
    expect(outcome.status, JSON.stringify(outcome)).toBe("skipped");
    if (outcome.status !== "skipped") throw new Error("unreachable");
    expect(outcome.reason).toBe("quote_accept_not_found");

    expect(await bookingEvents(shp)).toHaveLength(0);
  });

  it("(d2) GUARD 2: a quote.accepted whose quote_event_id names no quote.priced on the stream → skipped(accepted_quote_not_found), nothing appended", async () => {
    const shp = "booking-noquote";
    await seedShipment(shp);
    // A quote.accepted that references a quote id that was never priced (a dangling reference — data fault).
    const acceptId = await seedAccepted(shp, crypto.randomUUID());

    const outcome = await handleQuoteAccepted(triggerFor(shp, acceptId), deps());
    expect(outcome.status, JSON.stringify(outcome)).toBe("skipped");
    if (outcome.status !== "skipped") throw new Error("unreachable");
    expect(outcome.reason).toBe("accepted_quote_not_found");

    expect(await bookingEvents(shp)).toHaveLength(0);
    expect(await shipmentState(shp)).toBeUndefined();
  });

  it("NON-GATE RE-THROW: a plain (non-GATE_BLOCKED) DO/transient fault THROWS for redelivery — never swallowed as held", async () => {
    const shp = "booking-rethrow";
    await seedShipment(shp);
    const quoteId = await seedQuotePriced(shp);
    const acceptId = await seedAccepted(shp, quoteId); // a fully valid setup — the agent reaches seq.append

    // A seq whose append throws a PLAIN Error (a transient D1/DO fault or an agent bug — NOT a GATE_BLOCKED).
    // gateBlock returns null for it, so handleQuoteAccepted must RE-THROW (the queue redelivers) — the exact
    // discrimination the gate-block-holds contract depends on: only GATE_BLOCKED holds; everything else is loud.
    const throwingDeps: BookingDeps = {
      db: env.TENANT_A_DB,
      seq: {
        append: async () => {
          throw new Error("boom — transient DO fault");
        },
      },
    };
    await expect(handleQuoteAccepted(triggerFor(shp, acceptId), throwingDeps)).rejects.toThrow("boom");
    expect(await bookingEvents(shp)).toHaveLength(0); // the throwing seq wrote nothing; no half-booking
  });

  it("PRODUCER: a committed quote.accepted enqueues EXACTLY the consumer's trigger; a quote.priced never does", async () => {
    const shp = "booking-producer";
    await seedShipment(shp);
    const sent: unknown[] = [];
    await patchAgentQueue(shp, async (m) => {
      sent.push(m);
    });

    const quoteId = await seedQuotePriced(shp); // must NOT enqueue a booking trigger
    await settle(() => sent.length > 0, 200);
    expect(sent).toHaveLength(0);

    const acceptId = await seedAccepted(shp, quoteId); // the ONLY event that enqueues the Booking trigger
    await settle(() => sent.length > 0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ kind: "quote.accepted", tenant: TENANT, shipment_id: shp, event_id: acceptId });
    expect(() => QuoteAcceptedTrigger.parse(sent[0])).not.toThrow(); // the producer satisfies the consumer's Zod boundary
  });

  it("the trigger's Zod boundary rejects a malformed message", () => {
    expect(() => QuoteAcceptedTrigger.parse({ kind: "quote.accepted", tenant: TENANT, shipment_id: "shp-1" })).toThrow(); // no event_id
    const ok = QuoteAcceptedTrigger.parse({ kind: "quote.accepted", tenant: TENANT, shipment_id: "shp-1", event_id: "evt-1" });
    expect(ok.event_id).toBe("evt-1");
  });
});
