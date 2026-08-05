import { describe, expect, it } from "vitest";
import { uuidFromSeed, invoiceEventIdFor } from "../src/biller.js";

// THE PRECONDITION OF AT-LEAST-ONCE (audit §218/§220). Cloudflare Queues redeliver, so the Biller and the
// interline-split producer stay idempotent by minting ids that a redelivery REPRODUCES EXACTLY — the
// sequencer DO then dedupes on the event id and returns the original append. That makes the guarantee
// DELEGATED: it is enforced on the far side of a worker seam, in `workers/api`, and every assertion of the
// outcome ("the same message twice → ONE invoice") necessarily lives there.
//
// Measured consequence: breaking this derivation — `sha256Hex(s)` → `sha256Hex(s + Math.random())` — fails
// TEN tests across five files in workers/api and leaves THIS package at 106/106 green. So an engineer
// editing biller.ts, running the suite that owns the file, and seeing green would ship a broken
// at-least-once guarantee (§218). The outcome cannot be tested here — proving "one invoice" needs the real
// DO — but the PRECONDITION can, and it is the half that actually broke.
//
// These are the cheapest possible assertions and they close exactly that gap.
describe("REQ-039 — the id law is deterministic (the half testable inside this package)", () => {
  it("the same seed yields the same uuid, every time", async () => {
    const a = await uuidFromSeed("biller:invoice-event:ev-1");
    const b = await uuidFromSeed("biller:invoice-event:ev-1");
    expect(a).toBe(b);
  });

  it("a redelivered POD re-derives the SAME invoice event id", async () => {
    expect(await invoiceEventIdFor("pod-evt-42")).toBe(await invoiceEventIdFor("pod-evt-42"));
  });

  it("distinct seeds stay distinct — determinism must not collapse to a constant", async () => {
    const a = await uuidFromSeed("biller:invoice-event:ev-1");
    const b = await uuidFromSeed("biller:invoice-event:ev-2");
    expect(a).not.toBe(b);
  });

  it("the shape is a v4-variant uuid (EventInput's z.string().uuid() accepts it)", async () => {
    expect(await uuidFromSeed("x")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
