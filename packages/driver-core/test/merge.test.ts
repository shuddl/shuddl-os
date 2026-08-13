import { describe, expect, it } from "vitest";
import { EventInput } from "@shuddl/contracts";
import { mergeByDeviceSeq } from "../src/merge.js";

// A minimal valid device/server EventInput. `pieces` lets us make a DIFFERENT event that reuses an
// already-seen (device, seq) to prove no-overwrite. freight.counted needs no device (not custody),
// so a server-origin variant (no device_id) is also valid.
function mkEvent(opts: {
  id: string;
  shipment_id?: string;
  device_id?: string;
  device_seq?: number;
  captured_ts?: number;
  ts?: number;
  pieces?: number;
}): EventInput {
  const draft: Record<string, unknown> = {
    id: opts.id,
    shipment_id: opts.shipment_id ?? "shp-1",
    ts: opts.ts ?? 1_720_000_000_000,
    actor: opts.device_id ? { party: "p", device: opts.device_id } : { party: "p" },
    party_refs: [],
    evidence: [],
    source: "native",
    confidence: 10_000,
    kind: "freight.counted",
    payload: { pieces: opts.pieces ?? 1 },
  };
  if (opts.device_id !== undefined) {
    draft.device_id = opts.device_id;
    draft.device_seq = opts.device_seq;
    // WP-05 exit audit (REQ-016): a device-namespaced event must be signed (device_id ⟹ sig). A
    // placeholder is sufficient for the merge (which never verifies) — the DO verifies the real sig.
    draft.sig = "c2ln";
  }
  if (opts.captured_ts !== undefined) draft.captured_ts = opts.captured_ts;
  return EventInput.parse(draft);
}

