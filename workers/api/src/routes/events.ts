import type { Hono } from "hono";
import type { ErrorCode, LedgerEvent, Role } from "@shuddl/contracts";
import { GATE_BLOCKED_PREFIX } from "@shuddl/contracts";
import { lensFor, readEvents, type ReadQuery } from "@shuddl/ledger/lens";
import { ApiError } from "../middleware/error.js";
import { requireRole } from "../middleware/auth.js";
import { tenantDb } from "../tenants.js";
import type { AppendedEvent } from "../do/sequencer.js";
import type { Env, Vars } from "../index.js";

// REQ-015 / REQ-002 / REQ-156 / I6 — the lens-scoped ledger read/write surface (doc 14 §04).
// Tenant AND party come from the JWT claim ONLY (lensFor(session)); a header or query param is never
// consulted for scoping. The sequencer DO owns seq/prev_hash/hash/visibility; this route owns HTTP
// shape, role gating, the driver write-scope, and translating the DO's RPC-safe errors to the envelope.

// The DO's RPC surface. Its return type is a 35-member zod union whose recursive payload makes the
// generic DurableObjectStub mapper explode, so we bind a hand-written surface (as sequencer.test does).
export type SeqStub = DurableObjectStub & {
  append(req: { tenant: string; streamId: string; input: unknown }): Promise<AppendedEvent>;
};

// ---- error translation (Workers RPC preserves only Error name/message, so `instanceof ApiError` is
// false on arrival). The DO throws `Error("CODE:json")`; split on the FIRST colon, parse the JSON tail,
// and rethrow the envelope. GATE_BLOCKED carries gate.required_evidence; an unknown prefix is INTERNAL.
const APPEND_STATUS: Record<string, number> = { GATE_BLOCKED: 403, FORBIDDEN: 403, VALIDATION_FAILED: 400, UNAUTHORIZED: 401 };
const APPEND_MESSAGE: Record<string, string> = {
  GATE_BLOCKED: "GATE BLOCKED",
  FORBIDDEN: "FORBIDDEN",
  VALIDATION_FAILED: "VALIDATION FAILED",
  UNAUTHORIZED: "UNAUTHORIZED",
};

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function translateAppendError(e: unknown): ApiError {
  const msg = e instanceof Error ? e.message : String(e);
  const idx = msg.indexOf(":");
  const code = idx >= 0 ? msg.slice(0, idx) : msg;
  const status = APPEND_STATUS[code];
  if (status === undefined) return new ApiError("INTERNAL", 500, "INTERNAL ERROR");
  let gate: { required_evidence: string[] } | undefined;
  // Recognize the gate block via the SHARED wire prefix (derived from ErrorCode.GATE_BLOCKED) — the SAME
  // constant the producer (GateError) builds and the Booking agent (booking.ts gateBlock) matches, so this
  // route can never drift from them. Byte-identical to the prior `code === "GATE_BLOCKED"` literal.
  if (`${code}:` === GATE_BLOCKED_PREFIX) {
    const detail = idx >= 0 ? safeJson(msg.slice(idx + 1)) : null;
    const raw = detail && typeof detail === "object" ? (detail as { required_evidence?: unknown }).required_evidence : undefined;
    gate = { required_evidence: Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [] };
  }
  return new ApiError(code as ErrorCode, status, APPEND_MESSAGE[code] ?? code, gate);
}

// readEvents / lensFor throw PLAIN Errors for a misused cursor or an unresolved lens — surface them as
// clean 4xx envelopes instead of letting handleError render an opaque 500. Anything else rethrows as-is.
function toReadError(e: unknown): unknown {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.startsWith("INVALID_CURSOR")) return new ApiError("VALIDATION_FAILED", 400, "INVALID CURSOR");
  if (msg.startsWith("LENS_UNRESOLVED")) return new ApiError("FORBIDDEN", 403, "SESSION LENS UNRESOLVED");
  return e;
}

// REQ-030 / REQ-003 — money is a PROJECTION the SERVER emits, never a client fact. These kinds are
// composed and appended ONLY through server-internal seams: the Biller's SeqStub (invoice.issued/
// invoice.corrected/split.computed/settlement/payment money) and the Rater. The anomaly / penny-parity /
// executing-share-floor gates that make them safe live in composeInvoice — NOT in the DO append gate
// (which only runs I2/assertPodSigned) — so a client POST of a hand-crafted one would BYPASS every one
// of them (the $222,084 fail-open). The public events route REFUSES them outright, before the DO append.
// The internal seams (rate.ts / biller.ts) call SHIPMENT_SEQ.append directly and never traverse this
// route, so the server's own emissions are unaffected.
const SERVER_EMITTED_KINDS: ReadonlySet<string> = new Set<string>([
  "invoice.issued",
  "invoice.corrected",
  "split.computed",
  "payment.received",
  "settlement.executed",
]);

