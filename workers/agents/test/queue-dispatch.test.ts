import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";

// WP-06 — queue() DISPATCH SEMANTICS (REQ-031/039). The Biller's business behavior is proven
// end-to-end in workers/api/test/biller.test.ts (the harness with the real DO + migrated D1); THIS
// file pins the thin dispatch contract that protects the queue itself:
//   · POISON (an unparseable body; an unknown tenant) is ACKed — redelivering a message that can
//     never parse/route would only delay real work. The loud log is the record until WP-11's DLQ
//     consumer (REQ-169) lands.
//   · a THROWN handler failure retries the MESSAGE (per-message, not the batch) — redelivery is the
//     retry, safe because the Biller's append id + email idempotency key are deterministic.
// Messages are hand-built fakes: miniflare exposes no way to push through a real queue here, and the
// dispatch contract is exactly the ack/retry calls — observing them IS the test.

interface FakeState {
  acked: boolean;
  retried: boolean;
  retryOpts: unknown;
}

function mkMessage(body: unknown): { message: Message; state: FakeState } {
  const state: FakeState = { acked: false, retried: false, retryOpts: undefined };
  const message = {
    id: crypto.randomUUID(),
    timestamp: new Date(0),
    body,
    attempts: 1,
    ack: (): void => {
      state.acked = true;
    },
    retry: (opts?: unknown): void => {
      state.retried = true;
      state.retryOpts = opts;
    },
  } as unknown as Message;
  return { message, state };
}

function mkBatch(messages: Message[]): MessageBatch {
  return {
    queue: "shuddl-agent-triggers-dev",
    messages,
    ackAll: (): void => {
      throw new Error("queue() must ack per-message, never the whole batch");
    },
    retryAll: (): void => {
      throw new Error("queue() must retry per-message, never the whole batch");
    },
  } as unknown as MessageBatch;
}

