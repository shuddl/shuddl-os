import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { EVENT_KINDS, type EventKind } from "@shuddl/contracts";
import { applyMigrations } from "../src/migrate.js";
import { projectMessages, applyMessageProjection } from "../src/projection/messages.js";
import { eventInsertStmt, mkEvent, resetEventCounter } from "./helpers.js";
import ledgerCore from "../../../db/tenant/migrations/0001_ledger_core.sql?raw";
import domain from "../../../db/tenant/migrations/0002_domain.sql?raw";
import insertGuards from "../../../db/tenant/migrations/0003_insert_guards.sql?raw";

// REQ-100 (WP-07 Concierge): "no communication exists outside the ledger" — every message is a
// message.* EVENT, and the `messages` table is a read-model PROJECTED from those events, exactly like
// money_lines is projected from invoice.* events. This projection writes the immutable message CONTENT
// (id/channel/direction/body_ref/thread + the event's own shipment_id); the RESOLUTION columns
// (party_id/resolved_conf/sla_due_ts) are left NULL for the Concierge (Task 4/6) to UPDATE later.

const DB = env.TENANT_A_DB;

describe("REQ-100 — projectMessages is a pure projection of the comms event", () => {
  it("message.received -> one 'in' row: CONTENT from payload; resolution columns NULL (party_refs/parse_confidence are IGNORED)", () => {
    // The event deliberately carries party_refs AND parse_confidence — the projection must NOT map them
    // into party_id/resolved_conf (those are the Concierge's resolution, a different quantity).
    const e = mkEvent("message.received", {
      stream_id: "s:shp-m1",
      shipment_id: "shp-m1",
      party_refs: ["party-shipper", "party-other"],
      payload: {
        channel: "sms",
        from_ref: "+15035551212",
        thread: "th-1",
        body_ref: "r2://msg/in-1",
        intent: "quote",
        parse_confidence: 8_500,
      },
    });
    const rows = projectMessages(e);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: `msg:${e.id}`,
      channel: "sms",
      direction: "in",
      party_id: null, // NOT party_refs[0] — resolution, filled by the Concierge later
      shipment_id: "shp-m1", // the event envelope's own binding (not a guess)
      resolved_conf: null, // NOT parse_confidence — a different quantity (see messages.ts header)
      thread: "th-1",
      body_ref: "r2://msg/in-1",
      drafted_by_agent: null, // never set on an inbound message
      sla_due_ts: null, // Task 8 owns SLA
    });
  });

  it("message.received with no thread -> thread NULL; resolution columns still NULL", () => {
    const e = mkEvent("message.received"); // fixture: {channel:email, from_ref, body_ref}, party_refs []
    const rows = projectMessages(e);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: `msg:${e.id}`,
      channel: "email",
      direction: "in",
      party_id: null,
      shipment_id: "shp-1", // fixture default
      resolved_conf: null,
      thread: null,
      body_ref: "r2://msg/inbound-1",
      drafted_by_agent: null,
      sla_due_ts: null,
    });
  });

  it("message.sent -> one 'out' row: drafted_by_agent + thread + channel from payload; resolution columns NULL", () => {
    const e = mkEvent("message.sent", {
      stream_id: "s:shp-m2",
      shipment_id: "shp-m2",
      party_refs: ["party-consignee"], // IGNORED — not mapped to party_id
      payload: {
        channel: "email",
        to_ref: "cons@example.com",
        thread: "th-2",
        body_ref: "r2://msg/out-1",
        drafted_by_agent: "concierge",
        in_reply_to: "evt-in-1",
      },
    });
    const rows = projectMessages(e);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: `msg:${e.id}`,
      channel: "email",
      direction: "out",
      party_id: null, // NOT party_refs[0]
      shipment_id: "shp-m2",
      resolved_conf: null,
      thread: "th-2",
      body_ref: "r2://msg/out-1",
      drafted_by_agent: "concierge",
      sla_due_ts: null,
    });
  });

  it("message.sent with no drafted_by_agent / no thread -> those columns NULL (exact row)", () => {
    const e = mkEvent("message.sent"); // fixture: {channel:email, to_ref, body_ref}, party_refs []
    const rows = projectMessages(e);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: `msg:${e.id}`,
      channel: "email",
      direction: "out",
      party_id: null,
      shipment_id: "shp-1", // fixture default
      resolved_conf: null,
      thread: null,
      body_ref: "r2://msg/outbound-1",
      drafted_by_agent: null,
      sla_due_ts: null,
    });
  });

  it("quote.sent projects NOTHING — it carries no channel/body_ref, so it cannot map to a messages row", () => {
    // quote.sent {quote_event_id, to_ref, message_event_id} has no `channel` for the NOT NULL
    // messages.channel column and no body_ref; its comms leg is the message.sent event it references
    // (message_event_id), and THAT event projects the row. So quote.sent projects [].
    const e = mkEvent("quote.sent");
    expect(projectMessages(e)).toEqual([]);
  });

  it("every NON-message kind projects [] (exhaustive switch + never guard)", () => {
    const MESSAGE_KINDS = new Set<EventKind>(["message.received", "message.sent"]);
    for (const kind of EVENT_KINDS) {
      if (MESSAGE_KINDS.has(kind)) continue;
      expect(projectMessages(mkEvent(kind)), `kind ${kind} must project no message`).toEqual([]);
    }
  });
});