const LIMIT_CAP = 1000;
const DEFAULT_LIMIT = 200; // mirrors @shuddl/ledger/lens readEvents so next_cursor agrees with the page size
// A shipment id far under any DO-name / KV-key limit; a real id is a slug, never kilobytes. Length only —
// the DO owns the format check. 200 chars leaves ample headroom below the 2KB DO-name and 512B KV limits.
const MAX_SHIPMENT_ID_LEN = 200;

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new ApiError("VALIDATION_FAILED", 400, "limit MUST BE A POSITIVE INTEGER");
  return n;
}

function parseAfterSeq(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new ApiError("VALIDATION_FAILED", 400, "after_seq MUST BE A NON-NEGATIVE INTEGER");
  return n;
}

// Composite keyset cursor `<stream_id>:<seq>`. stream_id itself contains a colon (`s:{id}`), so split on
// the LAST colon — a first-colon split would truncate the stream id and silently page the wrong stream.
function parseCursor(raw: string | undefined): { stream_id: string; seq: number } | undefined {
  if (raw === undefined || raw === "") return undefined;
  const i = raw.lastIndexOf(":");
  if (i <= 0 || i === raw.length - 1) throw new ApiError("VALIDATION_FAILED", 400, "cursor MUST BE <stream_id>:<seq>");
  const seq = Number(raw.slice(i + 1));
  if (!Number.isInteger(seq) || seq < 0) throw new ApiError("VALIDATION_FAILED", 400, "cursor seq MUST BE A NON-NEGATIVE INTEGER");
  return { stream_id: raw.slice(0, i), seq };
}

// A full page implies more rows may follow: hand back a keyset cursor on the last row. A short page is
// the end (null). Keyed on (stream_id, seq) so it is stable across streams (doc 14 §04).
function nextCursor(events: LedgerEvent[], limit: number | undefined): string | null {
  const effective = Math.min(limit ?? DEFAULT_LIMIT, LIMIT_CAP);
  if (events.length < effective) return null;
  const last = events[events.length - 1];
  return last ? `${last.stream_id}:${last.seq}` : null;
}

