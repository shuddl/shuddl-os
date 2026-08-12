import { LedgerEvent, type EventKind, type SessionClaims } from "@shuddl/contracts";
import { redactEvent } from "./redact.js";
import { NATIVE_VISIBLE_SOURCES } from "./queries/unbilled.js";

// REQ-015 / I6: a lens is the server-derived scope a session reads through. It is computed
// from JWT claims only (like `tenant`) — never from a query param or header.
export type Lens =
  | { scope: "tenant" } // admin | ops | finance | read — the whole tenant
  | { scope: "party"; partyId: string } // portal — one party's shipments
  | { scope: "driver"; userId: string }; // driver PWA — one driver's assigned stops

export interface SqlFragment {
  sql: string;
  params: (string | number)[];
}

export function lensFor(s: SessionClaims): Lens {
  if (s.role === "portal") {
    if (!s.party_id) throw new Error("LENS_UNRESOLVED: portal session without party_id");
    return { scope: "party", partyId: s.party_id };
  }
  if (s.role === "driver") return { scope: "driver", userId: s.sub };
  return { scope: "tenant" };
}

// A driver PWA sees only the operational kinds for the stops it is executing. This is a FIXED
// compile-time constant (`as const`) — its values are BOUND as `?` params in lensWhere, never
// interpolated into SQL, so it cannot carry an injection regardless of anything a caller sends.
// Exported so the REQ-015/I6 adversarial sweep asserts against the REAL allowlist (no test drift).
export const DRIVER_KINDS = [
  "appointment.set",
  "pickup.scheduled",
  "dispatch.assigned",
  "stop.arrived",
  "freight.counted",
  "freight.photographed",
  "dims.captured",
  "custody.transferred",
  "seal.applied",
  "stop.departed",
  "exception.raised",
  "osd.captured",
  "pod.signed",
  "delivery.evidenced",
  "document.attached",
  "message.received",
  "message.sent",
] as const satisfies readonly EventKind[];

/**
 * The server-side WHERE fragment that scopes `events e` to a lens. The only string
 * interpolated into `sql` is the caller-controlled-free `alias` and a run of `?`
 * placeholders whose count is derived from the fixed DRIVER_KINDS length. Every
 * runtime value (partyId, userId, the kind allowlist) is a BOUND param — SQL-injection-safe.
 */
export function lensWhere(lens: Lens, alias = "e"): SqlFragment {
  switch (lens.scope) {
    case "tenant":
      return { sql: "1=1", params: [] };
    case "party":
      return {
        sql: `${alias}.visibility <> 'internal' AND EXISTS (SELECT 1 FROM json_each(${alias}.party_refs) WHERE value = ?)`,
        params: [lens.partyId],
      };
    case "driver":
      // visibility<>'internal' FIRST — I6 binds every view, including the driver's day sheet:
      // an ops-only (internal) event on the driver's own shipment must never surface here.
      return {
        sql: `${alias}.visibility <> 'internal' AND ${alias}.kind IN (${DRIVER_KINDS.map(() => "?").join(",")}) AND ${alias}.shipment_id IN (SELECT id FROM shipments WHERE json_extract(status_cache,'$.assigned_driver') = ?)`,
        params: [...DRIVER_KINDS, lens.userId],
      };
  }
}

