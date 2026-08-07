import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { readEvents } from "@shuddl/ledger/lens";
import { DeterministicParser, RecordingSender, SendError } from "@shuddl/agents";
import type { ConciergeParser, EvidenceMessage, EvidenceSender, SendReceipt } from "@shuddl/agents";
import { handleMessageReceived, SLA_REPLY_WINDOW_MS } from "../../agents/src/concierge.js";
import type { ConciergeDeps } from "../../agents/src/concierge.js";
import { sweepTenantOverdueInbound } from "../../agents/src/sla-sweep.js";
import type { SeqStubLike } from "../../agents/src/biller.js";
import { ANOMALY_RATE_CONFIG, TEST_RATE_CONFIG, TENANT_SLUG, ensureSchema, retryOnDoInvalidation, seedRateConfig } from "./helpers.js";

// ─── WP-07 Task 8 — SLA OVERDUE SWEEP (REQ-095) ─────────────────────────────────────────────────────
//
// The scheduled sweep's proof: it finds inbound `messages` rows whose sla_due_ts is past AND that have NO
// answering `message.sent` on their shipment stream, and RECORDS an overdue signal as an INTERNAL
// `message.received{channel:note, visibility:internal}` event appended THROUGH the real sequencer DO on the
// shipment stream — with a DETERMINISTIC id + body_ref derived from the overdue inbound's id, so the sweep is
// idempotent AND self-clearing (a re-run appends ZERO), mirroring the REQ-169 reconciliation sweep.
//
// VENUE (like concierge.test.ts / biller.test.ts): the real ShipmentSequencer DO + migrated tenant D1 live
// only in this api harness; the per-tenant sweep FUNCTION is imported from the agents worker and driven
// directly. `now` is injected so "overdue" is deterministic. isolatedStorage is OFF (shared D1) — every case
// scopes its per-STREAM assertions to its OWN inbound event id / derived shipment stream, and the sweep is
// global over the shared D1 by design (per-stream assertions stay correct even as it re-flags earlier rows).
// Every DO append is wrapped in retryOnDoInvalidation — pool-workers can invalidate the DO mid-run (a
// retriable-by-design reload); the retry self-heals it so the full-suite run is deterministic.

const TENANT = TENANT_SLUG;
const FROM_NAME = "Shuddl Dispatch";
let clock = 1_764_000_000_000;

const seqStub: SeqStubLike = {
  append: (req) =>
    retryOnDoInvalidation(() =>
      (env.SHIPMENT_SEQ.get(env.SHIPMENT_SEQ.idFromName(`${req.tenant}|${req.streamId}`)) as unknown as SeqStubLike).append(req),
    ),
};
function depsWith(sender: EvidenceSender, parser: ConciergeParser): ConciergeDeps {
  return { db: env.TENANT_A_DB, seq: seqStub, sender, parser, tenantFromName: FROM_NAME };
}

// A sender whose send PERMANENTLY fails (non-retriable) — the auto-reply message.sent commits, then the send
// HOLDS: the reply is RECORDED but never DELIVERED. The REQ-176 target (a held reply must not read as answered).
class PermanentFailSender implements EvidenceSender {
  async send(_m: EvidenceMessage): Promise<SendReceipt> {
    throw new SendError("resend rejected the send (422)", false);
  }
}

// A fresh quote email lands on a non-shipment intake stream (`q:…`) — no shipment yet.
async function appendInbound(from: string, body: string, streamSuffix: string): Promise<string> {
  const id = crypto.randomUUID();
  const appended = await seqStub.append({
    tenant: TENANT,
    streamId: `q:sla-${streamSuffix}`,
    input: {
      id,
      ts: clock++,
      actor: { party: "party-shipper" },
      party_refs: [],
      evidence: [],
      source: "email",
      confidence: 10_000,
      kind: "message.received",
      payload: { channel: "email", from_ref: from, body_ref: "r2://msg/inbound", subject: "Rate please", body },
    },
  });
  return (appended as { id: string }).id;
}

