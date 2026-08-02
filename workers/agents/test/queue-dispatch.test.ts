import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { TENANT_POLICY_MALFORMED_REASON, VALIDATION_FAILED_PREFIX } from "@shuddl/contracts";
import worker from "../src/index.js";

// WP-06 — queue() DISPATCH SEMANTICS (REQ-031/039). The Biller's business behavior is proven
// end-to-end in workers/api/test/biller.test.ts (the harness with the real DO + migrated D1); THIS
// file pins the thin dispatch contract that protects the queue itself:
//   · POISON (an unparseable BODY) is ACKed — redelivering a message that can never parse would only
//     delay real work; there is no tenant to recover it for.
//   · an UNKNOWN TENANT is RETRIED, never acked (2026-08-01 audit, C3): the api worker + sequencer DO
//     serve claimed pool tenants this worker's static roster cannot resolve, so "unknown" here can mean
//     "not yet rostered", not "garbage". retry() → max_retries → the configured DLQ
//     (shuddl-agent-dlq-*, wrangler.toml) parks it as a recoverable record — an invoice trigger is
//     destroyed by ack, and no sweep can rebuild it for a tenant the crons cannot enumerate.
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

  it("UNKNOWN tenant (not on the static roster) → RETRIED toward the DLQ, never acked — a pool tenant's invoice trigger must survive (REQ-025/169)", async () => {
    const { message, state } = mkMessage({ kind: "pod.signed", tenant: "tenant-unrostered", shipment_id: "shp-1", event_id: "evt-1" });
    await worker.queue(mkBatch([message]), env, createExecutionContext());
    expect(state.retried).toBe(true);
    expect(state.acked).toBe(false);
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

  // 2026-08-02 §23 — a DETERMINISTIC refusal is retried toward the DLQ (the recoverable-record law) but is
  // LOGGED AS DETERMINISTIC, naming the operator action. The sequencer refuses every append for a tenant
  // whose control-plane policy row is unusable or absent (§18/§19). Five identical "retriable failure …
  // will redeliver" lines tell an operator to wait for something that will never clear, and name no fix.
  it("a tenant-policy refusal → still retry() toward the DLQ, but logged as DETERMINISTIC with the fix", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Stand in for the sequencer refusal: the handler throws the same message the DO raises.
      const spy = vi.spyOn(env.TENANT_A_DB, "prepare").mockImplementation(() => {
        throw new Error(`${VALIDATION_FAILED_PREFIX}{"reason":"${TENANT_POLICY_MALFORMED_REASON}"}`);
      });
      const { message, state } = mkMessage({ kind: "pod.signed", tenant: "tenant-a", shipment_id: "shp-det", event_id: "evt-det" });
      await worker.queue(mkBatch([message]), env, createExecutionContext());
      spy.mockRestore();

      // The POSTURE is unchanged — the trigger must survive as a recoverable record, never be acked away.
      expect(state.retried, "the trigger must still reach the DLQ").toBe(true);
      expect(state.acked, "a refusal is never acked away — that would lose the trigger").toBe(false);

      // The DIAGNOSIS is what changed.
      const lines = errSpy.mock.calls.flat().filter((a): a is string => typeof a === "string");
      expect(lines.some((l) => l.includes("DETERMINISTIC refusal")), "must name it deterministic").toBe(true);
      expect(lines.some((l) => l.includes("until an operator fixes the tenants row")), "must name the fix").toBe(true);
      expect(lines.some((l) => l.includes("retriable failure")), "must NOT also claim it is retriable").toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("one poison message never stalls the batch: its neighbor is still dispatched", async () => {
    const poison = mkMessage(null);
    const throwing = mkMessage({ kind: "pod.signed", tenant: "tenant-a", shipment_id: "shp-2", event_id: "evt-2" });
    await worker.queue(mkBatch([poison.message, throwing.message]), env, createExecutionContext());
    expect(poison.state.acked).toBe(true);
    expect(throwing.state.retried).toBe(true); // processed independently, after the poison ack
  });

  // WP-07: the Concierge sibling rides the SAME queue, discriminated on `kind`. The dispatch contract is
  // identical — an unparseable body acks, an unknown tenant retries toward the DLQ, a routable message
  // whose D1 read throws retries.
  it("message.received POISON body (missing event_id) → ACKed as poison", async () => {
    const { message, state } = mkMessage({ kind: "message.received", tenant: "tenant-a" }); // no event_id
    await worker.queue(mkBatch([message]), env, createExecutionContext());
    expect(state.acked).toBe(true);
    expect(state.retried).toBe(false);
  });

  it("message.received UNKNOWN tenant → RETRIED toward the DLQ, never acked (REQ-025/169)", async () => {
    const { message, state } = mkMessage({ kind: "message.received", tenant: "tenant-unrostered", event_id: "evt-1" });
    await worker.queue(mkBatch([message]), env, createExecutionContext());
    expect(state.retried).toBe(true);
    expect(state.acked).toBe(false);
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
  // dispatch contract is identical to the Biller/Concierge — poison acks, an unknown tenant retries, a routable
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

  it("quote.accepted UNKNOWN tenant → RETRIED toward the DLQ, never acked (REQ-025/169)", async () => {
    const { message, state } = mkMessage({ kind: "quote.accepted", tenant: "tenant-unrostered", shipment_id: "shp-1", event_id: "evt-1" });
    await worker.queue(mkBatch([message]), env, createExecutionContext());
    expect(state.retried).toBe(true);
    expect(state.acked).toBe(false);
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
