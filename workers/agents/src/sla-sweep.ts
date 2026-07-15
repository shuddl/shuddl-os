// WP-07 Task 8 — THE SLA OVERDUE SWEEP (REQ-095). The scheduled complement to the Concierge consumer's
// SLA setter (concierge.ts setInboundSla): the consumer stamps `messages.sla_due_ts` on an inbound that is
// OWED a reply but was NOT auto-answered; this sweep, running per-tenant on the agents cron, finds the ones
// now PAST their due with NO answering `message.sent` and RECORDS an overdue signal.
//
// NO NEW EVENT KIND (the 35-catalog is frozen): the signal is an INTERNAL `message.received{channel:"note",
// visibility:"internal"}` event appended THROUGH the sequencer DO on the shipment stream — the SAME internal-
// note primitive Task 7 proved is redacted from the counterparty lens. Its id is DETERMINISTIC (derived from
// the overdue inbound's id), so the DO's dedupe-by-id makes a re-run a no-op; ON TOP of that, the sweep query
// EXCLUDES any inbound whose note already exists (keyed off the note's deterministic body_ref), so the sweep
// is SELF-CLEARING and BOUNDED — a queued inbound that never gets a human reply is flagged EXACTLY ONCE, not
// re-appended every tick. Idempotent + aggressive-safe, mirroring the REQ-169 Biller reconciliation sweep.
// Recording the signal as a ledger event (not a side-table flag) keeps "no communication outside the ledger"
// honest.
//
// TENANT ISOLATION (REQ-025): the caller binds `db` to ONE tenant's D1 and each append names that `tenant`,
// so the DO re-derives its identity from `${tenant}|${streamId}` and this sweep can never touch another tenant.
// PURITY OF INPUTS: `now` is supplied by the caller (the cron may read wall-clock); the signal's own ts is the
// deterministic due ts, so nothing here reads a fresh clock.

import type { SeqStubLike } from "./biller.js";

export interface SlaSweepResult {
  /** Overdue inbound rows returned by the query — genuinely-new candidates (note not yet present). */
  scanned: number;
  /** Internal overdue notes ACTUALLY appended this pass (excludes DO-dedup no-ops — the query already
   *  filtered out already-noted rows, so this is the count of genuinely-new signals). */
  appended: number;
  /** Candidates skipped because an answering message.sent (in_reply_to the inbound) exists on the stream. */
  answered_skipped: number;
}

// One overdue candidate: the inbound `messages` row joined to its shipment stream via the AUTHORITATIVE
// provenance link the consumer wrote (quote.requested.source_message_event_id). An inbound with no
// quote.requested has no stream to hang a note on and simply does not appear (an INNER JOIN) — it cannot be
// swept and is a WP-11 exceptions-queue concern, not a silent drop of a real reply obligation.
interface OverdueRow {
  msg_id: string; // the messages PK — `msg:<inbound event id>`
  due: number; // sla_due_ts (deterministic: inbound.recorded_at + WINDOW)
  stream_id: string; // `s:<shipment id>` — the shipment stream to record the note on
  shipment_id: string;
}

// substr(m.id, 5) strips the fixed `msg:` prefix (4 chars) to recover the inbound EVENT id the provenance /
// in_reply_to / note body_ref all key off. json_extract mirrors the consumer's own eventsBySourceMessage query.
//
// The NOT EXISTS clause is the SELF-CLEARING guard (REQ-169 parity): once THIS inbound's overdue note is on
// the stream (keyed off its DETERMINISTIC body_ref `concierge-sla-overdue/<inbound id>`), the row drops out of
// the candidate set — so a queued-forever inbound is flagged exactly once, never re-appended every tick. The
// "answered" check is deliberately NOT in this WHERE (kept as a scoped per-row query below) so the log can
// distinguish answered-skips from genuinely-new appends.
const OVERDUE_SQL =
  "SELECT m.id AS msg_id, m.sla_due_ts AS due, e.stream_id AS stream_id, e.shipment_id AS shipment_id " +
  "FROM messages m " +
  "JOIN events e ON e.kind = 'quote.requested' AND json_extract(e.payload, '$.source_message_event_id') = substr(m.id, 5) " +
  "WHERE m.direction = 'in' AND m.sla_due_ts IS NOT NULL AND m.sla_due_ts < ?1 " +
  "AND NOT EXISTS (" +
  "  SELECT 1 FROM events n WHERE n.stream_id = e.stream_id AND n.kind = 'message.received' " +
  "    AND json_extract(n.payload, '$.body_ref') = 'concierge-sla-overdue/' || substr(m.id, 5)" +
  ")";

