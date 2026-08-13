import { describe, expect, it } from "vitest";
import { OfflineQueue, type QueueStore, type QueueItem } from "../src/queue.js";
import { capture, type DeviceContext } from "../src/capture.js";
import { generateDeviceKey } from "../src/device-key.js";

// The in-memory async store the PWA's IndexedDB adapter stands in for (Task 8). Keyed by QueueItem.id.
// Async on purpose: the real port awaits a durable IDB commit (see QueueStore's durability contract).
class MemStore implements QueueStore {
  private readonly m = new Map<string, QueueItem>();
  async all(): Promise<QueueItem[]> {
    return [...this.m.values()];
  }
  async put(item: QueueItem): Promise<void> {
    this.m.set(item.id, item);
  }
  async remove(id: string): Promise<void> {
    this.m.delete(id);
  }
}

async function ctx(): Promise<DeviceContext> {
  const dk = await generateDeviceKey();
  let n = 0;
  return { device_id: dk.device_id, privateKey: dk.keyPair.privateKey, party: "party-carrier", nextSeq: () => n++ };
}

describe("OfflineQueue over an injected async store (REQ-016/017)", () => {
  it("enqueues a captured event and lists it in pending()", async () => {
    const q = new OfflineQueue(new MemStore());
    const { event } = await capture({ kind: "freight.counted", payload: { pieces: 3 }, actor_party: "p", ts: 1 }, await ctx());
    await q.enqueue(event);
    const pending = await q.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(event.id);
    expect(pending[0]?.deferred).toBeUndefined();
  });

  it("carries the deferred evidence upload when capture produced one (REQ-017)", async () => {
    const q = new OfflineQueue(new MemStore());
    const bytes = new TextEncoder().encode("photo-bytes");
    const { event, deferred } = await capture(
      { kind: "freight.photographed", payload: { photo_kind: "freight" }, actor_party: "p", ts: 1, evidence: { bytes, field: "photo_hash" } },
      await ctx(),
    );
    await q.enqueue(event, deferred);
    const item = (await q.pending())[0];
    expect(item?.deferred?.bytes).toBe(bytes); // the ORIGINAL bytes ride the queue, not the event
    expect(item?.deferred?.hash).toBe(deferred?.hash);
    expect(item?.deferred?.field).toBe("photo_hash");
  });

  it("markSynced removes an item on ACK", async () => {
    const q = new OfflineQueue(new MemStore());
    const { event } = await capture({ kind: "freight.counted", payload: { pieces: 1 }, actor_party: "p", ts: 1 }, await ctx());
    await q.enqueue(event);
    expect(await q.pending()).toHaveLength(1);
    await q.markSynced(event.id);
    expect(await q.pending()).toHaveLength(0);
  });

  it("re-enqueuing the same event id is idempotent (collapses to one)", async () => {
    const q = new OfflineQueue(new MemStore());
    const { event } = await capture({ kind: "freight.counted", payload: { pieces: 1 }, actor_party: "p", ts: 1 }, await ctx());
    await q.enqueue(event);
    await q.enqueue(event);
    expect(await q.pending()).toHaveLength(1);
  });
});


// §1271 — THE DRAIN ORDER'S TIEBREAKS. `pending()` is a four-branch comparator: both-undefined → insertion
// index, undefined LAST (either side), and equal-seq → insertion index. Only the seq direction was exercised:
// flipping `sa - sb` REDs 2, while dropping the index tiebreaks or flipping undefined-last each left the
// package at 49/49 GREEN.
//
// This is the drain order for signed captures (CLAUDE.md rule 6), and the file this defect class already bit
// once — the 2026-08-01 convergence audit found a park with no exit that stranded evidence. Order matters here
// for a specific reason: the server dedups on (shipment, device_id, device_seq), so a capture that arrives
// before its prerequisite takes a 403 and parks. Draining in seq order is what keeps that from happening, and
// "undefined last" is what keeps a server-origin item from jumping ahead of the device's own sequence.
//
// Items are placed in the store directly: `capture()` always assigns a seq from the DeviceContext, so an
// undefined-seq item is not reachable through it.
describe("§1271 pending() drain order — every branch of the comparator", () => {
  function item(id: string, device_seq: number | undefined): QueueItem {
    const event = {
      id,
      shipment_id: "shp-1",
      ts: 1_720_000_000_000,
      actor: device_seq === undefined ? { party: "p" } : { party: "p", device: "dev_a" },
      party_refs: [],
      evidence: [],
      source: "native",
      confidence: 10_000,
      kind: "freight.counted",
      payload: { pieces: 1 },
      ...(device_seq === undefined ? {} : { device_id: "dev_a", device_seq, sig: "c2ln" }),
    } as unknown as QueueItem["event"];
    return { id, event };
  }

  it("device-sequenced items drain in seq order, BEFORE any item without a seq", async () => {
    const store = new MemStore();
    // Inserted worst-case: the seq-less item first, and the sequenced ones descending — so neither insertion
    // order nor its reverse is the answer (§1260).
    for (const it of [item("no-seq-a", undefined), item("s2", 2), item("s0", 0), item("no-seq-b", undefined), item("s1", 1)]) {
      await store.put(it);
    }
    const ids = (await new OfflineQueue(store).pending()).map((i) => i.id);
    expect(ids, "seq order first, then the seq-less items").toEqual(["s0", "s1", "s2", "no-seq-a", "no-seq-b"]);
  });

  it("items WITHOUT a seq keep their insertion order among themselves (stable, not arbitrary)", async () => {
    const store = new MemStore();
    for (const it of [item("third", undefined), item("first", undefined), item("second", undefined)]) await store.put(it);
    const ids = (await new OfflineQueue(store).pending()).map((i) => i.id);
    expect(ids, "no seq to compare ⇒ the order they were captured in").toEqual(["third", "first", "second"]);
  });

  it("items sharing a seq keep their insertion order (a duplicate seq must not reorder the queue)", async () => {
    const store = new MemStore();
    // A repeated (device, seq) is exactly what the server's unique index dedups — locally they must stay in
    // capture order so the FIRST one is the one that drains first.
    for (const it of [item("dup-late", 5), item("dup-early", 5), item("low", 1)]) await store.put(it);
    const ids = (await new OfflineQueue(store).pending()).map((i) => i.id);
    expect(ids).toEqual(["low", "dup-late", "dup-early"]);
  });
});