describe("mergeByDeviceSeq — first-wins, never overwrite (REQ-016)", () => {
  it("the SAME (device, seq) event synced twice collapses to ONE", () => {
    const e = mkEvent({ id: "11111111-1111-4111-8111-111111111111", device_id: "dev_a", device_seq: 0 });
    const merged = mergeByDeviceSeq([e, e]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe(e.id);
  });

  it("a DIFFERENT event reusing an already-seen (device, seq) keeps the FIRST — no overwrite", () => {
    const first = mkEvent({ id: "aaaaaaaa-0000-4000-8000-000000000001", device_id: "dev_a", device_seq: 0, pieces: 10 });
    const impostor = mkEvent({ id: "bbbbbbbb-0000-4000-8000-000000000002", device_id: "dev_a", device_seq: 0, pieces: 99 });
    const merged = mergeByDeviceSeq([first, impostor]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe(first.id);
    if (merged[0]?.kind === "freight.counted") expect(merged[0].payload.pieces).toBe(10);
  });

  // WP-05 exit audit (REQ-016): the dedupe key is PER-STREAM (shipment_id, device_id, device_seq),
  // matching the sequencer's unique index. The SAME (device_id, device_seq) on two DIFFERENT shipments
  // is two distinct events the server accepts — a global (device, seq) key would wrongly drop one.
  it("the SAME (device, seq) on DIFFERENT shipments keeps BOTH (per-stream key matches the server)", () => {
    const onA = mkEvent({ id: "aaaaaaaa-0000-4000-8000-00000000000a", shipment_id: "shp-A", device_id: "dev_a", device_seq: 0, captured_ts: 100 });
    const onB = mkEvent({ id: "bbbbbbbb-0000-4000-8000-00000000000b", shipment_id: "shp-B", device_id: "dev_a", device_seq: 0, captured_ts: 200 });
    const merged = mergeByDeviceSeq([onA, onB]);
    expect(merged).toHaveLength(2);
    expect(merged.map((e) => e.id)).toEqual([onA.id, onB.id]);
  });

  it("a duplicate (device, seq) on the SAME shipment still collapses first-wins", () => {
    const first = mkEvent({ id: "cccccccc-0000-4000-8000-00000000000c", shipment_id: "shp-A", device_id: "dev_a", device_seq: 0, pieces: 10 });
    const dup = mkEvent({ id: "dddddddd-0000-4000-8000-00000000000d", shipment_id: "shp-A", device_id: "dev_a", device_seq: 0, pieces: 99 });
    const merged = mergeByDeviceSeq([first, dup]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe(first.id);
  });

  it("two devices, each with its own seq stream, merge with ZERO loss and interleave by captured_ts", () => {
    const a0 = mkEvent({ id: "a0000000-0000-4000-8000-000000000000", device_id: "dev_a", device_seq: 0, captured_ts: 100 });
    const a1 = mkEvent({ id: "a1000000-0000-4000-8000-000000000000", device_id: "dev_a", device_seq: 1, captured_ts: 300 });
    const b0 = mkEvent({ id: "b0000000-0000-4000-8000-000000000000", device_id: "dev_b", device_seq: 0, captured_ts: 200 });
    const b1 = mkEvent({ id: "b1000000-0000-4000-8000-000000000000", device_id: "dev_b", device_seq: 1, captured_ts: 400 });
    // dev_a and dev_b BOTH use seq 0 and 1 — they must NOT collide (key includes device_id).
    const merged = mergeByDeviceSeq([a0, a1, b0, b1]);
    expect(merged).toHaveLength(4);
    expect(merged.map((e) => e.captured_ts)).toEqual([100, 200, 300, 400]);
    expect(merged.map((e) => e.id)).toEqual([a0.id, b0.id, a1.id, b1.id]);
  });

  it("server-origin events (no device_id) all survive, even multiple with no key", () => {
    const s1 = mkEvent({ id: "50000000-0000-4000-8000-000000000001", captured_ts: 50 });
    const s2 = mkEvent({ id: "50000000-0000-4000-8000-000000000002", captured_ts: 60 });
    const d = mkEvent({ id: "d0000000-0000-4000-8000-000000000000", device_id: "dev_a", device_seq: 0, captured_ts: 55 });
    const merged = mergeByDeviceSeq([s1, s2, d]);
    expect(merged).toHaveLength(3);
    expect(merged.map((e) => e.id)).toEqual([s1.id, d.id, s2.id]); // interleaved by captured_ts 50 < 55 < 60
  });

  it("output order is deterministic regardless of input order (total order)", () => {
    const a0 = mkEvent({ id: "a0000000-0000-4000-8000-000000000000", device_id: "dev_a", device_seq: 0, captured_ts: 100 });
    const a1 = mkEvent({ id: "a1000000-0000-4000-8000-000000000000", device_id: "dev_a", device_seq: 1, captured_ts: 300 });
    const b0 = mkEvent({ id: "b0000000-0000-4000-8000-000000000000", device_id: "dev_b", device_seq: 0, captured_ts: 200 });
    const b1 = mkEvent({ id: "b1000000-0000-4000-8000-000000000000", device_id: "dev_b", device_seq: 1, captured_ts: 400 });
    const one = mergeByDeviceSeq([a0, b0, a1, b1]).map((e) => e.id);
    const two = mergeByDeviceSeq([b1, a1, b0, a0]).map((e) => e.id);
    expect(one).toEqual(two);
  });

  // Documents the hazard the nextSeq durability contract prevents (capture.ts DeviceContext.nextSeq):
  // if nextSeq is NOT monotonic across restarts and resets to 0, a post-reboot capture RE-EMITS an
  // already-used (device, seq) with different content — and first-wins merge SILENTLY DROPS it.
  it("a restart-induced seq RESET causes silent data loss (why nextSeq must persist across restarts)", () => {
    // Pre-restart: dev_a durably emitted seq 0 (pieces 10) and seq 1 (pieces 20).
    const pre0 = mkEvent({ id: "c0000000-0000-4000-8000-000000000000", device_id: "dev_a", device_seq: 0, pieces: 10, captured_ts: 100 });
    const pre1 = mkEvent({ id: "c1000000-0000-4000-8000-000000000000", device_id: "dev_a", device_seq: 1, pieces: 20, captured_ts: 200 });
    // App restarts; a NON-durable nextSeq resets to 0, so a NEW distinct capture re-claims seq 0.
    const postReset = mkEvent({ id: "c2000000-0000-4000-8000-000000000000", device_id: "dev_a", device_seq: 0, pieces: 99, captured_ts: 300 });
    const merged = mergeByDeviceSeq([pre0, pre1, postReset]);
    // The reset event collapses onto the ORIGINAL seq-0 and is dropped — the pieces-99 capture is LOST.
    expect(merged).toHaveLength(2);
    expect(merged.map((e) => e.id)).toEqual([pre0.id, pre1.id]);
    const survivor = merged.find((e) => e.device_seq === 0);
    if (survivor?.kind === "freight.counted") expect(survivor.payload.pieces).toBe(10); // original wins, not 99
  });
});


// §1270 — THE TOTAL ORDER'S TIEBREAKS. `merge.ts` claims "a deterministic total order (captured_ts →
// device_id → device_seq → id), independent of input order — the SAME set of events always merges to the SAME
// sequence, however the syncs interleaved". That property is what makes an airplane-mode replay reproducible
// (CLAUDE.md rule 6), and only its FIRST clause was exercised: dropping the `device_id`, `device_seq` and `id`
// comparisons each left this package at 47/47 GREEN, because every fixture varied `captured_ts`.
//
// JS `Array.prototype.sort` is STABLE, so a dropped clause silently degrades to INPUT order — which is exactly
// the thing the comment says the output does not depend on. So the sharpest test is the claim itself: merge the
// same set in two different orders and require identical output. It kills all three clauses at once, and the
// explicit expected sequence below pins WHICH order, not merely that one exists.
//
// The `id` tiebreak is only reachable for SERVER-ORIGIN events: two device events tying on
// (shipment, device_id, device_seq) are deduped by `seqKey` before `cmp` ever compares them, so the fixture
// uses two device-less events to reach it. Fixture arranged per §1260 — the expected order is neither input
// permutation, so a stable sort cannot imitate it.
describe("§1270 the total order is deterministic across interleavings (REQ-016, CLAUDE.md rule 6)", () => {
  const TS = 5_000; // every event ties on captured_ts, so ONLY the tiebreaks decide
  const srvB = mkEvent({ id: "bbbbbbbb-0000-4000-8000-0000000000b1", captured_ts: TS });
  const srvA = mkEvent({ id: "aaaaaaaa-0000-4000-8000-0000000000a1", captured_ts: TS });
  const devA1 = mkEvent({ id: "cccccccc-0000-4000-8000-0000000000c1", device_id: "dev_a", device_seq: 1, captured_ts: TS });
  const devA0 = mkEvent({ id: "dddddddd-0000-4000-8000-0000000000d1", device_id: "dev_a", device_seq: 0, captured_ts: TS });
  const devB0 = mkEvent({ id: "eeeeeeee-0000-4000-8000-0000000000e1", device_id: "dev_b", device_seq: 0, captured_ts: TS });

  // device_id "" (server-origin) sorts before "dev_a" before "dev_b"; within dev_a, seq 0 before 1; the two
  // server events tie on device_id AND device_seq, so their `id` decides: a… before b…
  const EXPECTED = [srvA.id, srvB.id, devA0.id, devA1.id, devB0.id];

  it("the same set in TWO different input orders merges to the SAME sequence", () => {
    const p1 = [srvB, srvA, devA1, devA0, devB0];
    const p2 = [devB0, devA0, devA1, srvA, srvB];
    const m1 = mergeByDeviceSeq(p1).map((e) => e.id);
    const m2 = mergeByDeviceSeq(p2).map((e) => e.id);
    // PREMISE: the inputs really are different orders of one set, and neither IS the answer — otherwise a
    // stable sort with no tiebreaks would pass this by accident.
    expect(p1.map((e) => e.id)).not.toEqual(p2.map((e) => e.id));
    expect(p1.map((e) => e.id)).not.toEqual(EXPECTED);
    expect(p2.map((e) => e.id)).not.toEqual(EXPECTED);
    expect(m1, "two interleavings of one set must merge identically").toEqual(m2);
    expect(m1, "…and to the documented (captured_ts → device_id → device_seq → id) order").toEqual(EXPECTED);
  });

  it("each tiebreak decides its own pair (so one clause cannot stand in for another)", () => {
    // device_id: same seq, different device.
    expect(mergeByDeviceSeq([devB0, devA0]).map((e) => e.id)).toEqual([devA0.id, devB0.id]);
    // device_seq: same device, different seq.
    expect(mergeByDeviceSeq([devA1, devA0]).map((e) => e.id)).toEqual([devA0.id, devA1.id]);
    // id: two server-origin events, tying on everything above it.
    expect(mergeByDeviceSeq([srvB, srvA]).map((e) => e.id)).toEqual([srvA.id, srvB.id]);
  });
});
