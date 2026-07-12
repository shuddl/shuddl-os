// REQ-061 / CLAUDE.md rule 6 — the IndexedDB-backed `QueueStore` the OfflineQueue (Task 6) writes to.
//
// DURABILITY (load-bearing): `put` and `remove` resolve on the transaction's `oncomplete` — i.e. ONLY
// after IDB has COMMITTED — not on the request's `onsuccess`. A tab-kill in the window between a
// signed airplane-mode capture and the commit would otherwise silently lose a POD. Awaiting a
// committed transaction is what makes an offline capture survive a crash. `deferred.bytes` (a
// Uint8Array photo/signature blob) round-trips via IDB's structured clone — no serialization needed.
import type { QueueItem, QueueStore } from "@shuddl/driver-core";
import { openDb, QUEUE_STORE } from "./idb.js";

export class IdbQueueStore implements QueueStore {
  private readonly dbp: Promise<IDBDatabase>;

  constructor(dbName?: string) {
    this.dbp = openDb(dbName);
  }

  async put(item: QueueItem): Promise<void> {
    const db = await this.dbp;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(QUEUE_STORE, "readwrite");
      tx.objectStore(QUEUE_STORE).put(item);
      tx.oncomplete = () => resolve(); // durable: the write has committed
      tx.onerror = () => reject(tx.error ?? new Error("queue put failed"));
      tx.onabort = () => reject(tx.error ?? new Error("queue put aborted"));
    });
  }

  async all(): Promise<QueueItem[]> {
    const db = await this.dbp;
    return new Promise<QueueItem[]>((resolve, reject) => {
      const tx = db.transaction(QUEUE_STORE, "readonly");
      const req = tx.objectStore(QUEUE_STORE).getAll();
      req.onsuccess = () => resolve(req.result as QueueItem[]);
      req.onerror = () => reject(req.error ?? new Error("queue getAll failed"));
    });
  }

  async remove(id: string): Promise<void> {
    const db = await this.dbp;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(QUEUE_STORE, "readwrite");
      tx.objectStore(QUEUE_STORE).delete(id);
      tx.oncomplete = () => resolve(); // durable: the delete has committed
      tx.onerror = () => reject(tx.error ?? new Error("queue remove failed"));
      tx.onabort = () => reject(tx.error ?? new Error("queue remove aborted"));
    });
  }
}
