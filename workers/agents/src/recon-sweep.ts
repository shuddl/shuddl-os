// WP-11 Task 13 — THE BILLER RECONCILIATION SWEEP (REQ-169). The scheduled backstop to the sequencer's
// commit→enqueue Biller trigger: a committed pod.signed normally fans a `pod.signed` trigger onto the agent
// queue (workers/api/src/do/sequencer.ts), which the Biller consumes and bills. If that enqueue is LOST — the
// DO crashed in the commit→enqueue window, or the push errored (it is best-effort by design, logged never
// thrown) — the POD is committed truth but NOTHING bills it: a silent revenue leak. This per-tenant cron finds
// those streams and RE-ENQUEUES the exact same `pod.signed` trigger the queue would have delivered, closing the
// window. The whole Biller pipeline is idempotent (deterministic invoice event id + DO dedupe-by-id + the send
// idempotency key), so re-driving is safe: twice in = once out.
//
// BOUNDED (the WP-11 sweep's bounding problem): a PERMANENT Biller hold (below_floor / no_quote /
// interline_unresolved / anomaly) writes a durable, idempotent HOLD MARKER (an internal message.received note —
// biller.ts emitTerminalHoldMarker). The recon anti-join (unbilledRedriveSql) EXCLUDES any shipment carrying a
// marker, so a permanently-held POD is re-enqueued AT MOST until the marker is written (once), then NEVER again.
// Without the marker exclusion this anti-join would re-drive a permanent hold every cron tick, forever (safe but
// unbounded/noisy). SELF-CLEARING: once a stream is billed (invoice.issued) OR held (marker), it drops out of the
// anti-join.
//
// Task 9 (REQ-170) BACKSTOP: the Biller now HOLDS(evidence_missing) — with NO invoice and NO terminal marker —
// a POD whose signature bytes are not yet stored. Such a POD stays in this anti-join (pod.signed AND NOT
// invoice.issued AND NO marker), so this sweep keeps re-driving it until the bytes are uploaded, at which point
// the re-drive bills it and it drops out. The evidence route's own post-upload re-drive is the fast path; this
// sweep is the backstop when that enqueue is lost. No change was needed here — an evidence-held POD is, by
// construction, exactly the unbilled-unheld shape the existing anti-join already recovers.
//
// SHARED PREDICATE (no drift): the unbilled core (pod.signed AND NOT invoice.issued) is the SAME
// @shuddl/ledger/queries/unbilled predicate the KPI "=0" tile and the Watchtower alarm read; unbilledRedriveSql
// EXTENDS it with the marker exclusion + the age filter (skill share-lint-matchers-with-parity-tests).
//
// TENANT ISOLATION (REQ-025): the caller binds `db`/`tenant`/`queue` to ONE tenant; the sweep reads only that
// D1 and re-enqueues triggers naming ONLY that tenant, so it can never touch another. PURITY OF INPUTS: `now` is
// supplied by the caller (the cron reads wall-clock); it feeds only the age cutoff.

import { scopeLike, unbilledRedriveSql } from "@shuddl/ledger/queries/unbilled";
import { PodSignedMessage } from "./biller.js";

// The minimum age (from COMMIT, p.recorded_at) before a POD's lost trigger is re-driven — comfortably past the
// agent queue's own redelivery envelope (max_retries with backoff) so the sweep never RACES a trigger that is
// still legitimately in flight. A just-committed POD stays untouched until this elapses; the marker/invoice
// exclusion is the PRIMARY bound, this is only to avoid needless double-drives (which are idempotent anyway).
export const RECON_MIN_AGE_MS = 10 * 60_000; // 10 minutes

// The re-enqueue seam — the minimal Queue producer surface the sweep needs. Production binds env.AGENT_QUEUE
// (the SAME queue the DO produces to and the agents worker consumes); a test injects a recording double. The
// return is `Promise<unknown>` so the real `Queue.send` (returns a QueueSendResponse) satisfies it; the sweep
// awaits but ignores the value.
export interface QueueLike {
  send(message: unknown): Promise<unknown>;
}

export interface ReconSweepOpts {
  /** Test-only id-prefix scope (the shared-D1 hook, mirrors the Watchtower). Undefined ⇒ whole-tenant. */
  scope?: string;
  /** Override the age window (tests inject a small one relative to a read-back recorded_at). */
  minAgeMs?: number;
}

export interface ReconSweepResult {
  /** Driving pod rows the anti-join matched (before per-shipment dedupe). */
  scanned: number;
  /** DISTINCT shipments eligible for re-drive (one trigger each). */
  candidates: number;
  /** Triggers ACTUALLY pushed onto the queue this pass. */
  enqueued: number;
}

/**
 * Sweep ONE tenant's ledger for DELIVERED-but-unbilled-and-unheld streams older than the window and RE-ENQUEUE
 * the Biller trigger for each. The caller binds `db`/`queue`/`tenant` to that one tenant (REQ-025). `now` is the
 * sweep clock (injected; the cron reads wall-clock). Idempotent + BOUNDED: safe to call every cron tick — once a
 * stream is billed (invoice.issued) or held (the terminal-hold marker) it drops out of the anti-join, so a
 * permanently-held POD is re-enqueued at most until its marker lands, then never again.
 */
export async function sweepTenantUnbilledRedrive(
  db: D1Database,
  queue: QueueLike,
  tenant: string,
  now: number,
  opts: ReconSweepOpts = {},
): Promise<ReconSweepResult> {
  const minAgeMs = opts.minAgeMs ?? RECON_MIN_AGE_MS;
  const params: (string | number)[] = [];
  const scoped = scopeLike("p.shipment_id", opts.scope, params); // pushes the scope param FIRST (if present)
  params.push(now - minAgeMs); // the age cutoff — bound to the trailing ` AND p.recorded_at < ?`
  const sql = unbilledRedriveSql("p.id AS pod_event_id, p.shipment_id AS shipment_id, p.seq AS seq", scoped, " AND p.recorded_at < ?");
  const rows = (await db.prepare(sql).bind(...params).all<{ pod_event_id: string; shipment_id: string; seq: number }>()).results;

  // ONE trigger per DISTINCT shipment — the LOWEST-seq unbilled pod (deterministic). The invoice event id
  // derives from THIS pod event id, so a re-run references the same pod → the same idempotent invoice.
  const byShipment = new Map<string, { pod_event_id: string; seq: number }>();
  for (const r of rows) {
    const prev = byShipment.get(r.shipment_id);
    if (prev === undefined || r.seq < prev.seq) byShipment.set(r.shipment_id, { pod_event_id: r.pod_event_id, seq: r.seq });
  }

  let enqueued = 0;
  for (const shipment_id of [...byShipment.keys()].sort()) {
    const pod_event_id = byShipment.get(shipment_id)!.pod_event_id;
    // EXACTLY the message the DO would have enqueued (the consumer's Zod boundary). Parse it here so a malformed
    // shape fails LOUD in the sweep, never as a silent poison message downstream.
    const trigger = PodSignedMessage.parse({ kind: "pod.signed", tenant, shipment_id, event_id: pod_event_id });
    try {
      await queue.send(trigger);
      enqueued += 1;
    } catch (err) {
      // A failed push is contained + logged, never fatal to the rest — the sweep is idempotent, so the next
      // tick re-drives this stream (nothing was billed, no marker written, still older than the window).
      console.error(`recon-sweep: re-enqueue failed for pod ${pod_event_id} on shipment ${shipment_id} (idempotent — next tick retries):`, err);
    }
  }
  return { scanned: rows.length, candidates: byShipment.size, enqueued };
}
