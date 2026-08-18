// WP-07 Task 8 — THE SLA OVERDUE SWEEP (REQ-095). The scheduled complement to the Concierge consumer's
// SLA setter (concierge.ts setInboundSla): the consumer stamps `messages.sla_due_ts` on an inbound that is
// OWED a reply but was NOT auto-answered; this sweep, running per-tenant on the agents cron, finds the ones
// now PAST their due with NO answering `message.sent` and RECORDS an overdue signal.
//
// THIS SWEEP IS ALSO THE ONLY BACKSTOP for the concierge redelivery KNOWN GAP (audit §102/§103): an
// auto-reply that dies AFTER appending quote.requested but BEFORE message.sent is treated as
// `already_handled` on redelivery and never completes — it is stranded, and this sweep surfacing it is the
// one thing that stops it being silently unanswered. That only works because `setInboundSla` runs BEFORE
// those appends, so a mid-flight death still leaves a due ts here to find. Reordering that in concierge.ts
// disconnects this backstop without failing anything obvious; audit §97 pins it
// (`workers/api/test/concierge.test.ts` — "the reply SLA is durable BEFORE the append").
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

import { nativeVisibleSourceSql } from "@shuddl/ledger/queries/unbilled";
import type { SeqStubLike } from "./biller.js";
import { deterministicUuid } from "@shuddl/contracts";

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
// SOURCE-AWARE (forward-safety): every `events` read here is restricted to NATIVE_VISIBLE_SOURCES (native/edi/
// email — EXCLUDES the `legacy` shadow) via nativeVisibleSourceSql, the SAME single definition the KPI/metrics/
// Watchtower aggregates share (@shuddl/ledger/queries/unbilled — no second copy). It is INERT today (no message
// kind is mirrored — MIRROR_KINDS is quote.priced/invoice.issued/split.computed/dispatch.assigned/appointment.set),
// but it upholds the invariant "native read-models exclude the legacy shadow" so a future comms mirror can never
// make this sweep count legacy messages. `<alias>.source` is a HARDCODED literal at each call site, never input.
const OVERDUE_SQL =
  "SELECT m.id AS msg_id, m.sla_due_ts AS due, e.stream_id AS stream_id, e.shipment_id AS shipment_id " +
  "FROM messages m " +
  "JOIN events e ON e.kind = 'quote.requested'" +
  nativeVisibleSourceSql("e.source") +
  " AND json_extract(e.payload, '$.source_message_event_id') = substr(m.id, 5) " +
  "WHERE m.direction = 'in' AND m.sla_due_ts IS NOT NULL AND m.sla_due_ts < ?1 " +
  "AND NOT EXISTS (" +
  "  SELECT 1 FROM events n WHERE n.stream_id = e.stream_id AND n.kind = 'message.received'" +
  nativeVisibleSourceSql("n.source") +
  "    AND json_extract(n.payload, '$.body_ref') = 'concierge-sla-overdue/' || substr(m.id, 5)" +
  ")";

// The answering-reply check — SCOPED to THIS inbound (in_reply_to the inbound event id), never ANY message.sent
// on the stream. A stream is shared (WP-08 booking comms, other threads); an unrelated outbound must not
// silently suppress a genuinely-overdue inbound (fail-CLOSED would drop a real reply obligation). The
// auto-reply the consumer sends carries `in_reply_to: <inbound event id>` (concierge.ts), so a satisfied SLA
// is precisely a message.sent that answers THIS inbound.
//
// REQ-176 — but a message.sent whose send PERMANENTLY FAILED was RECORDED yet never DELIVERED (it is HELD). A
// held reply must NOT read as answered — the overdue timer keeps running so ops sees the unanswered inbound.
// The Concierge surfaces a hold as an INTERNAL note keyed off the held message.sent id (body_ref
// `concierge-send-hold/<message.sent id>`, concierge.ts). So the "answered" signal is a message.sent that
// answers THIS inbound AND carries NO such hold note. A SUCCESSFUL send (no hold note) STILL clears the SLA —
// the REQ-174 backstop — because its message.sent has no correlated hold; only a HELD one is excluded here.
// BATCHED (audit §471). The per-row form below issued ONE D1 query per overdue inbound — an N+1 on a cron
// path, and Workers cap subrequests per invocation, so it fails HARD at volume rather than slowing down. It
// compounds §133: a DAILY cron policing a FOUR-HOUR SLA accumulates ~19h of overdue rows per tick.
//
// The correlation is on the PAIR. `?1`/`?2` became `IN (…)` lists, and the NOT EXISTS hold-check — which used
// `?1` for its own stream — now correlates to `s.stream_id`, or a hold on ANY listed stream would suppress an
// answer on a DIFFERENT one. The pair is re-formed in memory from the returned columns, so a `message.sent`
// answering inbound X on stream A can never clear inbound X on stream B (the case
// `workers/api/test/sla-sweep.test.ts` pins as "STILL flags when only an UNRELATED message.sent…").
const answeredBatchSql = (n: number): string => {
  const holes = Array.from({ length: n }, () => "?").join(",");
  return (
    `SELECT s.stream_id AS stream_id, json_extract(s.payload, '$.in_reply_to') AS in_reply_to ` +
    `FROM events s WHERE s.stream_id IN (${holes}) AND s.kind = 'message.sent'` +
    nativeVisibleSourceSql("s.source") +
    ` AND json_extract(s.payload, '$.in_reply_to') IN (${holes}) ` +
    `AND NOT EXISTS (` +
    `  SELECT 1 FROM events h WHERE h.stream_id = s.stream_id AND h.kind = 'message.received'` +
    nativeVisibleSourceSql("h.source") +
    `    AND json_extract(h.payload, '$.body_ref') = 'concierge-send-hold/' || s.id` +
    `)`
  );
};