export interface ReadQuery {
  shipment_id?: string;
  after_seq?: number;
  cursor?: { stream_id: string; seq: number };
  limit?: number;
  // REQ-082/083 — the command queues + KPI click-through list events of a specific kind (or a SET of
  // kinds). Every value is BOUND as a `?` param (never interpolated) and composes as an ANDed
  // `e.kind IN (...)` on top of the lens WHERE + keyset cursor, so it can only NARROW a lens, never
  // widen it (a party/driver lens + a kind filter still returns only that scope's VISIBLE events).
  // Backed by ix_events_kind_ts(kind, ts) — no full scan.
  kind?: EventKind | readonly EventKind[];
  // REQ-197 — the exceptions QUEUE must retain the FRESHEST events under the 1000-cap. Ordering is
  // additive and OPT-IN:
  //   · "seq" (DEFAULT / omitted) = the firehose keyset `ORDER BY e.stream_id, e.seq` — BYTE-UNCHANGED for
  //     every existing caller (the composite cursor + nextCursor depend on it).
  //   · "ts_desc" = `ORDER BY e.ts DESC, e.stream_id DESC, e.seq DESC` (stable tiebreak), backed by
  //     ix_events_kind_ts(kind, ts). The LIMIT now keeps the NEWEST rows, so a fresh event can never be
  //     truncated out by the lexicographic stream_id order that the default keyset uses.
  // `before_ts` is the ts keyset for paging OLDER (ANDs `e.ts < ?`) — a caller walks back by passing the
  // oldest ts of the prior page. Bound as a `?` param; harmless in the default order (no existing caller
  // passes it).
  order?: "seq" | "ts_desc";
  before_ts?: number;
  // WP-15 Task 4b (REQ-021) — the LEGACY-SHADOW opt-in. A `source:'legacy'` event exists in `events` for the
  // native-vs-legacy PARITY compute ONLY (computeModuleParity, which reads `events` DIRECTLY, never via this
  // lens); it is a mirror record of the incumbent's history, NOT a native fact. By DEFAULT readEvents EXCLUDES it
  // from every native read surface it backs — the Command timeline (GET /v1/events), the command queues, the
  // tenant export, the copilot grounding — so those RECONCILE with the source-aware KPI aggregates (which also
  // exclude legacy). Set `includeShadow:true` to INCLUDE legacy rows: the ONLY legitimate caller is the Task-7
  // v_parity dashboard drill-through, which shows a module's legacy BACKING events. Omitted/false ⇒ native only.
  includeShadow?: boolean;
}

// §1228 — EXPORTED because two API routes recompute this exact expression to decide whether a page was
// FULL. `readEvents` applies these to the SQL `LIMIT`; `routes/events.ts` and `routes/export.ts` apply
// them again in their own `nextCursor()` (`if (events.length < effective) return null`). Both carried
// private copies and a comment saying they "mirror" this file — with nothing comparing them. If a route's
// copy were ever LARGER than this one, a full page would read as short, `nextCursor` would return null,
// and the client would silently never see rows past the first page. One declaration removes the class.
export const LIMIT_CAP = 1000;
export const DEFAULT_LIMIT = 200;

