import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { QueueItem } from "@shuddl/driver-core";
import { IdbQueueStore } from "./idb-queue-store.js";
import { DurableSeq, IdbSeqStore, type SeqStore } from "./durable-seq.js";

type QueuedEvent = QueueItem["event"];

// A minimal EventInput-shaped stub — the storage layer treats it as opaque structured-clone data.
function stubEvent(id: string): QueuedEvent {
  return {
    id,
    ts: 1,
    actor: { party: "p:carrier", device: "dev_x" },
    party_refs: [],
    evidence: [],
    source: "native",
    confidence: 10_000,
    kind: "freight.counted",
    payload: { pieces: 3 },
    device_id: "dev_x",
    device_seq: 0,
  } as unknown as QueuedEvent;
}

let dbSeq = 0;
const freshDb = (): string => `test-driver-${Date.now()}-${dbSeq++}`;

describe("IdbQueueStore — durable offline capture queue (REQ-061, rule 6)", () => {
  it("put resolves only after commit: a fresh connection (post tab-kill) reads the item back", async () => {
    const name = freshDb();
    const store = new IdbQueueStore(name);
    const item: QueueItem = { id: "e1", event: stubEvent("e1") };
    await store.put(item); // resolves on tx.oncomplete

    // Simulate a tab-kill immediately after the await: a brand-new connection must already see it.
    const reopened = new IdbQueueStore(name);
    const all = await reopened.all();
    expect(all.map((i) => i.id)).toEqual(["e1"]);
  });

  it("round-trips deferred evidence bytes (Uint8Array) untouched", async () => {
    const store = new IdbQueueStore(freshDb());
    const bytes = new Uint8Array([9, 8, 7, 6, 5]);
    const item: QueueItem = {
      id: "e2",
      event: stubEvent("e2"),
      deferred: { hash: "a".repeat(64), bytes, field: "photo_hash" },
    };
    await store.put(item);
    const [got] = await store.all();
    expect(got?.deferred?.field).toBe("photo_hash");
    expect(Array.from(got?.deferred?.bytes ?? [])).toEqual([9, 8, 7, 6, 5]);
  });

  it("remove drops a synced item durably", async () => {
    const name = freshDb();
    const store = new IdbQueueStore(name);
    await store.put({ id: "e3", event: stubEvent("e3") });
    await store.put({ id: "e4", event: stubEvent("e4") });
    await store.remove("e3");
    const reopened = new IdbQueueStore(name);
    expect((await reopened.all()).map((i) => i.id).sort()).toEqual(["e4"]);
  });
});

describe("DurableSeq — monotonic across a simulated restart (REQ-016)", () => {
  it("a restart NEVER reuses a sequence number (the reset-to-0 footgun)", async () => {
    const store: SeqStore = new IdbSeqStore(freshDb());

    const s1 = await DurableSeq.open(store);
    const a = s1.nextSeq();
    const b = s1.nextSeq();
    const c = s1.nextSeq();
    expect([a, b, c]).toEqual([0, 1, 2]);

    // Simulate an app restart: a NEW DurableSeq over the SAME persisted store.
    const s2 = await DurableSeq.open(store);
    const d = s2.nextSeq();
    const e = s2.nextSeq();
    expect(d).toBeGreaterThan(c); // no reuse — strictly above session 1
    expect(e).toBe(d + 1);
    expect(new Set([a, b, c, d, e]).size).toBe(5); // all distinct
  });

  it("persists the ceiling BEFORE handing out — the store carries a reservation after open()", async () => {
    // An in-memory SeqStore that records the order of set() calls proves the reservation is committed
    // before nextSeq can mint anything (open() awaits reserve()).
    const writes: number[] = [];
    let ceiling = 0;
    const store: SeqStore = {
      get: async () => ceiling,
      set: async (v) => {
        ceiling = v;
        writes.push(v);
      },
    };
    const seq = await DurableSeq.open(store);
    expect(writes.length).toBe(1); // a reservation was committed during open, before any nextSeq
    expect(ceiling).toBeGreaterThan(0);
    const first = seq.nextSeq();
    expect(first).toBe(0);
    expect(first).toBeLessThan(ceiling); // the handed-out number sits inside the reserved range
  });

  it("IdbSeqStore get returns 0 before any set, and reads back what was set", async () => {
    const store = new IdbSeqStore(freshDb());
    expect(await store.get()).toBe(0);
    await store.set(4096);
    expect(await store.get()).toBe(4096);
  });

  it("refuses to mint an UNRESERVED seq when the durable refill fails (no silent reuse)", async () => {
    // Only the first reservation (during open) commits; every later refill rejects, so the ceiling
    // never advances past the initial block. nextSeq must throw at the ceiling — never hand out a
    // number the durable store hasn't reserved (which a restart would resume over and reuse).
    let ceiling = 0;
    let calls = 0;
    const store: SeqStore = {
      get: async () => ceiling,
      set: async (v) => {
        calls += 1;
        if (calls > 1) throw new Error("durable set failed");
        ceiling = v;
      },
    };
    const seq = await DurableSeq.open(store);
    const handed: number[] = [];
    let threw = false;
    try {
      for (let i = 0; i < 5000; i += 1) handed.push(seq.nextSeq()); // far more than one block
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(handed.length).toBeGreaterThan(0);
    expect(Math.max(...handed)).toBeLessThan(ceiling); // every minted number sits inside the reserved range
    expect(handed.length).toBeLessThanOrEqual(ceiling); // and no more than the reserved block was drawn
  });
});
