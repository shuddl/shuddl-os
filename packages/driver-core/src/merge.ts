// REQ-016: pure client-side reconciliation of captured events. Dedups device-captured events by their
// `(device_id, device_seq)` key — FIRST-WINS, NEVER OVERWRITE. This MIRRORS the invariant the sequencer
// enforces server-side (a unique index over `WHERE device_id=? AND device_seq=?`): a re-synced duplicate
// collapses to the original, and a DIFFERENT event that reuses an already-seen `(device, seq)` is
// dropped — the first is kept, never clobbered. So the offline queue can dedup before it ever sends.
//
// Server-origin events (no `device_id`) have no offline key and are ALL kept. Output is a deterministic
// total order (captured_ts → device_id → device_seq → id), independent of input order — the SAME set of
// events always merges to the SAME sequence, however the syncs interleaved.
import type { EventInput } from "@shuddl/contracts";

// The dedupe key: JSON.stringify of the [device_id, device_seq] tuple is injective for a
// (string, number) pair, so ("dev", 12) and ("dev1", 2) can never collide, whatever the id contains.
function seqKey(device_id: string, device_seq: number): string {
  return JSON.stringify([device_id, device_seq]);
}

export function mergeByDeviceSeq(events: readonly EventInput[]): EventInput[] {
  const seen = new Set<string>();
  const kept: EventInput[] = [];

  for (const e of events) {
    // The EventInput refine guarantees device_id ⟹ device_seq; check both so device_seq narrows.
    if (e.device_id !== undefined && e.device_seq !== undefined) {
      const key = seqKey(e.device_id, e.device_seq);
      if (seen.has(key)) continue; // first-wins: drop this claim on a seen key, never overwrite the original
      seen.add(key);
    }
    kept.push(e);
  }

  return kept.sort(cmp);
}

/** Strict total order — `id` (a uuid) is the final tiebreaker, so the output is fully deterministic. */
function cmp(a: EventInput, b: EventInput): number {
  const at = a.captured_ts ?? a.ts;
  const bt = b.captured_ts ?? b.ts;
  if (at !== bt) return at - bt;
  const ad = a.device_id ?? "";
  const bd = b.device_id ?? "";
  if (ad !== bd) return ad < bd ? -1 : 1;
  const as = a.device_seq ?? -1;
  const bs = b.device_seq ?? -1;
  if (as !== bs) return as - bs;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
