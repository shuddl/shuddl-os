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

describe("§848: an UNKNOWN status is a bounded retry — never a silent drop", () => {
  // The default branch of classifyStatus: everything that is not 2xx / 401 / {0,408,429,5xx} / other-4xx.
  // Measured (§848) it catches 1xx, 3xx and >=600 — and the suite contained ZERO 3xx cases, so mutating the
  // default to "ack" left driver-core 42/42 GREEN.
  //
  // A 3xx is not exotic for this app; it is its normal failure mode. A CAPTIVE PORTAL on truck-stop, depot or
  // hotel wifi intercepts the upload and answers 302 → login page — the same environment the airplane-mode
  // soak exists to model. Classified as "ack", the queue would read the portal's redirect as the sequencer's
  // acceptance and DROP a signed, co-signed capture that never reached the server: silent evidence loss on
  // the path behind acceptance demo #3.
  it("a captive-portal 302 (and every other 3xx) RETRIES — it is never mistaken for an ack", () => {
    for (const status of [301, 302, 303, 304, 307, 308]) {
      expect(classifyStatus(status), `HTTP ${status} must retry, not ack — a redirect is not an append`).toBe("retry");
    }
  });

  it("1xx and out-of-range statuses also retry (the default is the SAFE sink)", () => {
    // A bounded retry is recoverable; an ack is not. Anything the classifier does not recognise must land
    // here, which is why the default returns "retry" rather than "operator" — parking is also a stranding.
    for (const status of [100, 101, 600, 700, 999]) {
      expect(classifyStatus(status), `HTTP ${status} must fall to the safe sink`).toBe("retry");
    }
  });

  it("the four recognised classes still hold at their boundaries (non-vacuity)", () => {
    // Without this, narrowing classifyStatus to `() => "retry"` would satisfy both assertions above.
    expect(classifyStatus(200)).toBe("ack");
    expect(classifyStatus(299)).toBe("ack");
    expect(classifyStatus(401)).toBe("auth");
    expect(classifyStatus(429)).toBe("retry");
    expect(classifyStatus(500)).toBe("retry");
    expect(classifyStatus(422)).toBe("operator");
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

  // §1499 (REQ-016/017/118) — A REHYDRATED evidence_pending ITEM WITH NO BYTES MUST DRAIN, NOT STALL.
  //
  // `advanceItem`'s `evidence_pending` case opens with `if (!item.deferred) return drain(item, ports)`, and
  // that guard was defended by nothing: deleting it left 52/52 green. In-process the guard IS redundant —
  // `event_acked` only advances to `evidence_pending` when `item.deferred` is truthy — but the queue is
  // DURABLE, and a pass begins by reading items back out of the store. Whatever wrote the record decides
  // its shape: an older schema, a store that persisted the envelope but not the bytes, a partial write.
  //
  // Without the guard that item calls `sendEvidence(undefined, …)` — and the failure is not a clean throw,
  // it is a capture that never drains: the item stays in the queue re-entering the same case on every pass,
  // which is the STRANDED-SIGNED-CAPTURE shape this state machine exists to prevent. Pinned by the drain,
  // by the untouched transport, and by the queue actually emptying.
  it("a REHYDRATED evidence_pending item whose bytes are gone DRAINS — sendEvidence is never called", async () => {
    const store = new MemStore();
    const q = new OfflineQueue(store);
    const id = await enqueue(q, { evidence: true });
    const item = store.m.get(id)!;
    // The rehydration shape: phase says evidence_pending, the record carries no bytes.
    const { deferred: _dropped, ...withoutBytes } = item;
    await q.persist({ ...withoutBytes, sync: { phase: "evidence_pending", attempts: 0, nextAttemptAt: 0 } });

    const pass = await syncOnce(ports({ queue: q, sendEvent: forbidden, sendEvidence: forbidden }));
    expect(pass.synced, "the item must drain rather than re-enter evidence_pending forever").toContain(id);
    expect(await q.pending(), "a stranded item would still be here on the next pass").toHaveLength(0);
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

  // §847 — THE DEFENSIVE HALF of the same sort, which was documented and untested.
  //
  // `pending()`'s comparator says: "Items without one (no device context) sort last but keep a stable
  // relative order, so nothing is dropped or reordered arbitrarily." Measured (§847): flipping that branch so
  // a seq-less item sorts FIRST left this suite 41/41 GREEN, because no test constructed one.
  //
  // REACHABILITY, so the test is not read as guarding a live bug. `capture.ts:128@nextSeq` mints a
  // `device_seq` on every capture, and the event contract refines `device_id ⟹ device_seq`
  // (`packages/contracts/src/events.ts:296@device_seq`), so an item can lack one only if it also lacks a
  // device — which the driver, co-signing every capture with a per-device key, never produces. The branch is
  // DEFENSIVE, not dead: `QueueItem.event` is typed as a general event, so a second producer makes it live.
  //
  // Why it matters if it ever does: sorting a seq-less item FIRST puts it ahead of ordered captures, and the
  // server's gates are order-dependent — the same 403-and-park that strands a signed capture forever.
  it("§847: an item with NO device_seq drains LAST, and ties keep insertion order", async () => {
    const store = new ShuffledStore();
    const q = new OfflineQueue(store);
    const ctx = await deviceCtx();

    // Two ordered captures…
    const ordered: string[] = [];
    for (const pieces of [1, 2]) {
      const { event } = await capture({ kind: "freight.counted", payload: { pieces }, ts: 1, shipment_id: "s-1" }, ctx);
      await q.enqueue(event);
      ordered.push(event.id);
    }
    // …and two device-less ones, enqueued BETWEEN and AFTER, so a stable sort is distinguishable from luck.
    const seqless: string[] = [];
    for (const n of [1, 2]) {
      const { event } = await capture({ kind: "freight.counted", payload: { pieces: 10 + n }, ts: 1, shipment_id: "s-1" }, ctx);
      const { device_id: _d, device_seq: _s, ...rest } = event as Record<string, unknown>;
      await q.enqueue(rest as never);
      seqless.push(rest["id"] as string);
    }

    const drained = (await q.pending()).map((i) => i.event.id);
    // The seq-carrying items come first, in CAPTURE order, regardless of how the store yielded them.
    expect(drained.slice(0, 2), "ordered captures must drain first, by device_seq").toEqual(ordered);
    // The seq-less pair comes LAST — that is the guarantee that matters, since sorting one FIRST is what
    // would put it ahead of a prerequisite and take the 403.
    expect(new Set(drained.slice(2)), "seq-less items must sort LAST").toEqual(new Set(seqless));

    // "Stable relative order" means relative to the STORE'S YIELD, not to insertion — a distinction this
    // test got wrong first time and the code got right. `ShuffledStore.all()` reverses, so the stable sort
    // must preserve that reversal among equals; asserting insertion order here would be asserting that the
    // sort UNDOES the shuffle for seq-less items, which it cannot and should not.
    const yielded = (await store.all()).map((i) => i.event.id).filter((id) => seqless.includes(id));
    expect(drained.slice(2), "ties keep the store's yield order (sort stability)").toEqual(yielded);
  });

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

  // §1269 — `parked` reaches a DRIVER'S SCREEN (apps/driver useSync), so it is an honest-instrument number:
  // it must be the count of stops actually parked, not a tally of park-ish events seen while looping.
  //
  // It was incremented at TWO sites — once at the top for an item already parked, once at the bottom for one
  // that parked during the pass — and the two cases are not disjoint. Both defects below were live and neither
  // was covered: every existing case either kept the item backing off (so the bottom site never ran) or let
  // the refusal CLEAR (so it drained). The uncovered middle is the ordinary one: a refusal that persists.
  it("§1269: a parked item whose RE-PROBE FAILS AGAIN counts ONCE, not twice", async () => {
    const store = new MemStore();
    const q = new OfflineQueue(store);
    await enqueue(q);
    let clock = 1_000;
    const sendEvent = recorder([403, 403]);
    const first = await syncOnce(ports({ queue: q, sendEvent, now: () => clock }));
    expect(first.parked).toBe(1);
    clock += OPERATOR_REPROBE_MS + 1;
    const second = await syncOnce(ports({ queue: q, sendEvent, now: () => clock }));
    expect(sendEvent.calls, "the window elapsed, so it really did re-probe").toHaveLength(2);
    expect(second.parked, "ONE parked stop must report as one, not two").toBe(1);
  });

  it("§1269: a parked item that DRAINS on its re-probe stops being counted as parked", async () => {
    const store = new MemStore();
    const q = new OfflineQueue(store);
    const id = await enqueue(q);
    let clock = 1_000;
    const sendEvent = recorder([403, 202]);
    expect((await syncOnce(ports({ queue: q, sendEvent, now: () => clock }))).parked).toBe(1);
    clock += OPERATOR_REPROBE_MS + 1;
    const later = await syncOnce(ports({ queue: q, sendEvent, now: () => clock }));
    expect(later.synced, "the re-probe was accepted").toContain(id);
    expect(later.parked, "a stop that just drained is not a parked stop").toBe(0);
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

// REQ-016/069 §579 — A BACKING-OFF ITEM MUST NOT STRAND THE ITEMS BEHIND IT.
//
// `syncOnce` skips an item whose `nextAttemptAt` is still in the future with `continue`, NOT `break` — so a
// single 429'd capture does not hold up every later one. A prior audit iteration found exactly that defect
// (signed captures stranded behind one backed-off item) and fixed it. **Nothing was testing the fix.**
//
// Measured at §579: turning that `continue` back into a `break` left `packages/driver-core` (39 tests) AND
// `apps/driver` (68 tests) fully green. The existing cases could not see it —
//   • the 429 backoff case has ONE item, so there is nothing behind it to strand;
//   • the drain-order case has three items but all are READY, so the backoff branch never runs.
// The discriminating input is the combination neither builds: **a backing-off item followed by a ready one.**
//
// This is the failure mode that matters most for acceptance demo #3. It is invisible online (nothing backs
// off), and it strands evidence on a driver's phone in airplane mode — the one place nobody is watching.
describe("REQ-016 §579: one backed-off item does not block the queue behind it", () => {
  it("a ready item still drains while an earlier item is backing off", async () => {
    const store = new MemStore();
    const q = new OfflineQueue(store);
    const stalled = await enqueue(q); // captured first ⇒ drains first
    const ready = await enqueue(q);

    // Put the FIRST item into a live backoff window; the second is untouched and ready.
    const item = store.m.get(stalled)!;
    await q.persist({ ...item, sync: { phase: "event_pending", attempts: 1, nextAttemptAt: 10_000 } });

    const sendEvent = recorder([200]);
    const pass = await syncOnce(ports({ queue: q, sendEvent, now: () => 0 }));

    expect(pass.synced, "the ready item was stranded behind a backing-off one").toContain(ready);
    expect(pass.synced, "the backing-off item must NOT have been attempted this pass").not.toContain(stalled);
    // And the pass still reports when to come back for the stalled one.
    expect(pass.nextWake).toBe(10_000);
  });

  it("the transport is called for the ready item ONLY — the skip is a skip, not a silent send", async () => {
    const store = new MemStore();
    const q = new OfflineQueue(store);
    const stalled = await enqueue(q);
    await enqueue(q);
    const item = store.m.get(stalled)!;
    await q.persist({ ...item, sync: { phase: "event_pending", attempts: 1, nextAttemptAt: 10_000 } });

    const sendEvent = recorder([200]);
    await syncOnce(ports({ queue: q, sendEvent, now: () => 0 }));
    expect(sendEvent.calls, "exactly one send: the ready item").toHaveLength(1);
  });
});