// The answering-reply check — SCOPED to THIS inbound (in_reply_to the inbound event id), never ANY message.sent
// on the stream. A stream is shared (WP-08 booking comms, other threads); an unrelated outbound must not
// silently suppress a genuinely-overdue inbound (fail-CLOSED would drop a real reply obligation). The
// auto-reply the consumer sends carries `in_reply_to: <inbound event id>` (concierge.ts), so a satisfied SLA
// is precisely a message.sent that answers THIS inbound.
const ANSWERED_SQL =
  "SELECT 1 AS present FROM events WHERE stream_id = ?1 AND kind = 'message.sent' " +
  "AND json_extract(payload, '$.in_reply_to') = ?2 LIMIT 1";

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The overdue signal's event id — a domain-separated SHA-256 of the OVERDUE INBOUND's id, shaped into a
// v4-variant UUID (the same shaping biller.ts/concierge.ts use for EventInput's z.string().uuid()). The
// `sla-overdue` tag never collides with the concierge quote-event ids derived from the same inbound. The
// sequencer dedupes by this id, so even absent the query-level exclusion a re-run returns the ORIGINAL note.
async function overdueSignalId(inboundEventId: string): Promise<string> {
  const h = (await sha256Hex(`concierge:sla-overdue:${inboundEventId}`)).slice(0, 32);
  const variant = ((parseInt(h.slice(16, 17) || "0", 16) & 0x3) | 0x8).toString(16); // 8/9/a/b
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// The overdue note's DETERMINISTIC body_ref — the SELF-CLEARING key (OVERDUE_SQL excludes an inbound once a
// note with this body_ref is on its stream). One canonical shape, referenced by both the append and the SQL.
function overdueBodyRef(inboundEventId: string): string {
  return `concierge-sla-overdue/${inboundEventId}`;
}

/**
 * Sweep ONE tenant's ledger for overdue-unanswered inbounds and record an internal overdue note for each.
 * The caller binds `db`/`seq`/`tenant` to that one tenant (REQ-025). `now` is the sweep clock. Idempotent +
 * SELF-CLEARING: safe to call every cron tick — the query excludes already-noted rows (so a re-run appends
 * ZERO) and the deterministic signal id backstops the DO dedupe.
 */
export async function sweepTenantOverdueInbound(
  db: D1Database,
  seq: SeqStubLike,
  tenant: string,
  now: number,
): Promise<SlaSweepResult> {
  const rows = (await db.prepare(OVERDUE_SQL).bind(now).all<OverdueRow>()).results;
  let appended = 0;
  let answeredSkipped = 0;

  for (const row of rows) {
    const inboundEventId = row.msg_id.slice("msg:".length);

    // ANSWERED? The ledger is the truth (REQ-100): a real reply is a `message.sent` EVENT that answers THIS
    // inbound (in_reply_to) — NOT the drafted-but-unsent draft row the consumer records (recordDraft appends
    // no event) and NOT an unrelated outbound on the shared stream. So check the events, scoped to this inbound.
    const answered = await db.prepare(ANSWERED_SQL).bind(row.stream_id, inboundEventId).first<{ present: number }>();
    if (answered !== null) {
      answeredSkipped += 1;
      continue;
    }

    // RECORD the signal — an internal note on the shipment stream. requested_visibility narrows the
    // message.received default (counterparty) to internal; the DO stamps it server-side. The ts is the
    // deterministic due ts (no fresh clock). The deterministic id + the body_ref exclusion make it once-only.
    await seq.append({
      tenant,
      streamId: row.stream_id,
      input: {
        id: await overdueSignalId(inboundEventId),
        shipment_id: row.shipment_id,
        ts: row.due,
        actor: { party: "agent:concierge" },
        party_refs: [],
        evidence: [],
        source: "native",
        confidence: 10_000,
        requested_visibility: "internal",
        kind: "message.received",
        payload: { channel: "note", from_ref: "agent:concierge", body_ref: overdueBodyRef(inboundEventId) },
      },
    });
    appended += 1;
  }

  return { scanned: rows.length, appended, answered_skipped: answeredSkipped };
}
