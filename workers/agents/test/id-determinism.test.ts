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

  // §1460 — THE ASSERTION ABOVE CANNOT FAIL FOR THE HAZARD IT NAMES. Both calls land in the same millisecond,
  // so folding a clock into the seed (`biller:invoice-event:${podEventId}:${Date.now()}`) leaves it green —
  // MEASURED: 142/142 in this worker, the whole suite, including the case literally named "a redelivered POD".
  // The header above claims these assertions "close exactly that gap"; for the clock class they did not. A real
  // redelivery is separated from its original by SECONDS (queue backoff), never by zero, so the property that
  // matters is invariance ACROSS TIME — and the only way to assert that is to move the clock.
  //
  // Randomness is included for the same reason and is NOT redundant: `Math.random()` is defeated by the same
  // seed being read twice, while `Date.now()` is defeated only by elapsed time. Two different escapes, so two
  // different stubs — a single one would leave the other half of the class unwatched.
  it("...and still re-derives it across a clock tick and a random draw (the hazard the case above cannot see)", async () => {
    const realNow = Date.now;
    const realRandom = Math.random;
    try {
      let t = 1_700_000_000_000;
      Date.now = () => (t += 60_000); // every read is a minute later — a redelivery, not a same-tick repeat
      let r = 0;
      Math.random = () => (r += 0.25) % 1;
      const first = await invoiceEventIdFor("pod-evt-42");
      const second = await invoiceEventIdFor("pod-evt-42");
      expect(second, "the invoice event id moved when only the clock did — a redelivery would mint a SECOND invoice on an append-only ledger AND a second `evidence-email/<id>` key, so the customer is emailed twice").toBe(first);
    } finally {
      Date.now = realNow;
      Math.random = realRandom;
    }
  });

  it("the clock/random stubs above are LIVE (positive control — a vacuous stub proves nothing)", () => {
    // §1387: if `Date.now` could not be reassigned in this runtime, the case above would pass by asserting a
    // property nothing perturbs — the exact failure it exists to correct.
    const realNow = Date.now;
    try {
      Date.now = () => 42;
      expect(Date.now(), "Date.now is not reassignable here — the clock-tick case is inert, not passing").toBe(42);
    } finally {
      Date.now = realNow;
    }
    expect(Date.now()).toBeGreaterThan(1_600_000_000_000);
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

// §1727 (REQ-039/118/119) — THE FILE THAT EXISTS TO PIN THE ID LAW CONTAINS ONLY SELF-COMPARISONS.
//
// Every assertion above compares a derivation TO ITSELF: same seed twice, same seed across a stubbed clock and
// a stubbed random. Each closes a real hazard (§218's randomness, §1460's clock) and each is correct. But all
// of them survive a change that moves EVERY output byte at once, because both sides move together.
//
// Measured at §1716: mutating the shared `deterministicUuid` (slice offset 13→14) left `workers/agents` at
// **148/148 GREEN**, this file included. And that is the direction that matters here — the header above says
// the guarantee is DELEGATED to the sequencer's dedupe on the far side of a worker seam, which means the id
// must match what a PREVIOUS deploy wrote. A redelivery arriving after a derivation change re-derives a
// different id, the DO sees a new event, and one POD becomes TWO invoices on an append-only ledger.
//
// A literal is the only assertion that can see that, because it is the only one whose other side does not
// move. These four values were computed from the derivation as shipped; if you are here because one failed,
// the question is not "what is the new value" but "which persisted ids did this change orphan".
describe("§1727 the id law's BYTES — the half a same-seed comparison cannot reach", () => {
  it("uuidFromSeed maps a known seed to exactly this uuid", async () => {
    expect(
      await uuidFromSeed("biller:invoice-event:ev-1"),
      "the shared uuid derivation moved. Redelivered work re-derives ids that no longer match the events " +
        "already in the ledger, so the sequencer's dedupe stops collapsing them — one POD becomes two " +
        "invoices. Not a snapshot to regenerate.",
    ).toBe("eff2407e-0903-43f6-9caa-d82b5684973d");
  });

  it("invoiceEventIdFor maps a known POD event id to exactly this invoice event id", async () => {
    expect(await invoiceEventIdFor("pod-evt-42")).toBe("1e9cdc82-5eb0-4e93-9edc-70a9bf92ed15");
    // A different POD, so the golden pins the SEED and not a constant: without this, a derivation that
    // ignored its argument entirely would satisfy the assertion above.
    expect(await invoiceEventIdFor("pod-evt-43")).toBe("282ef334-41f0-465b-811c-477187899762");
  });

  it("the domain tag is load-bearing — the same input under a different tag is a different id", async () => {
    // `uuidFromSeed` is shared by the Biller and the interline-split producer, so the tag is what keeps two
    // agents' ids apart on one POD. A tag dropped from either seed collides them silently.
    expect(await uuidFromSeed("pod-evt-42")).not.toBe(await invoiceEventIdFor("pod-evt-42"));
  });
});
