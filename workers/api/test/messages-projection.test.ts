import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { AppendedEvent } from "../src/do/sequencer.js";
import { TENANT_SLUG, ensureSchema } from "./helpers.js";

// REQ-100 (WP-07 Concierge) / I1 — a COMMITTED message.* event must project its `messages` read-model
// row IN THE SAME db.batch() as the event INSERT (atomic), exactly like invoice.* projects money_lines.
// This drives the REAL sequencer DO and then SELECTs from `messages` to prove the row landed with the
// right columns and that the event is present in the same commit.

const TENANT = TENANT_SLUG;

type SeqStub = DurableObjectStub & {
  append(req: { tenant: string; streamId: string; input: unknown }): Promise<AppendedEvent>;
};
function stubFor(streamId: string): SeqStub {
  return env.SHIPMENT_SEQ.get(env.SHIPMENT_SEQ.idFromName(`${TENANT}|${streamId}`)) as unknown as SeqStub;
}

function inputFor(streamId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    shipment_id: streamId.startsWith("s:") ? streamId.slice(2) : undefined,
    ts: 1_720_000_000_000,
    actor: { party: "party-shipper" },
    party_refs: [],
    evidence: [],
    source: "native",
    confidence: 10_000,
    kind: "quote.requested",
    payload: { request: { origin_zip: "97201", dest_zip: "98101" } },
    ...over,
  };
}

beforeAll(async () => {
  await ensureSchema(env);
});

describe("REQ-100 — message.* projects a messages row in the same batch as the event (I1)", () => {
  it("an inbound message.received lands its messages row (content atomically; resolution columns NULL)", async () => {
    const streamId = "s:shp-msg-in";
    const stub = stubFor(streamId);
    const r = await stub.append({
      tenant: TENANT,
      streamId,
      input: inputFor(streamId, {
        kind: "message.received",
        party_refs: ["party-shipper"], // IGNORED — party_id is the Concierge's resolution, not party_refs[0]
        payload: { channel: "email", from_ref: "shipper@example.com", thread: "th-inbound", body_ref: "r2://msg/api-in", parse_confidence: 8_800 },
      }),
    });

    const msg = await env.TENANT_A_DB.prepare(
      "SELECT id, channel, direction, party_id, shipment_id, resolved_conf, thread, body_ref, drafted_by_agent, sla_due_ts FROM messages WHERE id = ?",
    )
      .bind(`msg:${r.id}`)
      .first<Record<string, string | number | null>>();
    expect(msg).toEqual({
      id: `msg:${r.id}`,
      channel: "email",
      direction: "in",
      party_id: null, // resolution — NOT party_refs[0]
      shipment_id: "shp-msg-in",
      resolved_conf: null, // resolution — NOT parse_confidence
      thread: "th-inbound",
      body_ref: "r2://msg/api-in",
      drafted_by_agent: null,
      sla_due_ts: null,
    });

    // I1 both directions: the event and its projected message row committed together.
    const evt = await env.TENANT_A_DB.prepare("SELECT COUNT(*) AS c FROM events WHERE id = ?").bind(r.id).first<{ c: number }>();
    expect(evt?.c).toBe(1);
  });

  it("an outbound message.sent lands an 'out' row with drafted_by_agent mapped", async () => {
    const streamId = "s:shp-msg-out";
    const stub = stubFor(streamId);
    const r = await stub.append({
      tenant: TENANT,
      streamId,
      input: inputFor(streamId, {
        kind: "message.sent",
        party_refs: ["party-consignee"],
        payload: { channel: "email", to_ref: "cons@example.com", thread: "th-outbound", body_ref: "r2://msg/api-out", drafted_by_agent: "concierge", in_reply_to: "evt-in" },
      }),
    });
    const msg = await env.TENANT_A_DB.prepare(
      "SELECT direction, channel, party_id, body_ref, drafted_by_agent, resolved_conf FROM messages WHERE id = ?",
    )
      .bind(`msg:${r.id}`)
      .first<Record<string, string | number | null>>();
    expect(msg).toEqual({
      direction: "out",
      channel: "email",
      party_id: null, // resolution — NOT party_refs[0]
      body_ref: "r2://msg/api-out",
      drafted_by_agent: "concierge",
      resolved_conf: null,
    });
  });

  it("a NON-message kind (quote.requested) projects no messages row", async () => {
    const streamId = "s:shp-msg-none";
    const stub = stubFor(streamId);
    const r = await stub.append({ tenant: TENANT, streamId, input: inputFor(streamId) }); // quote.requested
    const n = await env.TENANT_A_DB.prepare("SELECT COUNT(*) AS c FROM messages WHERE id = ?").bind(`msg:${r.id}`).first<{ c: number }>();
    expect(n?.c).toBe(0);
  });
});
