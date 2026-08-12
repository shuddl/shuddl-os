import { TERMINAL_STATES } from "@shuddl/ledger/queries/metrics";
import type { Hono } from "hono";
import { EXCEPTION_KINDS, type EventKind } from "@shuddl/contracts";
import { lensFor, readEvents } from "@shuddl/ledger/lens";
import { ApiError } from "../middleware/error.js";
import { requireRole } from "../middleware/auth.js";
import { resolveTenantDb } from "../tenants.js";
import type { Env, Vars } from "../index.js";

// WP-10 Task 3 (REQ-082) — the command "exceptions" QUEUE: shipments that need attention. A DURABLE READ over
// the append-only ledger; it adds NO table, NO event kind, NO projection.
//
// THE TRAP (WP-10 sweep): status_cache is a MUTABLE projection. Its only exception signal, state='exception'
// (projection/status-cache.ts:135-136), is SILENTLY OVERWRITTEN by a later pod.signed→'delivered' (:133-134),
// and osd.captured projects NOTHING onto it. A queue built on status_cache therefore LOSES an item the instant
// its shipment delivers. So this queue reads the DURABLE exception.raised + osd.captured EVENTS — permanent in
// the `events` ledger, never overwritten (append-only, I3/I7) — via the Task-1 kind-filtered lens read
// (readEvents({kind:[...]}) / the same machinery behind GET /v1/events?kind=), and joins each event's shipment
// CURRENT state ONLY to decide open vs resolved.
//
// OPEN vs RESOLVED — an HONEST heuristic, NOT a fabricated resolution. There is NO exception.resolved kind in
// the frozen 35, and adding one is a register amendment we are NOT doing here. So "resolved" is inferred from
// one observable fact: the exception's shipment reached a TERMINAL state (delivered/settled). An exception on a
// still-live shipment is OPEN; one whose shipment delivered/settled is RESOLVED (dropped from ?status=open, but
// NEVER lost — ?status=all still surfaces it, flagged). This deliberately does NOT model a claim/adjudication
// lifecycle (an exception "worked" while the shipment is still moving still reads OPEN) — a formal resolve /
// claim-adjudication flow (and any exception.resolved kind it needs) is DEFERRED to WP-11. Documented as the
// WP-10 assumption; the flag name is `open`, and the heuristic is stated in the response's own contract.

// §1227 — imported, not re-declared: this list and the copilot's were independent copies of one
// domain claim with nothing comparing them. @shuddl/contracts owns it beside the 35-catalog.

// Terminal shipment states = the resolve signal. Only 'delivered' is produced today (pod.signed, status-cache
// .ts:133-134); 'settled' is listed forward-safe (a future settlement projection) so the heuristic need not
// change when it lands. Anything else — booked/dispatched/in_transit/exception/OFD/unknown/no-row — is LIVE → OPEN.
// TERMINAL_STATES is IMPORTED, not re-declared (audit §455). It was one of three hand-maintained copies
// of "what counts as finished" — here, routes/board.ts, and the exported one in @shuddl/ledger. Drift would
// make "active" mean different things in the ops queue, the customer map and the KPIs at the same time.

// The queue lists OPEN by default is NOT the contract here: `status=open` returns only the open ones; `status=all`
// (or an ABSENT param) returns ALL with an `open` flag. An unknown value is a hard 400 (mirrors events.ts
// parseKinds / approvals.ts) — never a silent empty result.
const STATUS_VALUES: ReadonlySet<string> = new Set(["open", "all"]);

// readEvents caps at 1000; this queue reads the FRESHEST page in ts-DESCENDING order (REQ-197). The default
// (stream_id, seq) read would truncate by lexicographic stream_id BEFORE any freshest-first sort — so past
// 1000 lifetime exception events a fresh OPEN exception could silently vanish. Ordering ts_desc makes the cap
// keep the newest, and `before_ts` pages OLDER: the response returns `next_before_ts` (the oldest ts on the
// page, or null when the page is short), so the queue walks back with NO silent loss. Exported so the read
// test can seed just past the cap.
export const EXCEPTIONS_LIMIT = 1000;

// DEFENSIVE payload read: exception.raised is a LOOSE JsonObject (contracts events.ts:319) — its reason_code may
// be ABSENT (an override-appended exception bypasses assertException; a legacy/migrated payload need not carry
// it). NEVER assume the field or the shape. osd.captured is strictly typed, but the SAME defensive read serves
// both. Returns null when the key is missing or not a string — no throw, no fabricated value.
function readString(payload: unknown, key: string): string | null {
  if (payload !== null && typeof payload === "object") {
    const v = (payload as Record<string, unknown>)[key];
    if (typeof v === "string") return v;
  }
  return null;
}

