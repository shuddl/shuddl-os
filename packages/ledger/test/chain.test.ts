import { describe, expect, it } from "vitest";
import { GENESIS_HASH, hashEvent, hashView, verifyChain, buildChain } from "../src/chain.js";
import { eventFixture, EVENT_KINDS, type LedgerEvent } from "@shuddl/contracts";

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

  // THE DENYLIST'S COMPLETENESS (audit §434). `hashView` does not allowlist fields — it copies the whole
  // envelope and DELETES `sig` and `hash`. Its comment claims "everything else — prev_hash, seq, id, ts,
  // recorded_at — is covered, so tampering anywhere breaks the next link", but the only tampering test above
  // mutates `payload`, and the seq/prev_hash cases are caught STRUCTURALLY by verifyChain (seq_gap,
  // bad_genesis), not by the hash. So the quantifier was pinned for one field out of the envelope.
  //
  // What an uncovered field costs, concretely: drop `recorded_at` from the view and the SERVER CLOCK on a
  // stored event can be rewritten without breaking the chain — the tamper-evidence hole lands on the exact
  // timestamp money (aging, SLA, dunning) is computed from, and every downstream verification stays green.
  // This iterates the view rather than naming fields, so a field ADDED to the envelope is covered the day it
  // appears instead of the day someone remembers to extend a list.
  it("EVERY field in the hash view is inside the hash — the denylist is complete", async () => {
    const [e] = await buildChain([eventFixture("stop.arrived")]);
    const base = await hashEvent(e!);
    // THE KEY LIST COMES FROM THE ENVELOPE, NOT FROM `hashView` (audit §434). The first version of this
    // test iterated `Object.keys(hashView(e))` — the very list the mutation shrinks — so deleting
    // `recorded_at` from the view removed it from the expectation too and the test stayed GREEN. It asked
    // "is every field in the view covered?", which is tautological, instead of "is every field of the
    // ENVELOPE covered?". Same trap as §433, in the section that recorded §433.
    const EXCLUDED = ["sig", "hash"];
    const keys = Object.keys(e!).filter((k) => !EXCLUDED.includes(k));
    expect(keys.length, "non-vacuity: the fixture must actually carry an envelope").toBeGreaterThan(6);
    // The denylist EXACTLY: everything the envelope has, minus sig and hash. Catches a field silently
    // dropped from the view even before the tamper loop below reaches it.
    expect(Object.keys(hashView(e!)).sort()).toEqual([...keys].sort());
    for (const k of keys) {
      const v = (e! as Record<string, unknown>)[k];
      const tampered = { ...e!, [k]: typeof v === "number" ? v + 1 : `${String(v)}-tampered` };
      expect(await hashEvent(tampered as LedgerEvent), `\`${k}\` is NOT covered by the event hash — tampering it leaves the chain valid`).not.toBe(base);
    }
  });

  it("`sig` is OUTSIDE the hash — an event's identity does not depend on its signature", async () => {
    // The other half of the denylist, and it must stay true in this direction: the signature is produced
    // OVER the hash, so a sig inside the hash would be circular and unsignable. A test that only proved
    // "tampering changes the hash" would happily accept sig being covered.
    const [e] = await buildChain([eventFixture("quote.requested")]);
    const base = await hashEvent(e!);
    expect(await hashEvent({ ...e!, sig: "ab".repeat(32) } as LedgerEvent)).toBe(base);
  });
});
