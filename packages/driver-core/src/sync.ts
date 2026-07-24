// Task 11 (REQ-016/017/030) — the DURABLE driver sync engine. PURE over injected ports: the durable
// queue (storage), a clock, a jitter source, and two transports (event append + evidence byte upload).
// It owns the retry CLASSIFICATION and the phase state machine; the PWA (apps/driver/src/sync) supplies
// the real HTTP transports. No DOM, no network, no timers here.
//
// State machine (persisted after every ACK, so a reload resumes at the exact boundary):
//   captured → event_pending → event_acked → evidence_pending → evidence_acked → synced
//
// A no-evidence item skips the evidence_* legs. Failures never drop an item:
//   · 2xx        → ACK, advance (a duplicate delivery re-acks — monotonic, never regresses).
//   · 429/5xx/0  → retryable, exponential backoff with jitter (still queued).
//   · 401        → AUTH block: halt the whole loop (the session is invalid; the UI clears it).
//   · 403/422/4xx→ OPERATOR block: park THIS item (a not-assigned / gate / validation refusal is not a
//                  timer-retry; a human/dispatcher must resolve it).
import type { EventInput } from "@shuddl/contracts";
import type { DeferredUpload } from "./capture.js";
import type { OfflineQueue, QueueItem, SyncState } from "./queue.js";

export interface TransportResponse {
  /** An HTTP-ish status. 0 denotes a network error (retryable). */
  status: number;
}
export type EventTransport = (event: EventInput) => Promise<TransportResponse>;
export type EvidenceTransport = (deferred: DeferredUpload, event: EventInput) => Promise<TransportResponse>;

export type RetryClass = "ack" | "retry" | "auth" | "operator";

// PURE classification — the single authority both legs share, so the event and evidence paths can never
// diverge on what a status means. Retryable: 2xx never (that's ack); network(0)/408/429/5xx yes. 401 is
// auth. Every OTHER 4xx (403/422/400/404/409/…) is an operator block — a permanent refusal that a blind
// timer-retry would only hammer; it needs a human/dispatcher, not a backoff.
export function classifyStatus(status: number): RetryClass {
  if (status >= 200 && status < 300) return "ack";
  if (status === 401) return "auth";
  if (status === 0 || status === 408 || status === 429 || (status >= 500 && status < 600)) return "retry";
  if (status >= 400 && status < 500) return "operator";
  return "retry"; // unknown/odd status — safest is a bounded retry, never a silent drop
}

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  factor: number;
  jitterMs: number;
}
export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 1000, maxMs: 60_000, factor: 2, jitterMs: 500 };

// PURE exponential backoff with bounded jitter. `attempts` is 1-based (the first failure ⇒ 1). Capped at
// maxMs, then a jitter of [0, jitterMs) drawn from the injected random source (deterministic in tests).
export function backoffDelay(attempts: number, opts: BackoffOptions, random: () => number): number {
  const exp = Math.min(opts.maxMs, Math.round(opts.baseMs * opts.factor ** (attempts - 1)));
  const jitter = Math.floor(random() * opts.jitterMs);
  return exp + jitter;
}

export interface SyncPorts {
  queue: OfflineQueue;
  now: () => number;
  random: () => number;
  sendEvent: EventTransport;
  sendEvidence: EvidenceTransport;
  backoff?: BackoffOptions;
}

export interface SyncPass {
  /** Ids that reached `synced` (and drained) this pass. */
  synced: string[];
  /** A 401 halted the loop — the UI must clear the session. */
  authBlocked: boolean;
  /** The earliest future retry time across still-waiting items, or null when none are waiting. */
  nextWake: number | null;
}

const phaseOf = (item: QueueItem): SyncState["phase"] => item.sync?.phase ?? "captured";

// The result of ONE advance step on one item.
type Step =
  | { kind: "moved" } // a phase transition happened; keep advancing this item
  | { kind: "synced"; id: string }
  | { kind: "waiting"; at: number }
  | { kind: "authBlock" }
  | { kind: "operatorBlock" };

