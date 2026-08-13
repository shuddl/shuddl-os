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
  });

  // §1285 — THE SEQ CHECK, ISOLATED. The case above tampers `seq`, but `seq` is INSIDE the hash view, so the
  // edit changes the recomputed hash and `hash_mismatch` rejects it — the seq comparison never runs. Measured:
  // deleting `if (e.seq !== expectedSeq)` left packages/ledger at 726/726 GREEN.
  //
  // The seq check's own failure is a RESUMED verification pointed at the wrong range: a caller that supplies a
  // correct `trustedPrevHash` but a stale `fromSeq` links perfectly and hashes perfectly. Without the seq
  // comparison that returns `ok: true` with a count and a head — a segment verified while the caller believes
  // it verified from somewhere else.
  //
  // SCOPE, checked rather than assumed: the only production caller is `tools/deploy/restore-verify.ts`
  // (`verifyChainOfRows`, the backup-restore verdict), and it calls `verifyChain(events)` with NO options. So
  // the resume path is an exported CONTRACT with no consumer today, not a live code path — this pins the
  // package's public API against a future resumer, which is worth doing and is a smaller claim than "reachable".
  // (The first draft of this comment said `anchor.ts` resumes this way. It does not; anchor.ts never calls
  // verifyChain at all, and the only `verifyChain(` matches in src are a DIFFERENT function in tsa/cms.ts.)
  it("§1285: a correct prev_hash with the WRONG fromSeq is refused (seq_gap), not silently verified", async () => {
    const chain = await buildChain([
      eventFixture("quote.requested", { seq: 0 }),
      eventFixture("quote.priced", { seq: 1 }),
      eventFixture("quote.sent", { seq: 2 }),
    ]);
    // Resume at the events starting at seq 1, handing verifyChain the RIGHT trusted prev_hash for them…
    const res = await verifyChain([chain[1]!, chain[2]!], { fromSeq: 0, trustedPrevHash: chain[1]!.prev_hash });
    // PREMISE: the link and the hashes are genuinely intact — only the sequence number disagrees.
    expect(chain[1]!.prev_hash).toBe(chain[0]!.hash);
    expect(res.ok, "a segment verified against the wrong fromSeq must not report ok").toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.failure.reason).toBe("seq_gap");
  });

  it("§1285: the SAME segment with the matching fromSeq verifies (the complement — the guard is not just strict)", async () => {
    const chain = await buildChain([
      eventFixture("quote.requested", { seq: 0 }),
      eventFixture("quote.priced", { seq: 1 }),
      eventFixture("quote.sent", { seq: 2 }),
    ]);
    const res = await verifyChain([chain[1]!, chain[2]!], { fromSeq: 1, trustedPrevHash: chain[1]!.prev_hash });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.count).toBe(2);
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

// REQ-002/011 §576 — THE prev_hash LINK CHECK IS LOAD-BEARING, AND NOTHING WAS WATCHING IT.
//
// `verifyChain` runs three checks in order: seq continuity, the prev_hash link, then hash recomputation.
// Disabling the LINK check (audit §576, M38) left all five tests in this file green — so it was unwatched.
//
// Why the existing cases could not see it, and neither could a careless reading:
//   • the 10K "tampered byte" case mutates a PAYLOAD, which changes that event's own hash — the HASH check
//     catches it, and the link check never gets a say;
//   • the genesis case sets `prev_hash: "1"*64` on seq 0, but `prev_hash` is INSIDE the hash view, so the
//     recomputed hash no longer matches the stored one — again the hash check fires, and the assertion is
//     only `.ok === false`, which cannot tell the two reasons apart.
//
// The case ONLY the link check can catch is a FORGED chain: a wrong predecessor whose hash was correctly
// recomputed for it. That is exactly what an attacker with write access constructs — re-link, then re-hash —
// and it is the whole reason a hash chain is a CHAIN rather than a bag of individually-valid records.
describe("REQ-002 §576: a forged chain — wrong link, correctly recomputed hash", () => {
  it("rejects an event whose prev_hash is wrong but whose OWN hash is valid for that wrong link", async () => {
    const [a, b] = await buildChain([
      eventFixture("quote.requested", { seq: 0 }),
      eventFixture("quote.priced", { seq: 1 }),
    ]);
    if (a === undefined || b === undefined) throw new Error("expected a two-event chain");
    await expect(verifyChain([a, b])).resolves.toMatchObject({ ok: true });

    // The forgery: re-link b to GENESIS instead of a, then RE-HASH so the event is internally consistent.
    // Every individual record now verifies; only the link between them is a lie.
    const relinked = { ...b, prev_hash: GENESIS_HASH } as LedgerEvent;
    const forged = { ...relinked, hash: await hashEvent(relinked) } as LedgerEvent;
    expect(await hashEvent(forged), "the forged event must be self-consistent, or this tests the hash check").toBe(forged.hash);

    const res = await verifyChain([a, forged]);
    expect(res.ok, "a forged chain verified — the prev_hash link check is not enforcing").toBe(false);
    // The REASON matters: asserting only `ok:false` is what let the genesis case be covered for by the hash
    // check. Pinning the reason is what makes this test about the LINK.
    expect(!res.ok && res.failure.reason).toBe("prev_hash_mismatch");
    expect(!res.ok && res.failure.seq).toBe(1);
  });

  it("names bad_genesis (not hash_mismatch) when the FIRST event's link is wrong and self-consistent", async () => {
    const [a] = await buildChain([eventFixture("quote.requested", { seq: 0 })]);
    if (a === undefined) throw new Error("expected one event");
    const relinked = { ...a, prev_hash: "1".repeat(64) } as LedgerEvent;
    const forged = { ...relinked, hash: await hashEvent(relinked) } as LedgerEvent;

    const res = await verifyChain([forged]);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.failure.reason, "a self-consistent bad genesis must be named as such").toBe("bad_genesis");
  });
});