// A queued (held) inbound whose SLA is set by the consumer — the below-floor ($222k/1-lb) path.
async function seedOverdueInbound(streamSuffix: string): Promise<{ msgId: string; shipmentId: string; partyId: string; due: number }> {
  await seedRateConfig(env.TENANT_A_DB, ANOMALY_RATE_CONFIG);
  const msgId = await appendInbound(`${streamSuffix}@shipper.example.com`, "Quote from 97201 to 80016, 1 lb, 48x40x48.", streamSuffix);
  const outcome = await handleMessageReceived({ kind: "message.received", tenant: TENANT, event_id: msgId }, depsWith(new RecordingSender(), new DeterministicParser()));
  if (outcome.status !== "queued") throw new Error(`expected queued, got ${JSON.stringify(outcome)}`);
  const rec = await env.TENANT_A_DB.prepare("SELECT recorded_at FROM events WHERE id = ?").bind(msgId).first<{ recorded_at: number }>();
  return { msgId, shipmentId: outcome.shipment_id, partyId: outcome.party_id, due: rec!.recorded_at + SLA_REPLY_WINDOW_MS };
}

// A SUCCESSFULLY auto-replied inbound (the golden path) — REQ-174 sets its SLA at the top of the auto-reply
// block, but a message.sent(in_reply_to) answers it, so the sweep must NOT flag it.
async function seedAutoRepliedInbound(streamSuffix: string): Promise<{ msgId: string; shipmentId: string; due: number }> {
  await seedRateConfig(env.TENANT_A_DB, TEST_RATE_CONFIG);
  const msgId = await appendInbound(`${streamSuffix}@shipper.example.com`, "Please quote from 97201 to 80012, 1000 lbs, 48x40x48, 2 pallets.", streamSuffix);
  const outcome = await handleMessageReceived({ kind: "message.received", tenant: TENANT, event_id: msgId }, depsWith(new RecordingSender(), new DeterministicParser()));
  if (outcome.status !== "issued_replied") throw new Error(`expected issued_replied, got ${JSON.stringify(outcome)}`);
  const rec = await env.TENANT_A_DB.prepare("SELECT recorded_at FROM events WHERE id = ?").bind(msgId).first<{ recorded_at: number }>();
  return { msgId, shipmentId: outcome.shipment_id, due: rec!.recorded_at + SLA_REPLY_WINDOW_MS };
}

// The internal overdue-note events on a shipment stream (message.received{channel:note}).
async function overdueNotes(shipmentId: string): Promise<{ id: string; visibility: string }[]> {
  const res = await env.TENANT_A_DB.prepare(
    "SELECT id, visibility FROM events WHERE stream_id = ?1 AND kind = 'message.received' AND json_extract(payload,'$.channel') = 'note' ORDER BY seq",
  )
    .bind(`s:${shipmentId}`)
    .all<{ id: string; visibility: string }>();
  return res.results;
}

// An answering reply — an actual message.sent on the shipment stream carrying `in_reply_to` (the scoped
// "answered" signal). Pass the inbound event id to satisfy ITS SLA; pass an unrelated id to prove an
// unrelated outbound does NOT suppress it.
async function appendReply(shipmentId: string, inReplyTo: string): Promise<void> {
  await seqStub.append({
    tenant: TENANT,
    streamId: `s:${shipmentId}`,
    input: {
      id: crypto.randomUUID(),
      shipment_id: shipmentId,
      ts: clock++,
      actor: { party: "agent:concierge" },
      party_refs: [],
      evidence: [],
      source: "native",
      confidence: 10_000,
      kind: "message.sent",
      payload: { channel: "email", to_ref: "cust@example.com", body_ref: "r2://reply", in_reply_to: inReplyTo },
    },
  });
}

async function slaRow(eventId: string): Promise<{ sla_due_ts: number | null }> {
  const r = await env.TENANT_A_DB.prepare("SELECT sla_due_ts FROM messages WHERE id = ?")
    .bind(`msg:${eventId}`)
    .first<{ sla_due_ts: number | null }>();
  return r ?? { sla_due_ts: null };
}
async function eventsBySourceMessage(eventId: string): Promise<number> {
  const r = await env.TENANT_A_DB.prepare("SELECT COUNT(*) AS c FROM events WHERE json_extract(payload,'$.source_message_event_id') = ?")
    .bind(eventId)
    .first<{ c: number }>();
  return r?.c ?? 0;
}

beforeAll(async () => {
  await ensureSchema(env);
});

