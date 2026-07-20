// WP-13 Task 8 (REQ-105) — THE SPEND / VELOCITY / LANE CAP CHECK, the highest-risk net-new MCP gate.
//
// This is a MutationCheck in the chokepoint chain (gate.ts DEFAULT_MUTATION_CHECKS). It runs SERVER-SIDE, ahead of
// the book_shipment handler, over the OAuth principal — so a hostile prompt can NEVER talk past it. The caps live in
// the pairing's control-plane `caps` JSON ({spend, velocity, lanes}); the check reads them, prices the booking off
// the SERVER-RECORDED accepted quote (never a client-supplied number), and refuses (MutationBlocked) a booking that
// would breach a cap or ride an off-lane quote.
//
// ── ATTRIBUTE TO THE ACTING PAIRING, NEVER refs.pairing (the anti-bypass property) ────────────────────────────
// `refs.pairing` is stamped at shipment CREATION (the originator). Tallying by refs.pairing would let a hostile
// pairing B dodge ITS OWN cap by booking pairing A's pre-created quotes (they'd count against A). So the tally is
// keyed off `ctx.pairingId` — the pairing ACTING on book_shipment, derived from the OAuth token, never a client
// field and never refs. The ledger does not record the acting pairing, so the mcp worker keeps its own per-actor
// counter (CapsMeter DO), keyed by ctx.pairingId.
//
// ── FAIL CLOSED, EVERYWHERE ───────────────────────────────────────────────────────────────────────────────────
// Unresolvable pairing, absent/partial/unparseable caps, an unreadable accepted quote, or a counter-storage fault
// all REFUSE the booking — never allow it. An unconfigured cap is ZERO, never infinite (see parseCaps).
//
// ── RESERVE-AT-CHECK (the reserve/commit ordering) ────────────────────────────────────────────────────────────
// The chokepoint runs BEFORE the handler and exposes NO post-handler hook (registry.ts dispatch: beforeMutation →
// clear ctx → handler, no completion callback), and book_shipment is left unmodified. So the atomic
// `checkAndReserve` COMMITS the increment at the moment the check passes — before the accept-quote api write. On a
// rare post-check api failure the slot stays consumed: this OVER-counts (a consumed slot), which fails CLOSED (it
// can only ever refuse a later booking), and NEVER under-counts (which would fail OPEN, the forbidden direction —
// REQ-105). We choose this conservative over-count over a release path we cannot wire without a handler hook.
import { MutationBlocked, type MutationCheck } from "./gate.js";
import type { ToolCtx, ToolDef } from "./tools/registry.js";
import type { ReserveRequest, ReserveResult } from "./caps-meter.js";

/** ONLY book_shipment is metered — the money-moving mutation that accepts a priced quote. */
const BOOK_TOOL = "book_shipment";

/** The DO stub surface (the generic DurableObjectStub RPC mapper is bound to a hand-written surface, as the api's
 *  sequencer call sites do — the runtime is unchanged; this is purely the call-site type). */
type CapsMeterStub = DurableObjectStub & {
  checkAndReserve(req: ReserveRequest): Promise<ReserveResult>;
};

/** The parsed, VALIDATED caps for a pairing. spend/velocity are required; lanes is an optional allow-list. */
interface ParsedCaps {
  /** Spend cap per period, integer cents (matches the accepted quote's `sell`). */
  spendCents: number;
  /** Velocity cap: max bookings per period. */
  velocity: number;
  /** Allowed lane tokens (dest zone / matched zip prefix). Absent ⇒ no lane restriction; present ⇒ enforced. */
  lanes?: string[];
}

/**
 * Parse the pairing's `caps` JSON, FAIL-CLOSED. Returns null (⇒ refuse the booking) when caps are absent,
 * unparseable, not an object, or MISSING a valid spend/velocity — an unconfigured OR partial cap is treated as
 * unusable (ZERO capacity), never as infinite. `lanes`, when a string array, is an allow-list; anything else omits
 * it (⇒ no lane restriction). Units: `spend` is integer cents; `velocity` is a non-negative integer count.
 */
