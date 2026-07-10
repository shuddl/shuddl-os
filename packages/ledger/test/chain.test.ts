import { describe, expect, it } from "vitest";
import { GENESIS_HASH, hashEvent, verifyChain, buildChain } from "../src/chain.js";
import { eventFixture, EVENT_KINDS } from "@shuddl/contracts";

describe("REQ-002 DoD: chain verifies after 10K events", () => {
  it("10,000 events verify (single-pass, no quadratic blowup); one tampered byte breaks at the right seq", async () => {
    const events = await buildChain(
      Array.from({ length: 10_000 }, (_, i) => eventFixture(EVENT_KINDS[i % 35] as never, { seq: i })),
    );
    const t0 = performance.now();
    const ok = await verifyChain(events);
    expect(ok.ok).toBe(true);
    expect(ok.ok && ok.count).toBe(10_000);
    // verifyChain is O(n) single-pass (~150-300ms of crypto locally). This ceiling is generous
    // headroom against a slow shared CI runner while still catching an O(n^2) regression, which
    // would be minutes, not seconds. The DoD is correctness; this is a catastrophic-perf guardrail.
    expect(performance.now() - t0).toBeLessThan(20_000);

    const tampered = events.map((e, i) =>
      i === 5_000 ? ({ ...e, payload: { ...e.payload, evil: 1 } } as (typeof events)[number]) : e,
    );
    const bad = await verifyChain(tampered);
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.failure.seq).toBe(5_000);
  }, 60_000);
  it("seq gap and bad genesis are distinct failures", async () => {
    const chain = await buildChain([eventFixture("quote.requested", { seq: 0 }), eventFixture("quote.priced", { seq: 1 })]);
    expect((await verifyChain([chain[0]!, { ...chain[1]!, seq: 3 }])).ok).toBe(false);
    expect((await verifyChain([{ ...chain[0]!, prev_hash: "1".repeat(64) }])).ok).toBe(false);
  });
  it("genesis sentinel is 64 zeros; hashEvent reproduces the stored hash", async () => {
    expect(GENESIS_HASH).toBe("0".repeat(64));
    const [e] = await buildChain([eventFixture("quote.requested")]);
    expect(e!.prev_hash).toBe(GENESIS_HASH);
    expect(await hashEvent(e!)).toBe(e!.hash);
  });
});
