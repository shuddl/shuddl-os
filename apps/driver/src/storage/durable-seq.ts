// REQ-016 / CLAUDE.md rule 6 — the DURABLE per-device sequence counter the capture leg draws from.
//
// Task 6 flagged the exact footgun: a counter that RESETS TO 0 on reboot re-emits `(device_id, seq)`
// pairs with DIFFERENT content, and `mergeByDeviceSeq` (first-wins) plus the sequencer's unique index
// then SILENTLY DROP the later one — signed airplane-mode data lost with no error. The fix is a counter
// whose high-water is persisted BEFORE any number in a range is handed out, and that NEVER resets.
//
// The capture port is SYNCHRONOUS (`DeviceContext.nextSeq(): number`) but IndexedDB is async, so this
// is a hi/lo allocator: `open()` (and each background refill) durably RESERVES a block ABOVE the
// persisted ceiling — awaiting the commit — before handing out anything in it. Every number returned by
// the sync `nextSeq()` was therefore covered by a reservation persisted before it was minted, and a
// later session always resumes ABOVE the persisted ceiling. So no number is ever REUSED across a
// restart (a GAP is harmless — the contract forbids reuse, not gaps). A block is far larger than a
// day's captures, and it tops up well before exhaustion, so a sync caller never outruns the reservation.
import { META_STORE, openDb } from "./idb.js";

/** The persisted high-water port: `get` reads the reserved ceiling (0 if none), `set` commits a new one. */
export interface SeqStore {
  get(): Promise<number>;
  set(value: number): Promise<void>;
}

const SEQ_KEY = "device_seq_ceiling";

/** IndexedDB implementation of {@link SeqStore}. `set` resolves only after commit (durable). */
export class IdbSeqStore implements SeqStore {
  private readonly dbp: Promise<IDBDatabase>;

  constructor(dbName?: string, private readonly key: string = SEQ_KEY) {
    this.dbp = openDb(dbName);
  }

  async get(): Promise<number> {
    const db = await this.dbp;
    return new Promise<number>((resolve, reject) => {
      const tx = db.transaction(META_STORE, "readonly");
      const req = tx.objectStore(META_STORE).get(this.key);
      req.onsuccess = () => resolve(typeof req.result === "number" ? req.result : 0);
      req.onerror = () => reject(req.error ?? new Error("seq get failed"));
    });
  }

  async set(value: number): Promise<void> {
    const db = await this.dbp;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(META_STORE, "readwrite");
      tx.objectStore(META_STORE).put(value, this.key);
      tx.oncomplete = () => resolve(); // durable before returning
      tx.onerror = () => reject(tx.error ?? new Error("seq set failed"));
      tx.onabort = () => reject(tx.error ?? new Error("seq set aborted"));
    });
  }
}

const BLOCK = 1024; // reservation size — dwarfs a day's captures
const REFILL_AT = 256; // top up the reservation this many numbers before exhaustion

export class DurableSeq {
  private next: number;
  private ceiling: number;
  private refilling = false;

  private constructor(private readonly store: SeqStore, floor: number) {
    this.next = floor;
    this.ceiling = floor; // nothing is handed out until the first reservation commits
  }

  /**
   * Load the persisted ceiling and reserve a fresh block ABOVE it — durably — before returning. The
   * returned counter therefore starts strictly above every number any prior session could have minted.
   */
  static async open(store: SeqStore): Promise<DurableSeq> {
    const persisted = await store.get();
    const seq = new DurableSeq(store, persisted);
    await seq.reserve();
    return seq;
  }

  /** Reserve the next block, persisting the new ceiling BEFORE it is drawn from (the durability point). */
  private async reserve(): Promise<void> {
    const newCeiling = this.ceiling + BLOCK;
    await this.store.set(newCeiling); // commit first — the persisted value only ever grows
    this.ceiling = newCeiling;
  }

  /**
   * Hand out the next sequence number synchronously from the durably-reserved block, and top the
   * reservation up in the background once it runs low. Monotonic within a session; never reused across.
   *
   * CEILING GUARD (load-bearing): refuse to mint a number at or beyond the durably-persisted ceiling.
   * If the background refill's `set` is failing (a broken durable store), the ceiling stops advancing;
   * handing out `this.next` anyway would emit an UNRESERVED seq — a restart resumes at the lower
   * persisted ceiling and REUSES it, and `mergeByDeviceSeq` (first-wins) silently drops the later
   * signed capture. That is the exact footgun this class exists to prevent, so we FAIL LOUD: capture()
   * throws (its caller's best-effort catch logs it) rather than let an unreserved seq escape. With the
   * refill threshold well inside a block dwarfing a day's captures, this never fires under a healthy store.
   */
  nextSeq(): number {
    if (this.next >= this.ceiling) {
      throw new Error(
        "DurableSeq: reservation exhausted — durable ceiling not advanced; refusing to mint an unreserved seq (REQ-016)",
      );
    }
    const value = this.next++;
    if (this.ceiling - this.next <= REFILL_AT && !this.refilling) {
      this.refilling = true;
      // A failed refill must NOT be swallowed into an advancing ceiling: keep the ceiling put (the
      // guard above then throws before crossing it) and clear the flag so a later call can retry.
      void this.reserve()
        .catch(() => undefined)
        .finally(() => {
          this.refilling = false;
        });
    }
    return value;
  }
}
