// REQ-016: pure client-side reconciliation of captured events. Dedups device-captured events by their
// `(shipment_id, device_id, device_seq)` key — FIRST-WINS, NEVER OVERWRITE. This MIRRORS EXACTLY the
// unique index the sequencer enforces server-side (`WHERE stream_id=? AND device_id=? AND device_seq=?`,
// and `stream_id = 's:' || shipment_id`): a re-synced duplicate collapses to the original, and a
// DIFFERENT event that reuses an already-seen `(shipment, device, seq)` is dropped — the first is kept,
// never clobbered. So the offline queue dedups client-side in agreement with the server.
//
// PER-STREAM (WP-05 exit audit): the key includes `shipment_id`. The server's index is per-STREAM, so
// the SAME `(device_id, device_seq)` on two DIFFERENT shipments is TWO distinct rows the server accepts;
// a global (device_id, device_seq) key here would wrongly drop the second, diverging from the server and
// losing a signed capture. Keying on the stream keeps client and server dedup decisions identical.
//
// WHY THAT MIRRORING ACTUALLY HOLDS, stated here because it is a fact about a DIFFERENT file (audit §390):
// the server does NOT read `shipment_id` from the body — it derives the stream from the URL path
// (`workers/api/src/routes/events.ts@streamId` builds `s:${c.req.param("id")}`). So client and server would
// key on two different values, except that the driver's transport BUILDS THAT URL FROM THE SAME FIELD this
// merge keys on (`apps/driver/src/sync/transport.ts@sendEvent`), and refuses with 422 when it is absent.
// One field, used identically at capture, merge, and route. If a future transport ever routes by anything
// else — a manifest stop id, a path passed alongside the event — this dedupe stops mirroring the server
// silently, and the failure is a DROPPED SIGNED CAPTURE, not an error.
//
// Server-origin events (no `device_id`) have no offline key and are ALL kept. Output is a deterministic
// total order (captured_ts → device_id → device_seq → id), independent of input order — the SAME set of
// events always merges to the SAME sequence, however the syncs interleaved.
import type { EventInput } from "@shuddl/contracts";

// The dedupe key: JSON.stringify of the [shipment_id, device_id, device_seq] tuple is injective for a
// (string|undefined, string, number) triple, so distinct streams / devices / seqs can never collide.
function seqKey(shipment_id: string | undefined, device_id: string, device_seq: number): string {
  return JSON.stringify([shipment_id ?? null, device_id, device_seq]);
}

export function mergeByDeviceSeq(events: readonly EventInput[]): EventInput[] {
  const seen = new Set<string>();
  const kept: EventInput[] = [];

  for (const e of events) {
    // The EventInput refine guarantees device_id ⟹ device_seq; check both so device_seq narrows.
    if (e.device_id !== undefined && e.device_seq !== undefined) {
      const key = seqKey(e.shipment_id, e.device_id, e.device_seq);
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
