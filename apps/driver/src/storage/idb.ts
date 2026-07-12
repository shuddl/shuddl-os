// REQ-061 — the driver PWA's IndexedDB substrate. One database, two stores: `queue` (the offline
// capture queue, keyed by event id) and `meta` (the durable device-seq ceiling). Kept tiny and
// dependency-free; the durability guarantees live in the adapters that open transactions here.
export const DB_NAME = "shuddl-driver";
export const DB_VERSION = 1;
export const QUEUE_STORE = "queue";
export const META_STORE = "meta";

/**
 * Open (creating on first run) the driver database. `name` is injectable so tests can isolate a
 * database per case. Rejects — never hangs — on error/blocked so a caller's `await` always settles.
 */
export function openDb(name: string = DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(QUEUE_STORE)) db.createObjectStore(QUEUE_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB.open failed"));
    req.onblocked = () => reject(new Error("indexedDB.open blocked"));
  });
}

/** Read a value from the `meta` store (undefined if absent). Used for the persisted device keypair. */
export function metaGet<T = unknown>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, "readonly");
    const req = tx.objectStore(META_STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error ?? new Error("meta get failed"));
  });
}

/** Write a value to the `meta` store, resolving only after the transaction commits (durable). */
export function metaPut(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, "readwrite");
    tx.objectStore(META_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("meta put failed"));
    tx.onabort = () => reject(tx.error ?? new Error("meta put aborted"));
  });
}