export function parseCaps(raw: string | null | undefined): ParsedCaps | null {
  if (typeof raw !== "string") return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  const spend = rec.spend;
  const velocity = rec.velocity;
  if (typeof spend !== "number" || !Number.isFinite(spend) || spend < 0) return null;
  if (typeof velocity !== "number" || !Number.isInteger(velocity) || velocity < 0) return null;
  const out: ParsedCaps = { spendCents: spend, velocity };
  if (Array.isArray(rec.lanes)) out.lanes = rec.lanes.filter((x): x is string => typeof x === "string");
  return out;
}

/** The metering period: the UTC calendar month, "YYYY-MM". A clear, deterministic window off the worker clock. */
export function currentPeriod(now: number): string {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** What the accepted quote contributes to the caps decision: its recorded sell + its lane tokens. */
interface BookingBasis {
  spendCents: number;
  laneTokens: string[];
}

/**
 * Read THIS booking's spend + lane from the SERVER-RECORDED accepted quote.priced event (never a client number).
 * Hops GET /v1/shipments/:id/events?kind=quote.priced with a freshly minted principal, finds the event whose id ==
 * quote_event_id (the exact quote being accepted), and reads `payload.sell` (cents) + `payload.basis` (the dest
 * zone / matched zip prefix the price was actually computed against). FAIL-CLOSED: any read/shape failure throws
 * MutationBlocked — an undeterminable spend/lane refuses the booking, it never defaults to allow.
 */
async function loadAcceptedQuote(ctx: ToolCtx, shipmentId: string, quoteEventId: string): Promise<BookingBasis> {
  let res: Response;
  try {
    res = await ctx.callApi(ctx.env, {
      method: "GET",
      path: `/v1/shipments/${encodeURIComponent(shipmentId)}/events?kind=quote.priced`,
      jwt: await ctx.mintJwt(),
    });
  } catch {
    throw new MutationBlocked("caps_quote_unresolved", "could not read the accepted quote; booking refused (fail-closed)");
  }
  if (!res.ok) {
    throw new MutationBlocked("caps_quote_unresolved", `could not read the accepted quote (api ${res.status}); booking refused (fail-closed)`);
  }
  let body: { events?: unknown };
  try {
    body = (await res.json()) as { events?: unknown };
  } catch {
    throw new MutationBlocked("caps_quote_unresolved", "malformed quote read; booking refused (fail-closed)");
  }
  const events = Array.isArray(body.events) ? body.events : [];
  const match = events.find(
    (e): e is Record<string, unknown> => typeof e === "object" && e !== null && (e as Record<string, unknown>).id === quoteEventId,
  );
  if (match === undefined) {
    throw new MutationBlocked("caps_quote_unresolved", "the accepted quote.priced event is not on the shipment; booking refused (fail-closed)");
  }
  const payload = (typeof match.payload === "object" && match.payload !== null ? match.payload : {}) as Record<string, unknown>;
  const sell = payload.sell;
  if (typeof sell !== "number" || !Number.isFinite(sell) || sell < 0) {
    throw new MutationBlocked("caps_quote_unresolved", "the accepted quote carries no sell; booking refused (no price on air)");
  }
  const basis = (typeof payload.basis === "object" && payload.basis !== null ? payload.basis : {}) as Record<string, unknown>;
  const laneTokens: string[] = [];
  if (typeof basis.zone === "string") laneTokens.push(basis.zone);
  if (typeof basis.matched_zip_prefix === "string") laneTokens.push(basis.matched_zip_prefix);
  return { spendCents: sell, laneTokens };
}

/**
 * THE cap check. A pass-through for every tool except book_shipment; for a booking it enforces (in order) lane →
 * spend+velocity, all keyed off ctx.pairingId (the OAuth token subject), all fail-closed.
 */
async function runCapsCheck(ctx: ToolCtx, tool: ToolDef, args: unknown): Promise<void> {
  if (tool.name !== BOOK_TOOL) return; // only the money-moving booking is metered

  // The booking args (already Zod-validated by dispatch: {shipment_id, quote_event_id}). We read ONLY these two
  // + ctx.pairingId — NEVER a pairing_id/cap/caps field a hostile caller might smuggle in (a strict tool schema
  // already rejects unknown keys upstream; this check ignores them regardless).
  const a = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  const shipmentId = typeof a.shipment_id === "string" ? a.shipment_id : undefined;
  const quoteEventId = typeof a.quote_event_id === "string" ? a.quote_event_id : undefined;
  if (shipmentId === undefined || quoteEventId === undefined) {
    throw new MutationBlocked("caps_unresolved", "booking is missing shipment_id/quote_event_id; refused (fail-closed)");
  }

  // 1. Load the ACTING pairing's caps from the control plane — keyed by ctx.pairingId ONLY. Any storage fault, an
  //    unresolvable pairing, or absent/partial caps ⇒ refuse (fail-closed; an unconfigured cap is ZERO, not ∞).
  let capsRaw: string | null;
  try {
    const row = await ctx.env.CONTROL_DB.prepare("SELECT caps FROM pairings WHERE id = ?").bind(ctx.pairingId).first<{ caps: string }>();
    capsRaw = row?.caps ?? null;
  } catch {
    throw new MutationBlocked("caps_storage_error", "cap lookup failed; booking refused (fail-closed)");
  }
  const caps = parseCaps(capsRaw);
  if (caps === null) {
    throw new MutationBlocked("caps_unconfigured", "no spend/velocity cap configured for this principal; booking refused (fail-closed)");
  }

  // 2. Price THIS booking off the server-recorded accepted quote (spend + lane).
  const { spendCents, laneTokens } = await loadAcceptedQuote(ctx, shipmentId, quoteEventId);

  // 3. LANE — a fail-closed allow-list. If caps.lanes is set, at least one derived lane token must be allowed;
  //    an unknown lane (empty tokens) against a set allow-list is refused. Absent caps.lanes ⇒ no restriction.
  if (caps.lanes !== undefined) {
    const onLane = laneTokens.some((t) => caps.lanes!.includes(t));
    if (!onLane) {
      throw new MutationBlocked("lane_not_allowed", `lane [${laneTokens.join(", ") || "unknown"}] is not in this principal's allowed lanes`);
    }
  }

  // 4. SPEND + VELOCITY — atomic checkAndReserve on the per-actor DO (keyed by ctx.pairingId). A storage fault ⇒
  //    refuse (fail-closed). A pass COMMITS the increment (reserve-at-check; see the file header).
  const period = currentPeriod(Date.now());
  let result: ReserveResult;
  try {
    const stub = ctx.env.CAPS_METER.get(ctx.env.CAPS_METER.idFromName(ctx.pairingId)) as unknown as CapsMeterStub;
    result = await stub.checkAndReserve({ period, spendCents, capSpendCents: caps.spendCents, capVelocity: caps.velocity });
  } catch {
    throw new MutationBlocked("caps_meter_error", "usage meter unavailable; booking refused (fail-closed)");
  }
  if (!result.ok) {
    if (result.reason === "spend") {
      throw new MutationBlocked("spend_cap_exceeded", `booking would exceed the spend cap (${caps.spendCents}¢ / period)`);
    }
    throw new MutationBlocked("velocity_cap_exceeded", `booking would exceed the velocity cap (${caps.velocity} / period)`);
  }
}

/** The composable check registered into gate.ts DEFAULT_MUTATION_CHECKS at the marked line (Task 8). */
export const capsCheck: MutationCheck = {
  name: "caps",
  check: runCapsCheck,
};