describe("agents queue() — per-message dispatch (REQ-031/039)", () => {
  it("POISON body (unparseable) → ACKed, never retried — redelivery cannot fix a shape", async () => {
    const bad = mkMessage({ kind: "pod.signed", tenant: "tenant-a" }); // missing shipment_id/event_id
    const junk = mkMessage("not even an object");
    await worker.queue(mkBatch([bad.message, junk.message]), env, createExecutionContext());
    expect(bad.state.acked).toBe(true);
    expect(bad.state.retried).toBe(false);
    expect(junk.state.acked).toBe(true);
    expect(junk.state.retried).toBe(false);
  });

  it("POISON tenant (not on the allowlist) → ACKed — REQ-025: no allowlist row, no D1, no retry loop", async () => {
    const { message, state } = mkMessage({ kind: "pod.signed", tenant: "tenant-evil", shipment_id: "shp-1", event_id: "evt-1" });
    await worker.queue(mkBatch([message]), env, createExecutionContext());
    expect(state.acked).toBe(true);
    expect(state.retried).toBe(false);
  });

  it("a THROWN handler → retry() called (per-message), not ack — redelivery is the retry", async () => {
    // A valid, routable message whose tenant D1 is UNMIGRATED in this harness (no events table) —
    // the handler's first D1 read throws, standing in for any transient D1/DO fault. Dispatch must
    // route that to retry(), never swallow it as an ack.
    const { message, state } = mkMessage({ kind: "pod.signed", tenant: "tenant-a", shipment_id: "shp-1", event_id: "evt-1" });
    await worker.queue(mkBatch([message]), env, createExecutionContext());
    expect(state.retried).toBe(true);
    expect(state.acked).toBe(false);
  });

  it("one poison message never stalls the batch: its neighbor is still dispatched", async () => {
    const poison = mkMessage(null);
    const throwing = mkMessage({ kind: "pod.signed", tenant: "tenant-a", shipment_id: "shp-2", event_id: "evt-2" });
    await worker.queue(mkBatch([poison.message, throwing.message]), env, createExecutionContext());
    expect(poison.state.acked).toBe(true);
    expect(throwing.state.retried).toBe(true); // processed independently, after the poison ack
  });

  // WP-07: the Concierge sibling rides the SAME queue, discriminated on `kind`. The dispatch contract is
  // identical — poison acks, an unknown tenant acks, a routable message whose D1 read throws retries.
  it("message.received POISON body (missing event_id) → ACKed as poison", async () => {
    const { message, state } = mkMessage({ kind: "message.received", tenant: "tenant-a" }); // no event_id
    await worker.queue(mkBatch([message]), env, createExecutionContext());
    expect(state.acked).toBe(true);
    expect(state.retried).toBe(false);
  });

  it("message.received POISON tenant (not on the allowlist) → ACKed (REQ-025)", async () => {
    const { message, state } = mkMessage({ kind: "message.received", tenant: "tenant-evil", event_id: "evt-1" });
    await worker.queue(mkBatch([message]), env, createExecutionContext());
    expect(state.acked).toBe(true);
    expect(state.retried).toBe(false);
  });

  it("message.received THROWN handler (unmigrated D1) → retry() (per-message), not ack", async () => {
    const { message, state } = mkMessage({ kind: "message.received", tenant: "tenant-a", event_id: "evt-1" });
    await worker.queue(mkBatch([message]), env, createExecutionContext());
    expect(state.retried).toBe(true);
    expect(state.acked).toBe(false);
  });

  it("an unknown kind → ACKed as poison (the discriminated union matches neither trigger)", async () => {
    const { message, state } = mkMessage({ kind: "invoice.issued", tenant: "tenant-a", event_id: "evt-1" });
    await worker.queue(mkBatch([message]), env, createExecutionContext());
    expect(state.acked).toBe(true);
    expect(state.retried).toBe(false);
  });

  // WP-08: the Booking agent rides the SAME queue, discriminated on kind (quote.accepted → Booking). The
  // dispatch contract is identical to the Biller/Concierge — poison acks, an unknown tenant acks, a routable
  // message whose D1 read throws retries.
  it("quote.accepted POISON body (missing shipment_id/event_id) → ACKed as poison", async () => {
    const bad = mkMessage({ kind: "quote.accepted", tenant: "tenant-a", shipment_id: "shp-1" }); // no event_id
    const alsoBad = mkMessage({ kind: "quote.accepted", tenant: "tenant-a", event_id: "evt-1" }); // no shipment_id
    await worker.queue(mkBatch([bad.message, alsoBad.message]), env, createExecutionContext());
    expect(bad.state.acked).toBe(true);
    expect(bad.state.retried).toBe(false);
    expect(alsoBad.state.acked).toBe(true);
    expect(alsoBad.state.retried).toBe(false);
  });

  it("quote.accepted POISON tenant (not on the allowlist) → ACKed (REQ-025)", async () => {
    const { message, state } = mkMessage({ kind: "quote.accepted", tenant: "tenant-evil", shipment_id: "shp-1", event_id: "evt-1" });
    await worker.queue(mkBatch([message]), env, createExecutionContext());
    expect(state.acked).toBe(true);
    expect(state.retried).toBe(false);
  });

  it("quote.accepted routable message → dispatched to the Booking agent (unmigrated D1 throws → retry(), NOT poison-ack)", async () => {
    // A valid, routable quote.accepted whose tenant D1 is UNMIGRATED in this harness (no events table): the
    // Booking agent's first D1 read throws, standing in for a transient fault. That it RETRIES (not acks)
    // proves the discriminated union matched quote.accepted and dispatch routed it to a real handler — had
    // quote.accepted not been wired, it would ack as poison instead.
    const { message, state } = mkMessage({ kind: "quote.accepted", tenant: "tenant-a", shipment_id: "shp-1", event_id: "evt-1" });
    await worker.queue(mkBatch([message]), env, createExecutionContext());
    expect(state.retried).toBe(true);
    expect(state.acked).toBe(false);
  });
});
