import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { readEvents } from "@shuddl/ledger/lens";
import { DeterministicParser, RecordingSender } from "@shuddl/agents";
import type { ConciergeParser, EvidenceSender } from "@shuddl/agents";
import { handleMessageReceived, SLA_REPLY_WINDOW_MS } from "../../agents/src/concierge.js";
import type { ConciergeDeps } from "../../agents/src/concierge.js";
import { sweepTenantOverdueInbound } from "../../agents/src/sla-sweep.js";
import type { SeqStubLike } from "../../agents/src/biller.js";
import { ANOMALY_RATE_CONFIG, TENANT_SLUG, ensureSchema, retryOnDoInvalidation, seedRateConfig } from "./helpers.js";

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
