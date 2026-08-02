// REQ-016: the offline capture queue. Captured events accumulate here while the device is offline and
// drain when connectivity returns. Pure over an INJECTED store port: the PWA supplies an
// IndexedDB-backed `QueueStore` (Task 8); tests supply an in-memory one. No DOM, no IndexedDB, no
// network in this file — and NO global ordering assumptions (reconciliation is `mergeByDeviceSeq`).
import type { EventInput } from "@shuddl/contracts";
import type { DeferredUpload } from "./capture.js";

// Task 11 (REQ-016/017) — the DURABLE sync phase persisted per queue item. The sync engine (sync.ts)
// advances an item through this state machine and PERSISTS the phase after each ACK, so a tab-kill /
// reload resumes at the exact boundary and never re-sends an already-acked leg:
//   captured → event_pending → event_acked → evidence_pending → evidence_acked → synced
export type SyncPhase =
  | "captured"
  | "event_pending"
  | "event_acked"
  | "evidence_pending"
  | "evidence_acked"
  | "synced";

export interface SyncState {
  phase: SyncPhase;
  /** Retry attempts for the CURRENT leg (drives the exponential backoff). */
  attempts: number;
  /** Clock ms before which this item must not be retried (0 = ready now). */
  nextAttemptAt: number;
  /**
   * A terminal-ish block. `auth` (401) halts the whole sync loop until the session is refreshed; `operator`
   * (403/422) parks THIS item pending a dispatcher/operator resolution — neither is retried on a timer.
   */
  blocked?: { kind: "auth" | "operator"; status: number };
}

export interface QueueItem {
  /** The event id — the queue's primary key (re-enqueuing the same event is idempotent). */
  id: string;
  event: EventInput;
  /** The deferred evidence upload, if this capture carried bytes (REQ-017). */
  deferred?: DeferredUpload;
  /** The durable sync phase. Absent on a freshly-enqueued item ⇒ treated as `captured`. */
  sync?: SyncState;
}

/**
 * The injected persistence port — ASYNC, because the PWA backs it with IndexedDB (`deferred.bytes`
 * holds photo/signature blobs, too large for synchronous localStorage). Keyed by `QueueItem.id`.
 *
 * DURABILITY CONTRACT: `put`/`remove` MUST resolve only AFTER the write is durable (e.g. the IDB
 * transaction has committed). A sync port would force a fire-and-forget in-memory mirror, so a
 * tab-kill between `enqueue()` and the IDB write would lose a signed airplane-mode POD (CLAUDE.md
 * rule 6). Awaiting a durable `put` is what makes an offline capture survive a crash.
 */
export interface QueueStore {
  all(): Promise<QueueItem[]>;
  put(item: QueueItem): Promise<void>;
  remove(id: string): Promise<void>;
}

export class OfflineQueue {
  constructor(private readonly store: QueueStore) {}

  /** Add (or replace, by id) a captured event awaiting sync. Resolves once the write is durable. */
  async enqueue(event: EventInput, deferred?: DeferredUpload): Promise<void> {
    await this.store.put(deferred ? { id: event.id, event, deferred } : { id: event.id, event });
  }

  /**
   * Everything still awaiting sync, in CAPTURE ORDER (2026-08-01 convergence audit, Critical).
   *
   * The store's own order is NOT capture order: the real IndexedDB store returns ascending key order
   * over `id`, and an event id is a random UUID — so a drain in store order shuffles the queue. The
   * server's transition gates are ORDER-DEPENDENT (consent before stop.arrived; count+photo+custody
   * before stop.departed; arrival+POD+placed photo before delivery.evidenced), so a shuffled drain
   * makes a gated event arrive before its prerequisite, take a 403 GATE_BLOCKED, and get parked
   * permanently — a signed airplane-mode capture silently stranded on the device forever.
   *
   * `device_seq` is the per-device monotonic capture counter minted at capture time (REQ-016), which
   * is exactly the ordering the gates assume. Items without one (no device context) sort last but keep
   * a stable relative order, so nothing is dropped or reordered arbitrarily.
   */
  async pending(): Promise<QueueItem[]> {
    const items = await this.store.all();
    return items
      .map((item, index) => ({ item, index }))
      .sort((a, b) => {
        const sa = a.item.event.device_seq;
        const sb = b.item.event.device_seq;
        if (sa === undefined && sb === undefined) return a.index - b.index; // stable
        if (sa === undefined) return 1;
        if (sb === undefined) return -1;
        return sa === sb ? a.index - b.index : sa - sb;
      })
      .map((w) => w.item);
  }

  /** Drop an item once the sequencer has ACKed it. */
  async markSynced(id: string): Promise<void> {
    await this.store.remove(id);
  }

  /**
   * Durably persist an item's updated state (its sync phase). The sync engine calls this after every leg
   * so the phase survives a reload — the durable `put` resolves only after the write commits (same
   * durability contract as `enqueue`), which is what makes "resume after event ACK" crash-safe.
   */
  async persist(item: QueueItem): Promise<void> {
    await this.store.put(item);
  }
}