// Apply a transport result to an item's CURRENT leg, persisting the new state. `leg` selects the phase to
// advance to on ACK and to back off on retry.
async function applyResult(
  item: QueueItem,
  leg: "event" | "evidence",
  res: TransportResponse,
  ports: SyncPorts,
): Promise<Step> {
  const cls = classifyStatus(res.status);
  const backoff = ports.backoff ?? DEFAULT_BACKOFF;
  const pendingPhase = leg === "event" ? "event_pending" : "evidence_pending";
  const ackedPhase = leg === "event" ? "event_acked" : "evidence_acked";
  const prevAttempts = item.sync?.attempts ?? 0;

  if (cls === "ack") {
    item.sync = { phase: ackedPhase, attempts: 0, nextAttemptAt: 0 };
    await ports.queue.persist(item);
    return { kind: "moved" };
  }
  if (cls === "retry") {
    const attempts = prevAttempts + 1;
    const at = ports.now() + backoffDelay(attempts, backoff, ports.random);
    item.sync = { phase: pendingPhase, attempts, nextAttemptAt: at };
    await ports.queue.persist(item);
    return { kind: "waiting", at };
  }
  if (cls === "auth") {
    item.sync = { phase: pendingPhase, attempts: prevAttempts, nextAttemptAt: ports.now(), blocked: { kind: "auth", status: res.status } };
    await ports.queue.persist(item);
    return { kind: "authBlock" };
  }
  // operator
  item.sync = { phase: pendingPhase, attempts: prevAttempts, nextAttemptAt: 0, blocked: { kind: "operator", status: res.status } };
  await ports.queue.persist(item);
  return { kind: "operatorBlock" };
}

async function drain(item: QueueItem, ports: SyncPorts): Promise<Step> {
  item.sync = { phase: "synced", attempts: 0, nextAttemptAt: 0 };
  await ports.queue.markSynced(item.id); // durable remove — the server holds the fact now
  return { kind: "synced", id: item.id };
}

// Advance an item by ONE step (at most one network call OR one bookkeeping transition), persisting the
// result. The caller loops until the item blocks / waits / syncs.
async function advanceItem(item: QueueItem, ports: SyncPorts): Promise<Step> {
  switch (phaseOf(item)) {
    case "captured":
    case "event_pending":
      return applyResult(item, "event", await ports.sendEvent(item.event), ports);
    case "event_acked":
      // Bookkeeping transition (no network): branch to the evidence leg or straight to drained.
      if (item.deferred) {
        item.sync = { phase: "evidence_pending", attempts: 0, nextAttemptAt: 0 };
        await ports.queue.persist(item);
        return { kind: "moved" };
      }
      return drain(item, ports);
    case "evidence_pending":
      if (!item.deferred) return drain(item, ports); // defensive: nothing to upload
      return applyResult(item, "evidence", await ports.sendEvidence(item.deferred, item.event), ports);
    case "evidence_acked":
      return drain(item, ports);
    case "synced":
      return drain(item, ports);
  }
}

/**
 * Run ONE synchronization pass over the durable queue. The PWA drives this on a timer / connectivity
 * change (apps/driver/src/sync/useSync.ts). Items that are backing off (nextAttemptAt in the future) or
 * operator-parked are skipped; a 401 halts the pass immediately with `authBlocked`.
 */
export async function syncOnce(ports: SyncPorts): Promise<SyncPass> {
  const items = await ports.queue.pending();
  const synced: string[] = [];
  let authBlocked = false;
  let nextWake: number | null = null;
  const noteWake = (at: number): void => {
    nextWake = nextWake === null ? at : Math.min(nextWake, at);
  };

  for (const item of items) {
    const state = item.sync;
    if (state?.blocked?.kind === "operator") continue; // parked — a human/dispatcher must resolve it
    if (state && state.nextAttemptAt > ports.now()) {
      noteWake(state.nextAttemptAt); // still backing off
      continue;
    }

    // Advance this item as far as it goes this pass (event → evidence → drained), stopping at the first
    // wait/block/sync. A guard bounds the transition chain (at most a handful of legs per item).
    for (let guard = 0; guard < 8; guard += 1) {
      const step = await advanceItem(item, ports);
      if (step.kind === "moved") continue;
      if (step.kind === "synced") synced.push(step.id);
      else if (step.kind === "waiting") noteWake(step.at);
      else if (step.kind === "authBlock") authBlocked = true;
      break;
    }
    if (authBlocked) break; // a 401 stops the whole loop — do not attempt further items
  }

  return { synced, authBlocked, nextWake };
}
