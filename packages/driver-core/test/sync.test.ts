import { describe, expect, it } from "vitest";
import { OfflineQueue, type QueueStore, type QueueItem } from "../src/queue.js";
import { capture, type CaptureParams, type DeviceContext } from "../src/capture.js";
import { generateDeviceKey } from "../src/device-key.js";
import {
  syncOnce,
  classifyStatus,
  backoffDelay,
  DEFAULT_BACKOFF,
  OPERATOR_REPROBE_MS,
  type SyncPorts,
  type TransportResponse,
} from "../src/sync.js";

// Task 11 (REQ-016/017/030) — the DURABLE driver sync state machine, proven in isolation. Retry
// classification + phase transitions live HERE (pure over injected storage / clock / jitter / transports);
// the PWA wires the HTTP transports (apps/driver/src/sync). The state machine is:
//   captured → event_pending → event_acked → evidence_pending → evidence_acked → synced
// with reload-safe boundaries (persisted phase resumes without re-sending an acked event), 429/5xx
// backoff, a 401 auth block that halts the loop, and a 403/422 operator park.

// The in-memory async store the PWA's IDB adapter stands in for (mirrors queue.test.ts).
class MemStore implements QueueStore {
  readonly m = new Map<string, QueueItem>();
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

async function deviceCtx(): Promise<DeviceContext> {
  const dk = await generateDeviceKey();
  let n = 0;
  return { device_id: dk.device_id, privateKey: dk.keyPair.privateKey, party: "party-carrier", nextSeq: () => n++ };
}

async function enqueue(q: OfflineQueue, opts: { evidence?: boolean } = {}): Promise<string> {
  const ctx = await deviceCtx();
  const params: CaptureParams = opts.evidence
    ? {
        kind: "freight.photographed",
        payload: { photo_kind: "freight" },
        ts: 1,
        shipment_id: "s-1",
        evidence: { bytes: new TextEncoder().encode("photo-bytes"), field: "photo_hash" },
      }
    : { kind: "freight.counted", payload: { pieces: 3 }, ts: 1, shipment_id: "s-1" };
  const { event, deferred } = await capture(params, ctx);
  await q.enqueue(event, deferred);
  return event.id;
}

// A transport recorder: returns the next queued status (last one repeats), recording every call.
function recorder(statuses: number[]): ((...a: unknown[]) => Promise<TransportResponse>) & { calls: unknown[] } {
  let i = 0;
  const calls: unknown[] = [];
  const fn = async (...args: unknown[]): Promise<TransportResponse> => {
    calls.push(args[0]);
    const s = statuses[Math.min(i, statuses.length - 1)] ?? 200;
    i += 1;
    return { status: s };
  };
  return Object.assign(fn, { calls });
}

// A transport that must NEVER run (proves the engine does not re-send an already-acked leg).
const forbidden = async (): Promise<TransportResponse> => {
  throw new Error("this transport must not be called");
};

function ports(overrides: Partial<SyncPorts> & Pick<SyncPorts, "queue">): SyncPorts {
  return {
    now: () => 0,
    random: () => 0,
    sendEvent: recorder([200]),
    sendEvidence: recorder([200]),
    ...overrides,
  };
}

function phaseOf(store: MemStore, id: string): string | undefined {
  return store.m.get(id)?.sync?.phase;
}

describe("classifyStatus — pure retry classification (REQ-016)", () => {
  it("2xx acks; 401 is auth; 403/422 are operator; 429/5xx/network retry; other 4xx are operator", () => {
    expect(classifyStatus(200)).toBe("ack");
    expect(classifyStatus(201)).toBe("ack");
    expect(classifyStatus(401)).toBe("auth");
    expect(classifyStatus(403)).toBe("operator");
    expect(classifyStatus(422)).toBe("operator");
    expect(classifyStatus(400)).toBe("operator");
    expect(classifyStatus(404)).toBe("operator");
    expect(classifyStatus(429)).toBe("retry");
    expect(classifyStatus(500)).toBe("retry");
    expect(classifyStatus(503)).toBe("retry");
    expect(classifyStatus(0)).toBe("retry"); // network error
  });
});

describe("backoffDelay — monotonic, capped, jittered (REQ-016)", () => {
  it("grows with attempts, is bounded by maxMs, and adds bounded jitter", () => {
    expect(backoffDelay(1, DEFAULT_BACKOFF, () => 0)).toBe(DEFAULT_BACKOFF.baseMs);
    expect(backoffDelay(2, DEFAULT_BACKOFF, () => 0)).toBeGreaterThan(backoffDelay(1, DEFAULT_BACKOFF, () => 0));
    expect(backoffDelay(100, DEFAULT_BACKOFF, () => 0)).toBe(DEFAULT_BACKOFF.maxMs); // capped
    const jittered = backoffDelay(1, DEFAULT_BACKOFF, () => 0.5);
    expect(jittered).toBeGreaterThanOrEqual(DEFAULT_BACKOFF.baseMs);
    expect(jittered).toBeLessThan(DEFAULT_BACKOFF.baseMs + DEFAULT_BACKOFF.jitterMs);
  });
});

describe("syncOnce — the durable sync state machine (REQ-016/017/030)", () => {
  it("an event with NO evidence goes captured → synced in one online pass; sent once, then drained", async () => {
    const store = new MemStore();
    const q = new OfflineQueue(store);
    const id = await enqueue(q);
    const sendEvent = recorder([200]);
    const pass = await syncOnce(ports({ queue: q, sendEvent }));
    expect(pass.synced).toContain(id);
    expect(sendEvent.calls).toHaveLength(1);
    expect(await q.pending()).toHaveLength(0); // drained
  });

  it("an event WITH evidence walks the full chain and uploads the bytes exactly once", async () => {
    const store = new MemStore();
    const q = new OfflineQueue(store);
    const id = await enqueue(q, { evidence: true });
    const sendEvent = recorder([200]);
    const sendEvidence = recorder([200]);
    const pass = await syncOnce(ports({ queue: q, sendEvent, sendEvidence }));
    expect(pass.synced).toContain(id);
    expect(sendEvent.calls).toHaveLength(1);
    expect(sendEvidence.calls).toHaveLength(1);
    expect(await q.pending()).toHaveLength(0);
  });

  it("RELOAD after event ACK resumes at evidence upload — the event is NEVER re-sent", async () => {
    const store = new MemStore();
    const q1 = new OfflineQueue(store);
    const id = await enqueue(q1, { evidence: true });
    // Pass 1: event acks, but evidence is offline (503) → item parks at evidence_pending, backing off.
    await syncOnce(ports({ queue: q1, sendEvent: recorder([200]), sendEvidence: recorder([503]), now: () => 0 }));
    expect(phaseOf(store, id)).toBe("evidence_pending");

    // "Reload": a fresh engine over the SAME store. The event transport is forbidden — resuming must not
    // re-send the acked event. Advance the clock past the backoff so the evidence retry is due.
    const q2 = new OfflineQueue(store);
    const pass = await syncOnce(ports({ queue: q2, sendEvent: forbidden, sendEvidence: recorder([200]), now: () => 10_000_000 }));
    expect(pass.synced).toContain(id);
    expect(await q2.pending()).toHaveLength(0);
  });

  it("monotonic ACK: an already event_acked item never re-sends the event (duplicate delivery is safe)", async () => {
    const store = new MemStore();
    const q = new OfflineQueue(store);
    const id = await enqueue(q); // no evidence
    // Pre-persist the item as event_acked (as if a prior pass acked it).
    const item = store.m.get(id)!;
    await q.persist({ ...item, sync: { phase: "event_acked", attempts: 0, nextAttemptAt: 0 } });
    // The event transport is forbidden; a correct engine drains straight to synced without re-sending.
    const pass = await syncOnce(ports({ queue: q, sendEvent: forbidden }));
    expect(pass.synced).toContain(id);
    expect(await q.pending()).toHaveLength(0);
  });

  it("429 backs off: the item is not synced, holds event_pending, and is skipped until nextAttemptAt", async () => {
    const store = new MemStore();
    const q = new OfflineQueue(store);
    const id = await enqueue(q);
    const sendEvent = recorder([429, 200]);
    const first = await syncOnce(ports({ queue: q, sendEvent, now: () => 0 }));
    expect(first.synced).not.toContain(id);
    expect(phaseOf(store, id)).toBe("event_pending");
    expect(store.m.get(id)?.sync?.nextAttemptAt).toBeGreaterThan(0);
    expect(first.nextWake).toBeGreaterThan(0);

    // Before nextAttemptAt: the item is skipped, the transport is not called again.
    const before = await syncOnce(ports({ queue: q, sendEvent, now: () => 1 }));
    expect(before.synced).not.toContain(id);
    expect(sendEvent.calls).toHaveLength(1);

    // After nextAttemptAt: the retry lands and the item syncs.
    const after = await syncOnce(ports({ queue: q, sendEvent, now: () => 10_000_000 }));
    expect(after.synced).toContain(id);
  });

  it("5xx backs off exactly like 429 (retryable, never dropped)", async () => {
    const store = new MemStore();
    const q = new OfflineQueue(store);
    const id = await enqueue(q);
    const pass = await syncOnce(ports({ queue: q, sendEvent: recorder([500]), now: () => 0 }));
    expect(pass.synced).not.toContain(id);
    expect(phaseOf(store, id)).toBe("event_pending");
    expect(await q.pending()).toHaveLength(1); // still queued, not lost
  });

  it("401 halts the whole loop with an auth block; no item is synced past it", async () => {
    const store = new MemStore();
    const q = new OfflineQueue(store);
    const id1 = await enqueue(q);
    const id2 = await enqueue(q);
    const sendEvent = recorder([401]);
    const pass = await syncOnce(ports({ queue: q, sendEvent }));
    expect(pass.authBlocked).toBe(true);
    expect(pass.synced).toHaveLength(0);
    // The loop stopped at the first 401 — it did not attempt every queued item.
    expect(sendEvent.calls.length).toBeLessThan(2);
    expect(store.m.get(id1)?.sync?.blocked?.kind === "auth" || store.m.get(id2)?.sync?.blocked?.kind === "auth").toBe(true);
  });

  it("403 parks the item as an operator block — it is not retried on the next pass", async () => {
    const store = new MemStore();
    const q = new OfflineQueue(store);
    const id = await enqueue(q);
    const sendEvent = recorder([403]);
    const first = await syncOnce(ports({ queue: q, sendEvent }));
    expect(first.synced).not.toContain(id);
    expect(store.m.get(id)?.sync?.blocked?.kind).toBe("operator");
    // A parked item waits out its re-probe window rather than being hammered — but it is NOT skipped
    // forever (2026-08-01 convergence audit: the park had no exit and stranded signed captures).
    const second = await syncOnce(ports({ queue: q, sendEvent }));
    expect(second.synced).not.toContain(id);
    expect(sendEvent.calls).toHaveLength(1);
    expect(second.parked).toBe(1); // and it is VISIBLE, not silent
  });

  it("422 parks the item as an operator block too (a gate/validation refusal is not retryable)", async () => {
    const store = new MemStore();
    const q = new OfflineQueue(store);
    const id = await enqueue(q);
    const pass = await syncOnce(ports({ queue: q, sendEvent: recorder([422]) }));
    expect(pass.synced).not.toContain(id);
    expect(store.m.get(id)?.sync?.blocked?.kind).toBe("operator");
  });
});

// 2026-08-01 convergence audit (CRITICAL + High) — the two halves of the stranded-capture defect.
describe("drain order + park recovery — a signed capture can never be silently stranded", () => {
  // The real IndexedDB store returns ascending key order over `id` (a random UUID), NOT capture order.
  // This store reverses insertion order to stand in for that shuffle; the MemStore's Map (insertion
  // order) had been masking the bug entirely.
  class ShuffledStore implements QueueStore {
    readonly m = new Map<string, QueueItem>();
    async all(): Promise<QueueItem[]> {
      return [...this.m.values()].reverse();
    }
    async put(item: QueueItem): Promise<void> {
      this.m.set(item.id, item);
    }
    async remove(id: string): Promise<void> {
      this.m.delete(id);
    }
  }

  it("drains in CAPTURE order (device_seq) even when the store yields a shuffled order", async () => {
    const store = new ShuffledStore();
    const q = new OfflineQueue(store);
    const ctx = await deviceCtx(); // one device context ⇒ monotonic device_seq across the three captures
    const ids: string[] = [];
    for (const pieces of [1, 2, 3]) {
      const { event } = await capture({ kind: "freight.counted", payload: { pieces }, ts: 1, shipment_id: "s-1" }, ctx);
      await q.enqueue(event);
      ids.push(event.id);
    }

    const seen: string[] = [];
    const sendEvent = async (e: { id: string }): Promise<TransportResponse> => {
      seen.push(e.id);
      return { status: 202 };
    };
    await syncOnce(ports({ queue: q, sendEvent: sendEvent as never }));
    expect(seen).toEqual(ids); // capture order, NOT the store's reversed order
  });

  it("a parked item RE-PROBES after its window and drains when the refusal clears (an ordering race self-heals)", async () => {
    const store = new MemStore();
    const q = new OfflineQueue(store);
    const id = await enqueue(q);
    let clock = 1_000;
    const statuses = [403, 202];
    let i = 0;
    const sendEvent = async (): Promise<TransportResponse> => ({ status: statuses[Math.min(i++, statuses.length - 1)]! });

    const first = await syncOnce(ports({ queue: q, sendEvent: sendEvent as never, now: () => clock }));
    expect(first.synced).not.toContain(id);
    expect(first.parked).toBe(1);

    // Before the window elapses: still waiting, still visible, no extra send.
    const early = await syncOnce(ports({ queue: q, sendEvent: sendEvent as never, now: () => clock + 60_000 }));
    expect(early.synced).not.toContain(id);
    expect(i).toBe(1);

    // After it: re-probed, the server now accepts (the prerequisite landed), and the capture drains.
    clock += OPERATOR_REPROBE_MS + 1;
    const later = await syncOnce(ports({ queue: q, sendEvent: sendEvent as never, now: () => clock }));
    expect(later.synced).toContain(id);
    expect(store.m.has(id)).toBe(false); // drained — the ledger holds the fact
  });
});