describe("REQ-100 / I1 — applyMessageProjection through real D1 (append batch + OR IGNORE never clobbers a resolution)", () => {
  beforeAll(async () => {
    resetEventCounter();
    await applyMigrations(DB, [
      { path: "0001_ledger_core.sql", sql: ledgerCore },
      { path: "0002_domain.sql", sql: domain },
      { path: "0003_insert_guards.sql", sql: insertGuards },
    ]);
  });

  it("a message.received lands its messages row in the SAME batch as the event (I1); resolution columns NULL", async () => {
    const e = mkEvent("message.received", {
      stream_id: "s:shp-md",
      shipment_id: "shp-md",
      party_refs: ["party-shipper"], // IGNORED
      payload: { channel: "email", from_ref: "a@example.com", body_ref: "r2://msg/db-1", parse_confidence: 7_000 },
    });
    await DB.batch([eventInsertStmt(DB, e), ...applyMessageProjection(DB, e)]);
    const row = await DB.prepare(
      "SELECT id, channel, direction, party_id, shipment_id, resolved_conf, thread, body_ref, drafted_by_agent, sla_due_ts FROM messages WHERE id = ?",
    )
      .bind(`msg:${e.id}`)
      .first<Record<string, string | number | null>>();
    expect(row).toEqual({
      id: `msg:${e.id}`,
      channel: "email",
      direction: "in",
      party_id: null,
      shipment_id: "shp-md",
      resolved_conf: null,
      thread: null,
      body_ref: "r2://msg/db-1",
      drafted_by_agent: null,
      sla_due_ts: null,
    });
    // the event and its message row are both present (I1 both directions)
    const evt = await DB.prepare("SELECT COUNT(*) AS c FROM events WHERE id = ?").bind(e.id).first<{ c: number }>();
    expect(evt?.c).toBe(1);
  });

  it("re-projection is INSERT OR IGNORE: a Concierge resolution UPDATEd onto the row SURVIVES (never clobbered)", async () => {
    const e = mkEvent("message.received", {
      stream_id: "s:shp-mi",
      shipment_id: "shp-mi",
      party_refs: ["party-shipper"],
      payload: { channel: "email", from_ref: "x@example.com", body_ref: "r2://msg/idem" },
    });
    // Phase 1 — the projection INSERTs the content row (resolution columns NULL).
    await DB.batch([eventInsertStmt(DB, e), ...applyMessageProjection(DB, e)]);
    // Phase 2 — the Concierge (Task 4/6) RESOLVES the message: a mutable UPDATE fills party_id +
    // resolved_conf on the existing row (the `messages` table has no append-only guard).
    await DB.prepare("UPDATE messages SET party_id = ?, resolved_conf = ? WHERE id = ?")
      .bind("party-resolved", 9_900, `msg:${e.id}`)
      .run();
    // Phase 3 — a redelivery / crash-heal RE-PROJECTS the SAME event. OR IGNORE means the row already
    // exists by PK, so the INSERT is a no-op: the resolution MUST survive. (OR REPLACE would clobber it
    // back to NULL — this assertion kills that mutant and locks "re-projection never clobbers a resolution".)
    await DB.batch(applyMessageProjection(DB, e));
    const rows = await DB.prepare("SELECT id, party_id, resolved_conf FROM messages WHERE id = ?").bind(`msg:${e.id}`).all();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toEqual({ id: `msg:${e.id}`, party_id: "party-resolved", resolved_conf: 9_900 });
  });
});