export async function readEvents(db: D1Database, lens: Lens, q: ReadQuery = {}): Promise<LedgerEvent[]> {
  // `seq` is per-stream. A bare `after_seq` across streams silently drops rows (two streams
  // share seq values), so it is valid ONLY inside a single-shipment scope. The firehose uses
  // the COMPOSITE (stream_id, seq) keyset cursor instead.
  if (q.after_seq !== undefined && q.shipment_id === undefined) {
    throw new Error("INVALID_CURSOR: after_seq requires a shipment_id scope; use `cursor` (stream_id, seq) across streams");
  }
  if (q.after_seq !== undefined && q.cursor !== undefined) {
    throw new Error("INVALID_CURSOR: after_seq and cursor are mutually exclusive pagination modes");
  }
  const w = lensWhere(lens);
  const clauses = [w.sql];
  const params: (string | number)[] = [...w.params];
  // WP-15 Task 4b (REQ-021) — EXCLUDE the legacy shadow by DEFAULT. Native-visible = native/edi/email (the SAME
  // NATIVE_VISIBLE_SOURCES single source of truth the KPI/metrics aggregates use — one definition, no drift), so
  // the lens-backed timeline/queues/export/copilot reconcile with the Change-D aggregates. Bound as `?` params
  // (never interpolated) exactly like every other value here — SQL-injection-safe. `includeShadow:true` opts in
  // (Task-7 parity drill-through only). INERT on all native data: every native/edi/email row still matches.
  if (q.includeShadow !== true) {
    clauses.push(`e.source IN (${NATIVE_VISIBLE_SOURCES.map(() => "?").join(",")})`);
    params.push(...NATIVE_VISIBLE_SOURCES);
  }
  if (q.shipment_id !== undefined) {
    clauses.push("e.shipment_id = ?");
    params.push(q.shipment_id);
  }
  if (q.cursor) {
    clauses.push("(e.stream_id > ? OR (e.stream_id = ? AND e.seq > ?))");
    params.push(q.cursor.stream_id, q.cursor.stream_id, q.cursor.seq);
  }
  if (q.after_seq !== undefined) {
    clauses.push("e.seq > ?");
    params.push(q.after_seq);
  }
  if (q.kind !== undefined) {
    // REQ-082/083 kind filter. ANDs an `e.kind IN (...)` onto the lens WHERE — it only NARROWS the visible
    // set (the redaction/visibility scope below still applies). A driver lens already constrains kind to
    // DRIVER_KINDS; this second IN yields the INTERSECTION, never a wider set. Each value is a BOUND param.
    const kinds: readonly EventKind[] = typeof q.kind === "string" ? [q.kind] : q.kind;
    if (kinds.length > 0) {
      clauses.push(`e.kind IN (${kinds.map(() => "?").join(",")})`);
      params.push(...kinds);
    }
  }
  if (q.before_ts !== undefined) {
    // REQ-197 — page OLDER: strictly-older-than the prior page's oldest ts. Only meaningful with the
    // ts_desc order; bound as a `?` param either way. Existing (default-order) callers never pass it.
    clauses.push("e.ts < ?");
    params.push(q.before_ts);
  }
  const limit = Math.min(q.limit ?? DEFAULT_LIMIT, LIMIT_CAP);
  // REQ-197 — the DEFAULT "seq" order (`e.stream_id, e.seq`) is BYTE-UNCHANGED (the keyset cursor depends on
  // it). "ts_desc" makes the LIMIT retain the FRESHEST rows (stable tiebreak on stream_id/seq), backed by
  // ix_events_kind_ts(kind, ts) whenever a kind filter is present.
  const orderBy = q.order === "ts_desc" ? "e.ts DESC, e.stream_id DESC, e.seq DESC" : "e.stream_id, e.seq";
  const res = await db
    .prepare(`SELECT * FROM events e WHERE ${clauses.join(" AND ")} ORDER BY ${orderBy} LIMIT ?`)
    .bind(...params, limit)
    .all();
  const events = res.results.map((r) => rowToEvent(r as Record<string, string | number | null>));
  if (lens.scope === "tenant") return events; // tenant sees the unredacted truth
  // Party/driver: project each event down. Party positions generalize to city granularity
  // until the shipment is out-for-delivery, so resolve OFD per shipment first.
  const shipmentIds = [...new Set(events.map((e) => e.shipment_id).filter((s): s is string => s !== undefined))];
  const ofd = shipmentIds.length > 0 ? await outForDeliverySet(db, shipmentIds) : new Set<string>();
  return events.map((e) => redactEvent(lens, e, e.shipment_id !== undefined && ofd.has(e.shipment_id)));
}

async function outForDeliverySet(db: D1Database, shipmentIds: string[]): Promise<Set<string>> {
  const res = await db
    .prepare(
      `SELECT id FROM shipments WHERE id IN (${shipmentIds.map(() => "?").join(",")}) AND json_extract(status_cache,'$.out_for_delivery') = 1`,
    )
    .bind(...shipmentIds)
    .all();
  return new Set(res.results.map((r) => (r as { id: string }).id));
}