/** Composite key — a stream/inbound PAIR, never either half alone. */
const pairKey = (streamId: string, inboundId: string): string => `${streamId}\u0000${inboundId}`;

// (The former per-row `ANSWERED_SQL` stood here. The REQ-100/174/176 reasoning above is unchanged and now
//  governs `answeredBatchSql`, which asks the same question for a whole chunk of PAIRS at once — audit §471.)


// The overdue signal's event id — a domain-separated SHA-256 of the OVERDUE INBOUND's id, shaped into a
// v4-variant UUID (the same shaping biller.ts/concierge.ts use for EventInput's z.string().uuid()). The
// `sla-overdue` tag never collides with the concierge quote-event ids derived from the same inbound. The
// sequencer dedupes by this id, so even absent the query-level exclusion a re-run returns the ORIGINAL note.
async function overdueSignalId(inboundEventId: string): Promise<string> {
  return deterministicUuid(`concierge:sla-overdue:${inboundEventId}`);
}

// The overdue note's DETERMINISTIC body_ref — the SELF-CLEARING key (OVERDUE_SQL excludes an inbound once a
// note with this body_ref is on its stream). One canonical shape, referenced by both the append and the SQL.
function overdueBodyRef(inboundEventId: string): string {
  // MEASURED (§1788), AND THE CONTRAST IS THE POINT. Two seams were starved:
  //
  //   the note's EVENT ID  → workers/agents 0 of 155 · workers/api 0 of 908   ← redundant here
  //   this BODY_REF        → workers/agents 0 of 155 · workers/api 1 of 908   ← the load-bearing seam
  //
  // The api case names itself: "IDEMPOTENT + SELF-CLEARING — a second run appends ZERO (query excludes the
  // already-noted inbound)". Re-append is prevented by OVERDUE_SQL's anti-join on THIS string, not by the
  // event id's determinism — so starving the id measures nothing, and a 0/0 there means the wrong seam was
  // starved rather than that the behaviour is uncovered.
  return `concierge-sla-overdue/${inboundEventId}`;
}

/**
 * Sweep ONE tenant's ledger for overdue-unanswered inbounds and record an internal overdue note for each.
 * The caller binds `db`/`seq`/`tenant` to that one tenant (REQ-025). `now` is the sweep clock. Idempotent +
 * SELF-CLEARING: safe to call every cron tick — the query excludes already-noted rows (so a re-run appends
 * ZERO) and the deterministic signal id backstops the DO dedupe.
 *
 * CADENCE HOLD (audit §133 — the sweep is correct, its SCHEDULE is not). `SLA_REPLY_WINDOW_MS` is FOUR
 * HOURS (concierge.ts), but the agents worker has ONE cron — `crons = ["0 1 * * *"]`, daily at 01:00 —
 * and all EIGHT contained sweeps ride it (sla · collector · recon · credit-recon · watchtower · retention ·
 * mirror · watchtower-snapshots — count re-measured 2026-08-05, audit §248; this comment read "seven" and
 * predated watchtower-snapshots). So an inbound arriving 02:00 is due at 06:00 and surfaces at 01:00 the
 * NEXT day: ~19 hours late, a detector six times coarser than the thing it measures. Daily is defensible
 * for the others (retention, mirror, dunning, reconciliation and the weekly snapshot are day-scale or
 * coarser); it is not for this one.
 * Idempotence above is exactly what makes the fix cheap — this is safe to run on a tighter tick — but
 * adding a second cron is a deploy-surface change, so it needs a REQ row first. See GO-LIVE-CHECKLIST.
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

  // ONE query per CHUNK, not per row (audit §471). 40 pairs = 80 bind params, comfortably inside SQLite's
  // 999-parameter ceiling with room for the source literals; a tick with 500 overdue rows now issues 13
  // queries instead of 500. The ANSWERED semantics are unchanged — see answeredBatchSql.
  const CHUNK = 40;
  const answeredPairs = new Set<string>();
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const streams = slice.map((r) => r.stream_id);
    const inbounds = slice.map((r) => r.msg_id.slice("msg:".length));
    const found = await db
      .prepare(answeredBatchSql(slice.length))
      .bind(...streams, ...inbounds)
      .all<{ stream_id: string; in_reply_to: string }>();
    for (const f of found.results) answeredPairs.add(pairKey(f.stream_id, f.in_reply_to));
  }

  for (const row of rows) {
    const inboundEventId = row.msg_id.slice("msg:".length);

    // ANSWERED? The ledger is the truth (REQ-100): a real reply is a `message.sent` EVENT that answers THIS
    // inbound (in_reply_to) — NOT the drafted-but-unsent draft row the consumer records (recordDraft appends
    // no event) and NOT an unrelated outbound on the shared stream. Resolved from the batched PAIR set above.
    if (answeredPairs.has(pairKey(row.stream_id, inboundEventId))) {
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
