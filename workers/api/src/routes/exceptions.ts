import type { Hono } from "hono";
import type { EventKind } from "@shuddl/contracts";
import { lensFor, readEvents } from "@shuddl/ledger/lens";
import { ApiError } from "../middleware/error.js";
import { requireRole } from "../middleware/auth.js";
import { tenantDb } from "../tenants.js";
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

const EXCEPTION_KINDS: readonly EventKind[] = ["exception.raised", "osd.captured"];

// Terminal shipment states = the resolve signal. Only 'delivered' is produced today (pod.signed, status-cache
// .ts:133-134); 'settled' is listed forward-safe (a future settlement projection) so the heuristic need not
// change when it lands. Anything else — booked/dispatched/in_transit/exception/OFD/unknown/no-row — is LIVE → OPEN.
const TERMINAL_STATES: ReadonlySet<string> = new Set(["delivered", "settled"]);

// The queue lists OPEN by default is NOT the contract here: `status=open` returns only the open ones; `status=all`
// (or an ABSENT param) returns ALL with an `open` flag. An unknown value is a hard 400 (mirrors events.ts
// parseKinds / approvals.ts) — never a silent empty result.
const STATUS_VALUES: ReadonlySet<string> = new Set(["open", "all"]);

// readEvents caps at 1000; grab a full page. v1 does not paginate the queue (the WP-10 command surface renders a
// bounded, freshest-first list); a cursored exceptions feed is deferred with the WP-11 resolve flow.
const EXCEPTIONS_LIMIT = 1000;

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
    const db = tenantDb(c.env, session.tenant);

    const status = c.req.query("status") ?? "all";
    if (!STATUS_VALUES.has(status)) throw new ApiError("VALIDATION_FAILED", 400, "status MUST BE open OR all");

    // The DURABLE read: exception.raised + osd.captured through the lens (REQ-082 kind filter, Task 1). For a
    // tenant-lens role this returns every in-tenant exception event UNREDACTED; the redaction still binds for
    // any non-tenant lens (none reach this route today, but the read goes THROUGH the lens, so it stays honest).
    const lens = lensFor(session);
    const events = await readEvents(db, lens, { kind: EXCEPTION_KINDS, limit: EXCEPTIONS_LIMIT });

    // Join each event's shipment CURRENT state (one batched read) to decide open vs resolved. A shipment with no
    // row / no state is treated as LIVE (open) — fail toward surfacing an item that needs attention, never toward
    // hiding one.
    const shipmentIds = [...new Set(events.map((e) => e.shipment_id).filter((s): s is string => s !== undefined))];
    const stateById = new Map<string, string>();
    if (shipmentIds.length > 0) {
      const res = await db
        .prepare(
          `SELECT id, json_extract(status_cache,'$.state') AS state FROM shipments WHERE id IN (${shipmentIds.map(() => "?").join(",")})`,
        )
        .bind(...shipmentIds)
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

    // Freshest-first — a queue reads newest-needing-attention at the top. `status=open` filters to the live ones;
    // `all`/absent returns every exception with its `open` flag (a delivered shipment's exception reads open:false,
    // present but resolved — never dropped).
    items.sort((a, b) => b.ts - a.ts);
    const filtered = status === "open" ? items.filter((i) => i.open) : items;
    return c.json({ exceptions: filtered });
  });
}
