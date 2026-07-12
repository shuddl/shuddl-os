// REQ-016: the offline capture queue. Captured events accumulate here while the device is offline and
// drain when connectivity returns. Pure over an INJECTED store port: the PWA supplies an
// IndexedDB-backed `QueueStore` (Task 8); tests supply an in-memory one. No DOM, no IndexedDB, no
// network in this file — and NO global ordering assumptions (reconciliation is `mergeByDeviceSeq`).
import type { EventInput } from "@shuddl/contracts";
import type { DeferredUpload } from "./capture.js";

export interface QueueItem {
  /** The event id — the queue's primary key (re-enqueuing the same event is idempotent). */
  id: string;
  event: EventInput;
  /** The deferred evidence upload, if this capture carried bytes (REQ-017). */
  deferred?: DeferredUpload;
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

  /** Everything still awaiting sync. Order is the store's; callers must not assume a global order. */
  async pending(): Promise<QueueItem[]> {
    return this.store.all();
  }

  /** Drop an item once the sequencer has ACKed it. */
  async markSynced(id: string): Promise<void> {
    await this.store.remove(id);
  }
}
