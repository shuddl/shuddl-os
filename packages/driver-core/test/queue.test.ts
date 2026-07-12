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