describe("SLA overdue sweep — flags an unanswered overdue inbound (REQ-095)", () => {
  it("does NOT flag before the due ts; flags exactly once AFTER it, as an INTERNAL note on the shipment stream (redacted from the counterparty lens)", async () => {
    const { shipmentId, partyId, due } = await seedOverdueInbound("overdue");

    // BEFORE due — sla_due_ts < now is false, so nothing is recorded on this stream.
    await sweepTenantOverdueInbound(env.TENANT_A_DB, seqStub, TENANT, due - 1);
    expect(await overdueNotes(shipmentId)).toHaveLength(0);

    // AFTER due — one internal overdue note lands, appended THROUGH the DO on the shipment stream.
    const res = await sweepTenantOverdueInbound(env.TENANT_A_DB, seqStub, TENANT, due + 1);
    expect(res.appended).toBeGreaterThanOrEqual(1);
    const notes = await overdueNotes(shipmentId);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.visibility).toBe("internal"); // the server stamped it internal (requested_visibility narrow)

    // REDACTED from the counterparty lens: the resolved party sees the quote.requested but NOT the note.
    const timeline = await readEvents(env.TENANT_A_DB, { scope: "party", partyId }, { shipment_id: shipmentId });
    expect(timeline.some((e) => e.kind === "quote.requested")).toBe(true); // counterparty-visible sibling
    expect(timeline.some((e) => e.id === notes[0]!.id)).toBe(false); // the internal note is hidden
  });

  it("does NOT flag an inbound whose SLA is satisfied by an answering message.sent (in_reply_to it)", async () => {
    const { msgId, shipmentId, due } = await seedOverdueInbound("answered");
    await appendReply(shipmentId, msgId); // an answering reply — in_reply_to THIS inbound

    await sweepTenantOverdueInbound(env.TENANT_A_DB, seqStub, TENANT, due + 1);
    expect(await overdueNotes(shipmentId)).toHaveLength(0); // no overdue note — the reply satisfied it
  });

  it("STILL flags when only an UNRELATED message.sent (different in_reply_to) is on the shared stream (fail-open guard, REQ-095)", async () => {
    const { shipmentId, due } = await seedOverdueInbound("unrelated");
    await appendReply(shipmentId, crypto.randomUUID()); // answers a DIFFERENT inbound — must NOT suppress

    await sweepTenantOverdueInbound(env.TENANT_A_DB, seqStub, TENANT, due + 1);
    expect(await overdueNotes(shipmentId)).toHaveLength(1); // the genuinely-overdue inbound is still flagged
  });

  it("IDEMPOTENT + SELF-CLEARING — a second run appends ZERO (query excludes the already-noted inbound)", async () => {
    const { shipmentId, due } = await seedOverdueInbound("idem");

    await sweepTenantOverdueInbound(env.TENANT_A_DB, seqStub, TENANT, due + 1);
    const second = await sweepTenantOverdueInbound(env.TENANT_A_DB, seqStub, TENANT, due + 1); // aggressive re-run
    expect(second.appended).toBe(0); // nothing new to record — bounded, not a per-tick re-append
    expect(await overdueNotes(shipmentId)).toHaveLength(1); // still exactly one
  });

  it("REQ-174 — does NOT flag a SUCCESSFULLY auto-replied inbound even though its SLA is set (the message.sent answers it)", async () => {
    // The auto-reply path now sets the inbound SLA (REQ-174 backstop). A SUCCESSFUL auto-reply carries a
    // message.sent(in_reply_to) — the sweep's ANSWERED check honors it, so the set SLA is never a false alarm.
    const { shipmentId, due } = await seedAutoRepliedInbound("autoreplied");
    await sweepTenantOverdueInbound(env.TENANT_A_DB, seqStub, TENANT, due + 1);
    expect(await overdueNotes(shipmentId)).toHaveLength(0); // answered → not flagged
  });

  it("REQ-176 — a PERMANENTLY-HELD auto-reply (message.sent committed, send held) is NOT counted answered — the sweep flags it overdue + a hold note surfaces the hold", async () => {
    // The auto-reply appends message.sent BEFORE the send. A PERMANENT send failure records the reply but never
    // DELIVERS it — it is HELD. A held message.sent must NOT clear the inbound's overdue timer (a DELIVERED
    // reply still does — the REQ-174 backstop, proven above, distinguishes sent from held by the hold note).
    // The Concierge surfaces the hold as an internal note keyed off the held message.sent id; the sweep's
    // ANSWERED check EXCLUDES a message.sent carrying that note, so the inbound stays overdue and is flagged.
    await seedRateConfig(env.TENANT_A_DB, TEST_RATE_CONFIG);
    const msgId = await appendInbound("heldreply@shipper.example.com", "Please quote from 97201 to 80012, 1000 lbs, 48x40x48, 2 pallets.", "heldreply");
    const deps: ConciergeDeps = { db: env.TENANT_A_DB, seq: seqStub, sender: new PermanentFailSender(), parser: new DeterministicParser(), tenantFromName: FROM_NAME };
    const outcome = await handleMessageReceived({ kind: "message.received", tenant: TENANT, event_id: msgId }, deps);
    expect(outcome.status, JSON.stringify(outcome)).toBe("issued_send_pending");
    if (outcome.status !== "issued_send_pending") throw new Error("unreachable");
    const shipmentId = outcome.shipment_id;

    // The hold SURFACED immediately: exactly one internal note (message.received{channel:note}) on the stream.
    expect(await overdueNotes(shipmentId)).toHaveLength(1);

    // REQ-174 set the SLA at the TOP of the auto-reply block (before the held send), so the inbound is a candidate.
    const rec = await env.TENANT_A_DB.prepare("SELECT recorded_at FROM events WHERE id = ?").bind(msgId).first<{ recorded_at: number }>();
    const due = rec!.recorded_at + SLA_REPLY_WINDOW_MS;
    expect((await slaRow(msgId)).sla_due_ts).toBe(due);

    // The sweep does NOT count the HELD message.sent as answered → it flags the inbound overdue (a NEW note).
    const res = await sweepTenantOverdueInbound(env.TENANT_A_DB, seqStub, TENANT, due + 1);
    expect(res.appended).toBeGreaterThanOrEqual(1);
    // The stream now carries BOTH notes (the hold note + the sweep's overdue note) — both message.received{note}.
    expect(await overdueNotes(shipmentId)).toHaveLength(2);
  });

    // CROSS-STREAM HOLD ISOLATION (audit §471). The ANSWERED check excludes a `message.sent` that carries a
    // hold note — and that exclusion must correlate the note to the SAME stream. Batching the check (one query
    // per chunk of pairs instead of one per row) makes the correlation explicit where it used to be implied by
    // a repeated `?1`, so this pins the property the rewrite could have lost.
    //
    // MEASURED: dropping `h.stream_id = s.stream_id` from the hold sub-query left all eight tests in this file
    // GREEN, because every one of them uses a single stream. A hold on ANY stream would then suppress an
    // answer on EVERY other — every answered inbound in the tenant would re-flag as overdue the moment one
    // reply anywhere was held.
    it("a HELD reply on ANOTHER stream does not resurrect an inbound that WAS answered (§471)", async () => {
      await seedRateConfig(env.TENANT_A_DB, TEST_RATE_CONFIG);

      // Stream 1: an inbound that IS answered by a delivered reply.
      const okId = await appendInbound("xstream-ok@shipper.example.com", "Please quote from 97201 to 80012, 1000 lbs, 48x40x48, 2 pallets.", "xstreamok");
      const okOut = await handleMessageReceived({ kind: "message.received", tenant: TENANT, event_id: okId }, depsWith(new RecordingSender(), new DeterministicParser()));
      expect(okOut.status, JSON.stringify(okOut)).toBe("issued_replied");

      // Stream 2: a DIFFERENT inbound whose reply is permanently HELD (the hold note lands on ITS stream).
      const heldId = await appendInbound("xstream-held@shipper.example.com", "Please quote from 97201 to 80012, 1000 lbs, 48x40x48, 2 pallets.", "xstreamheld");
      expect(
        (await handleMessageReceived({ kind: "message.received", tenant: TENANT, event_id: heldId }, depsWith(new PermanentFailSender(), new DeterministicParser()))).status,
      ).toBe("issued_send_pending");

      // Sweep past both due times. The ANSWERED one must stay answered — the foreign hold is not its hold.
      if (okOut.status !== "issued_replied") throw new Error("unreachable");
      const okShipment = okOut.shipment_id;
      const notesBefore = (await overdueNotes(okShipment)).length;
      const rec = await env.TENANT_A_DB.prepare("SELECT recorded_at FROM events WHERE id = ?").bind(okId).first<{ recorded_at: number }>();
      await sweepTenantOverdueInbound(env.TENANT_A_DB, seqStub, TENANT, rec!.recorded_at + SLA_REPLY_WINDOW_MS + 1);
      expect(
        (await overdueNotes(okShipment)).length,
        "a HELD reply on another stream must not put an overdue note on an ANSWERED inbound's shipment",
      ).toBe(notesBefore);
    });


  it("REQ-174 PARTIAL-APPEND BACKSTOP — a dead auto-reply (quote.requested committed, message.sent append threw) IS flagged overdue", async () => {
    // The auto-reply appends quote.requested → quote.priced → message.sent as three DO calls. Simulate a
    // transient DO fault on the message.sent append: the handler throws (its auto-reply appends are OUTSIDE
    // the pricing try/catch), leaving quote.requested committed with NO answering message.sent — the exact
    // silent-lost-reply window (redelivery would short-circuit to already_handled). REQ-174 set the SLA at the
    // TOP of the auto-reply block (BEFORE the appends), so this dead reply is backstopped by THIS sweep.
    await seedRateConfig(env.TENANT_A_DB, TEST_RATE_CONFIG);
    const from = "deadautoreply@shipper.example.com";
    const msgId = await appendInbound(from, "Please quote from 97201 to 80012, 1000 lbs, 48x40x48, 2 pallets.", "partialappend");
    const partialSeq: SeqStubLike = {
      append: (req) => {
        if ((req.input as { kind?: string }).kind === "message.sent") throw new Error("simulated DO fault before message.sent");
        return seqStub.append(req);
      },
    };
    const deps: ConciergeDeps = { db: env.TENANT_A_DB, seq: partialSeq, sender: new RecordingSender(), parser: new DeterministicParser(), tenantFromName: FROM_NAME };
    await expect(handleMessageReceived({ kind: "message.received", tenant: TENANT, event_id: msgId }, deps)).rejects.toThrow();

    // REQ-174: the SLA was set BEFORE the appends, so the inbound carries sla_due_ts even though the reply died.
    const rec = await env.TENANT_A_DB.prepare("SELECT recorded_at FROM events WHERE id = ?").bind(msgId).first<{ recorded_at: number }>();
    const due = rec!.recorded_at + SLA_REPLY_WINDOW_MS;
    expect((await slaRow(msgId)).sla_due_ts).toBe(due);

    // The shipment stream the committed quote.requested landed on (no message.sent there — the append threw).
    const qr = await env.TENANT_A_DB.prepare(
      "SELECT shipment_id FROM events WHERE kind = 'quote.requested' AND json_extract(payload,'$.source_message_event_id') = ?",
    )
      .bind(msgId)
      .first<{ shipment_id: string }>();
    const shipmentId = qr!.shipment_id;

    // The backstop fires: the sweep records EXACTLY ONE internal overdue note for the vanished reply.
    const res = await sweepTenantOverdueInbound(env.TENANT_A_DB, seqStub, TENANT, due + 1);
    expect(res.appended).toBeGreaterThanOrEqual(1);
    expect(await overdueNotes(shipmentId)).toHaveLength(1);
  });

  it("NO LOOP — driving the Concierge consumer on the internal note is a no-op (unresolved, no SLA, no append)", async () => {
    // Belt to the sequencer's enqueue guard (which never re-queues an internal note): even if the note DID
    // reach the consumer, it must do nothing — its empty body parses to unknown intent → unresolved.
    const { shipmentId, due } = await seedOverdueInbound("noteloop");
    await sweepTenantOverdueInbound(env.TENANT_A_DB, seqStub, TENANT, due + 1);
    const notes = await overdueNotes(shipmentId);
    expect(notes).toHaveLength(1);
    const noteId = notes[0]!.id;

    const outcome = await handleMessageReceived({ kind: "message.received", tenant: TENANT, event_id: noteId }, depsWith(new RecordingSender(), new DeterministicParser()));
    expect(outcome.status, JSON.stringify(outcome)).toBe("unresolved");
    expect((await slaRow(noteId)).sla_due_ts).toBeNull(); // the note gets NO SLA of its own
    expect(await eventsBySourceMessage(noteId)).toBe(0); // nothing appended off the note
  });
});