// ---- row <-> envelope (hash-critical) ------------------------------------
// The events table stores the envelope across typed columns; the offline/optional ones are
// nullable. SQL NULL MUST map to an OMITTED key (undefined), never to `null`: the canonicalizer
// omits undefined but EMITS null, so a NULL -> null mapping would inject e.g. `"shipment_id":null`
// into the hash-view and every event read back from D1 would fail chain verification.

interface EventRow {
  stream_id: string;
  seq: number;
  id: string;
  shipment_id: string | null;
  ts: number;
  recorded_at: number;
  kind: string;
  actor_party_id: string;
  actor_user_id: string | null;
  actor_device_id: string | null;
  party_refs: string;
  payload: string;
  evidence: string;
  prev_hash: string;
  hash: string;
  sig: string | null;
  visibility: string;
  source: string;
  confidence: number;
  device_id: string | null;
  device_seq: number | null;
  captured_ts: number | null;
  override_json: string | null;
}

export function rowToEvent(row: Record<string, string | number | null>): LedgerEvent {
  const r = row as unknown as EventRow;
  const actor: { party: string; user?: string; device?: string } = { party: r.actor_party_id };
  if (r.actor_user_id !== null) actor.user = r.actor_user_id;
  if (r.actor_device_id !== null) actor.device = r.actor_device_id;

  const e: Record<string, unknown> = {
    id: r.id,
    stream_id: r.stream_id,
    seq: r.seq,
    ts: r.ts,
    recorded_at: r.recorded_at,
    kind: r.kind,
    actor,
    party_refs: JSON.parse(r.party_refs) as unknown,
    evidence: JSON.parse(r.evidence) as unknown,
    payload: JSON.parse(r.payload) as unknown,
    prev_hash: r.prev_hash,
    hash: r.hash,
    visibility: r.visibility,
    source: r.source,
    confidence: r.confidence,
  };
  // Nullable columns: present only when non-NULL (omitted -> undefined, never null).
  if (r.shipment_id !== null) e.shipment_id = r.shipment_id;
  if (r.sig !== null) e.sig = r.sig;
  if (r.device_id !== null) e.device_id = r.device_id;
  if (r.device_seq !== null) e.device_seq = r.device_seq;
  if (r.captured_ts !== null) e.captured_ts = r.captured_ts;
  // REQ-049 override (nullable): a stored override_json rehydrates to the SAME `override` object the
  // sequencer hashed, so the read-back hash reproduces. NULL/absent -> omitted (never null) per the
  // rule above, which keeps a non-override event's canonical bytes identical to a pre-0005 row that
  // never had the column at all. `?? null` collapses BOTH SQL NULL and a row missing the column.
  const overrideJson = r.override_json ?? null;
  if (overrideJson !== null) e.override = JSON.parse(overrideJson) as unknown;
  return LedgerEvent.parse(e);
}

export function eventToRow(e: LedgerEvent): Record<string, string | number | null> {
  // Inverse of rowToEvent: an absent optional envelope field becomes a NULL column. Symmetric
  // by construction, so eventToRow(rowToEvent(row)) reproduces the stored row exactly.
  return {
    stream_id: e.stream_id,
    seq: e.seq,
    id: e.id,
    shipment_id: e.shipment_id ?? null,
    ts: e.ts,
    recorded_at: e.recorded_at,
    kind: e.kind,
    actor_party_id: e.actor.party,
    actor_user_id: e.actor.user ?? null,
    actor_device_id: e.actor.device ?? null,
    party_refs: JSON.stringify(e.party_refs),
    payload: JSON.stringify(e.payload),
    evidence: JSON.stringify(e.evidence),
    prev_hash: e.prev_hash,
    hash: e.hash ?? null,
    sig: e.sig ?? null,
    visibility: e.visibility,
    source: e.source,
    confidence: e.confidence,
    device_id: e.device_id ?? null,
    device_seq: e.device_seq ?? null,
    captured_ts: e.captured_ts ?? null,
    override_json: e.override === undefined ? null : JSON.stringify(e.override),
  };
}