export function mountExceptionRoutes(app: Hono<{ Bindings: Env; Variables: Vars }>): void {
  // GET /v1/exceptions?status=open — the tenant-scoped exceptions queue. roles admin/ops/finance/read (the
  // tenant-lens roles; a portal party/driver has no command queue). Tenant comes from the JWT claim ONLY
  // (tenantDb / lensFor(session)) — never a header or query param (REQ-025).
  app.get("/v1/exceptions", requireRole("admin", "ops", "finance", "read"), async (c) => {
    const session = c.get("session");
    const db = await resolveTenantDb(c.env, session.tenant);

    const status = c.req.query("status") ?? "all";
    if (!STATUS_VALUES.has(status)) throw new ApiError("VALIDATION_FAILED", 400, "status MUST BE open OR all");

    // REQ-197 — the page-older keyset (the oldest ts of a prior page). Validated as a non-negative int; a
    // malformed cursor is a hard 400, never a silent full-page reset.
    const beforeTsRaw = c.req.query("before_ts");
    let beforeTs: number | undefined;
    if (beforeTsRaw !== undefined) {
      const n = Number(beforeTsRaw);
      if (!Number.isInteger(n) || n < 0) throw new ApiError("VALIDATION_FAILED", 400, "before_ts MUST BE a non-negative integer");
      beforeTs = n;
    }

    // The DURABLE read: exception.raised + osd.captured through the lens (REQ-082 kind filter, Task 1). For a
    // tenant-lens role this returns every in-tenant exception event UNREDACTED; the redaction still binds for
    // any non-tenant lens (none reach this route today, but the read goes THROUGH the lens, so it stays honest).
    // REQ-197 — order ts_desc so the 1000-cap retains the FRESHEST exception events (backed by ix_events_kind_ts);
    // the default (stream_id, seq) order would lexicographically truncate a fresh OPEN exception past the cap.
    const lens = lensFor(session);
    const events = await readEvents(db, lens, {
      kind: EXCEPTION_KINDS,
      limit: EXCEPTIONS_LIMIT,
      order: "ts_desc",
      ...(beforeTs !== undefined ? { before_ts: beforeTs } : {}),
    });

    // The page is already ts-DESCENDING from SQL; `next_before_ts` is the OLDEST ts on this page (the last
    // row), or null when the page is short (fewer than the cap ⇒ no older page). A caller re-requests with
    // `before_ts=next_before_ts` to walk back — nothing is silently lost, only paged.
    const nextBeforeTs = events.length < EXCEPTIONS_LIMIT ? null : events[events.length - 1]!.ts;

    // Join each event's shipment CURRENT state (one batched read) to decide open vs resolved. A shipment with no
    // row / no state is treated as LIVE (open) — fail toward surfacing an item that needs attention, never toward
    // hiding one.
    const shipmentIds = [...new Set(events.map((e) => e.shipment_id).filter((s): s is string => s !== undefined))];
    const stateById = new Map<string, string>();
    // REQ-197 — the freshest page can carry up to EXCEPTIONS_LIMIT distinct shipments, so CHUNK the state join:
    // a single `IN (...)` with ~1000 placeholders exceeds D1's per-statement bound-parameter ceiling (a 500).
    const STATE_JOIN_CHUNK = 90;
    for (let i = 0; i < shipmentIds.length; i += STATE_JOIN_CHUNK) {
      const chunk = shipmentIds.slice(i, i + STATE_JOIN_CHUNK);
      const res = await db
        .prepare(`SELECT id, json_extract(status_cache,'$.state') AS state FROM shipments WHERE id IN (${chunk.map(() => "?").join(",")})`)
        .bind(...chunk)
        .all<{ id: string; state: string | null }>();
      for (const r of res.results) if (r.state !== null) stateById.set(r.id, r.state);
    }

    const items = events.map((e) => {
      const state = e.shipment_id !== undefined ? stateById.get(e.shipment_id) : undefined;
      const open = !(state !== undefined && TERMINAL_STATES.has(state));
      return {
        shipment_id: e.shipment_id ?? null,
        exception_event_id: e.id, // the citation handle for command click-through (GET /v1/shipments/:id/events)
        kind: e.kind,
        reason_code: readString(e.payload, "reason_code"), // defensive — may be absent
        ts: e.ts,
        open,
      };
    });

    // The page arrives freshest-first from SQL (ts DESC, REQ-197) — no JS re-sort needed. `status=open` filters
    // to the live ones; `all`/absent returns every exception ON THIS PAGE with its `open` flag (a delivered
    // shipment's exception reads open:false — present-but-resolved, never dropped). Older pages are reachable via
    // `before_ts=next_before_ts`, so a fresh open exception past the cap surfaces at the top instead of vanishing.
    const filtered = status === "open" ? items.filter((i) => i.open) : items;
    return c.json({ exceptions: filtered, next_before_ts: nextBeforeTs });
  });
}