export function mountEventRoutes(app: Hono<{ Bindings: Env; Variables: Vars }>): void {
  // POST /v1/shipments/:id/events — append one event to a shipment stream. Mutation ⇒ the WP-01
  // idempotency middleware already requires the Idempotency-Key header (dedupes the HTTP retry); the
  // sequencer additionally dedupes by event id + (device_id, device_seq).
  app.post("/v1/shipments/:id/events", requireRole("admin", "ops", "driver"), async (c) => {
    const session = c.get("session");
    const shipmentId = c.req.param("id");
    // Bound the shipment id BEFORE it reaches the DO name (idFromName) or any query: an oversized id is
    // a client mistake (400), not a 500. The DO's stream-id regex is the authority on FORMAT; this only
    // caps LENGTH so a pathological id can't blow a downstream limit. (The KV idempotency key is already
    // hashed to a fixed length, so the middleware no longer 500s on a long path — this keeps the 4xx clean.)
    if ((shipmentId?.length ?? 0) > MAX_SHIPMENT_ID_LEN) {
      throw new ApiError("VALIDATION_FAILED", 400, "SHIPMENT ID TOO LONG");
    }
    const streamId = `s:${shipmentId}`;

    const input: unknown = await c.req.json().catch(() => null); // NEVER LedgerEvent.parse a request body — the DO parses EventInput

    // REQ-030 / REQ-003 — a server-emitted money kind can NEVER be appended by a client, no matter the
    // role. Refused HERE, before the override handling, the driver write-scope, and the DO append — so
    // even an elevated ops/admin principal (and even a well-formed one on a pod-bearing stream, where the
    // DO's I2 gate would otherwise pass) cannot bypass composeInvoice's anomaly/penny-parity/floor gates.
    // Checked first so the refusal a client sees is the server-only reason, never a mere scope miss.
    const inKind = input !== null && typeof input === "object" ? (input as { kind?: unknown }).kind : undefined;
    if (typeof inKind === "string" && SERVER_EMITTED_KINDS.has(inKind)) {
      throw new ApiError("FORBIDDEN", 403, "THIS EVENT KIND IS SERVER-EMITTED ONLY (REQ-030)");
    }

    // REQ-049 (WP-05 exit audit) — a gate override is an ACCOUNTABLE, ELEVATED action, enforced HERE:
    // the route holds the session; the DO does not. If the event carries an `override`:
    //   (a) the caller MUST have an elevated role (ops/admin/finance) — a driver/portal/read override is
    //       403 FORBIDDEN with NOTHING appended (checked before the driver write-scope + the DO append); and
    //   (b) the accountability author is STAMPED to the AUTHENTICATED principal (`session.sub`), overriding
    //       any client-claimed `by`, so the "who overrode this gate" record can never be forged. The
    //       client's `reason` is kept verbatim (EventOverride rejects a blank one downstream → 400).
    // Only {by, reason} survive (EventOverride is .strict()); a malformed/extra-key override is a clean 400.
    if (input !== null && typeof input === "object" && (input as { override?: unknown }).override !== undefined) {
      const ELEVATED: ReadonlySet<Role> = new Set<Role>(["ops", "admin", "finance"]);
      if (!ELEVATED.has(session.role)) throw new ApiError("FORBIDDEN", 403, "OVERRIDE REQUIRES AN ELEVATED ROLE");
      const claimed = (input as { override: unknown }).override;
      const reason = claimed !== null && typeof claimed === "object" ? (claimed as { reason?: unknown }).reason : undefined;
      (input as { override: unknown }).override = { by: session.sub, reason };
    }

    // Driver write-scope (the plan leaves this to the route — the DO scopes tenant, the lens scopes
    // READS, neither scopes a driver's WRITES): a driver may append ONLY to a shipment the status-cache
    // projection has assigned to them. ops/admin are unrestricted.
    if (session.role === "driver") {
      const row = await tenantDb(c.env, session.tenant)
        .prepare("SELECT json_extract(status_cache,'$.assigned_driver') AS d FROM shipments WHERE id = ?")
        .bind(shipmentId)
        .first<{ d: string | null }>();
      if (!row || row.d !== session.sub) throw new ApiError("FORBIDDEN", 403, "DRIVER NOT ASSIGNED TO THIS SHIPMENT");
    }

    const stub = c.env.SHIPMENT_SEQ.get(c.env.SHIPMENT_SEQ.idFromName(`${session.tenant}|${streamId}`)) as unknown as SeqStub;
    let event: AppendedEvent;
    try {
      // Tenant comes ONLY from the claim; the DO re-derives its own id from it and rejects a mismatch.
      event = await stub.append({ tenant: session.tenant, streamId, input });
    } catch (e) {
      throw translateAppendError(e);
    }
    return c.json(event, 201);
  });

  // GET /v1/shipments/:id/events — the shipment feed through the caller's lens.
  app.get("/v1/shipments/:id/events", async (c) => {
    const session = c.get("session");
    const db = tenantDb(c.env, session.tenant);
    try {
      const lens = lensFor(session);
      const limit = parseLimit(c.req.query("limit"));
      const q: ReadQuery = { shipment_id: c.req.param("id") };
      const afterSeq = parseAfterSeq(c.req.query("after_seq"));
      if (afterSeq !== undefined) q.after_seq = afterSeq;
      if (limit !== undefined) q.limit = limit;
      const events = await readEvents(db, lens, q);
      return c.json({ events, next_cursor: nextCursor(events, limit) });
    } catch (e) {
      throw toReadError(e);
    }
  });

  // GET /v1/events — the cross-stream firehose. Tenant-lens roles only; portal/driver must scope by
  // shipment (their lens narrows a single-shipment read, not the whole tenant). Composite keyset cursor.
  app.get("/v1/events", requireRole("admin", "ops", "finance", "read"), async (c) => {
    const session = c.get("session");
    const db = tenantDb(c.env, session.tenant);
    try {
      const lens = lensFor(session); // tenant scope for these roles
      const limit = parseLimit(c.req.query("limit"));
      const q: ReadQuery = {};
      const cursor = parseCursor(c.req.query("cursor"));
      if (cursor) q.cursor = cursor;
      const afterSeq = parseAfterSeq(c.req.query("after_seq"));
      if (afterSeq !== undefined) q.after_seq = afterSeq; // readEvents rejects after_seq without a shipment scope -> 400
      if (limit !== undefined) q.limit = limit;
      const events = await readEvents(db, lens, q);
      return c.json({ events, next_cursor: nextCursor(events, limit) });
    } catch (e) {
      throw toReadError(e);
    }
  });
}
