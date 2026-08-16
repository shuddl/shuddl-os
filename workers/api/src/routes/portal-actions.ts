import type { Hono } from "hono";
import { z } from "zod";
import type { SessionClaims } from "@shuddl/contracts";
import { lensFor, readEvents } from "@shuddl/ledger/lens";
import { ApiError } from "../middleware/error.js";
import { requireRole } from "../middleware/auth.js";
import { resolveTenantDb } from "../tenants.js";
import { translateAppendError, type SeqStub } from "./events.js";
import type { AppendedEvent } from "../do/sequencer.js";
import type { Env, Vars } from "../index.js";

// REQ-085 (WP-09 Task 8) — the NARROW, lens-gated PORTAL ACTION seams. A portal party is a COUNTERPARTY, not
// an operator: it must NOT be handed the general event-POST (that is a security surface — the
// /v1/shipments/:id/events route deliberately EXCLUDES `portal` from its role set). Instead this module
// exposes exactly the two purpose-specific writes a portal party legitimately performs on a shipment it can
// already see:
//   POST /v1/shipments/:id/accept-quote — accept a priced quote → quote.accepted (triggers the WP-08 Booking agent)
//   POST /v1/shipments/:id/claim        — file a claim as a portal-channel message.received (timeline + Concierge queue)
// BOTH:
//   · are LENS-GATED on :id — the caller must SEE the shipment through its OWN lens (the status-link.ts /
//     documents.ts precedent: readEvents(db, lensFor(session), {shipment_id, limit:1}) ≥ 1 → allowed, else 403).
//     tenant-lens roles (admin/ops) are unrestricted; a portal party is scoped to its own party lens.
//   · append THROUGH the sequencer DO (the SAME gated write path every event takes) — never a bypass, so I1/I2
//     and every Gatekeeper gate still run.
//   · emit a FIXED kind (quote.accepted / message.received) — a portal party can NEVER reach booking.created, a
//     money kind, or a gate override here: those live on routes/paths portal cannot call (booking.created is
//     produced ONLY by the Booking agent through the DO's credit/evidence gates; money kinds are refused for
//     every client on the events route; overrides need an elevated role there). REQ-030 holds server-side.

const MAX_SHIPMENT_ID_LEN = 200; // mirrors events.ts — bound length BEFORE the DO name / any query (400, not 500)
const MAX_EVENT_ID_LEN = 200; // a quote event id is a uuid; bound its length before the DO/query
const CLAIM_DESCRIPTION_MAX = 4_000; // BOUNDED (REQ-010): the claim text rides inline in the event canonical hash
const CLAIM_SUBJECT_MAX = 200;
const CLAIM_THREAD_MAX = 200;
const PORTAL_ACTION_CONFIDENCE_BPS = 10_000; // a deterministic server-recorded fact, full confidence (mirrors rate.ts)

// A DETERMINISTIC v4-variant UUID (satisfies EventInput.id = z.string().uuid()) from a domain-separated seed —
// the SAME shaping rate.ts / booking.ts / concierge.ts use, so a retry reproduces the SAME id and the sequencer
// dedupes by id (one append, never a duplicate). Used to make accept idempotent PER QUOTE and claim idempotent
// PER Idempotency-Key.
async function deterministicUuid(seed: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
  const h = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  const variant = ((parseInt(h.slice(16, 17) || "0", 16) & 0x3) | 0x8).toString(16); // 8/9/a/b
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// THE lens gate, shared by both seams: prove the caller can SEE :id through its OWN lens (the exact seam the
// events read + status-link mint use), fail-closed. A portal session missing party_id throws LENS_UNRESOLVED →
// clean 403 (never an opaque 500). Zero visible rows → the shipment is not in the caller's scope → 403.
async function requireShipmentVisible(session: SessionClaims, db: D1Database, shipmentId: string): Promise<void> {
  let visibleCount: number;
  try {
    const lens = lensFor(session);
    const events = await readEvents(db, lens, { shipment_id: shipmentId, limit: 1 });
    visibleCount = events.length;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith("LENS_UNRESOLVED")) throw new ApiError("FORBIDDEN", 403, "SESSION LENS UNRESOLVED");
    throw e;
  }
  if (visibleCount === 0) throw new ApiError("FORBIDDEN", 403, "SHIPMENT NOT IN YOUR SCOPE");
}

// Append ONE server-composed event through the sequencer DO (the gated path). Actor + party_refs are
// SERVER-CONTROLLED from the session: actor.party = the authenticated party (or the ops principal), and
// party_refs carries the acting party so it surfaces the event on its OWN lens. None of the kinds this module
// emits (quote.accepted / message.received) accrue a projection with a parties FK, so a party-less ops actor
// (session.sub) is a safe sentinel. Tenant comes from the claim only; the DO re-derives its id and rejects a
// mismatch (REQ-025).
async function appendThroughSequencer(
  env: Env,
  session: SessionClaims,
  shipmentId: string,
  kind: "quote.accepted" | "message.received",
  eventId: string,
  payload: Record<string, unknown>,
): Promise<AppendedEvent> {
  const streamId = `s:${shipmentId}`;
  const stub = env.SHIPMENT_SEQ.get(env.SHIPMENT_SEQ.idFromName(`${session.tenant}|${streamId}`)) as unknown as SeqStub;
  try {
    return await stub.append({
      tenant: session.tenant,
      streamId,
      input: {
        id: eventId,
        shipment_id: shipmentId,
        ts: Date.now(),
        actor: { party: session.party_id ?? session.sub },
        party_refs: session.party_id !== undefined ? [session.party_id] : [],
        evidence: [],
        source: "native",
        confidence: PORTAL_ACTION_CONFIDENCE_BPS,
        kind,
        payload,
      },
    });
  } catch (e) {
    throw translateAppendError(e);
  }
}

// The accept body — bounded + .strict(): ONLY the id of the priced quote being accepted. quote.accepted's
// payload IS {quote_event_id} (QuoteAcceptedPayload), so this is the whole client surface.
const AcceptQuoteBody = z.object({ quote_event_id: z.string().min(1).max(MAX_EVENT_ID_LEN) }).strict();

// The claim body — bounded + .strict(). The claim text rides inline as the message body; subject/thread are
// optional. Every client-suppliable string is length-capped (rides the canonical hash — REQ-010).
const ClaimBody = z
  .object({
    description: z.string().min(1).max(CLAIM_DESCRIPTION_MAX),
    subject: z.string().min(1).max(CLAIM_SUBJECT_MAX).optional(),
    thread: z.string().min(1).max(CLAIM_THREAD_MAX).optional(),
  })
  .strict();

export function mountPortalActionRoutes(app: Hono<{ Bindings: Env; Variables: Vars }>): void {
  // POST /v1/shipments/:id/accept-quote — a portal party (or ops/admin) accepts a priced quote it can see,
  // appending quote.accepted{quote_event_id}. A COMMITTED quote.accepted triggers the WP-08 Booking agent
  // (sequencer → AGENT_QUEUE → gated booking.created). The portal party never emits booking.created — it emits
  // ONLY this fixed quote.accepted; booking.created is the agent's job, behind the credit/evidence gates.
  app.post("/v1/shipments/:id/accept-quote", requireRole("admin", "ops", "portal"), async (c) => {
    const session = c.get("session");
    const shipmentId = c.req.param("id") ?? "";
    if (shipmentId.length > MAX_SHIPMENT_ID_LEN) throw new ApiError("VALIDATION_FAILED", 400, "SHIPMENT ID TOO LONG");
    const db = await resolveTenantDb(c.env, session.tenant);

    // 1) LENS GATE on :id (fail-closed) — checked FIRST so an unauthorized caller learns nothing about the body.
    await requireShipmentVisible(session, db, shipmentId);

    // 2) bounded body
    const parsed = AcceptQuoteBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError("VALIDATION_FAILED", 400, "INVALID ACCEPT-QUOTE BODY");
    const { quote_event_id } = parsed.data;

    // 3) the accepted quote MUST exist as a quote.priced ON THIS shipment's stream. The caller already passed
    //    the shipment lens gate, so this existence probe is scoped to a stream it is authorized to see (a portal
    //    party can never name a quote off a shipment outside its scope). Mirrors booking.ts GUARD 2 — a dangling
    //    or wrong-kind quote_event_id is a client error, never an accept-then-booking of a phantom quote.
    const quoteRow = await db
      .prepare("SELECT 1 AS present FROM events WHERE stream_id = ? AND id = ? AND kind = 'quote.priced' LIMIT 1")
      .bind(`s:${shipmentId}`, quote_event_id)
      .first<{ present: number }>();
    if (quoteRow === null) throw new ApiError("VALIDATION_FAILED", 400, "QUOTE NOT PRICED ON THIS SHIPMENT");

    // 4) append quote.accepted. The event id is DETERMINISTIC from the accepted quote id, so accepting the same
    //    quote twice (even via two Idempotency-Keys, past the HTTP idempotency window) yields ONE quote.accepted
    //    (DO dedupe) → ONE Booking trigger → ONE booking. Twice in = once out.
    const eventId = await deterministicUuid(`quote-accepted:${quote_event_id}`);
    const event = await appendThroughSequencer(c.env, session, shipmentId, "quote.accepted", eventId, { quote_event_id });
    return c.json(event, 201);
  });

  // POST /v1/shipments/:id/claim — a portal party (or ops/admin) files a claim on a shipment it can see. The
  // claim rides an EXISTING kind at ZERO budget cost (doc 10 §37 — "claims live as event-chains + documents +
  // money_lines, no claims table"): a message.received on the 'portal' channel (the messages.channel CHECK
  // already includes 'portal'). It lands on the shipment timeline AND fans a Concierge/ops trigger
  // (conciergeTriggerFor enqueues a non-internal message.received), the cleanest home for a filed claim.
  // intent 'claim' steers the routing. No new claims table, no new event kind — the 35-catalog is unchanged.
  app.post("/v1/shipments/:id/claim", requireRole("admin", "ops", "portal"), async (c) => {
    const session = c.get("session");
    const shipmentId = c.req.param("id") ?? "";
    if (shipmentId.length > MAX_SHIPMENT_ID_LEN) throw new ApiError("VALIDATION_FAILED", 400, "SHIPMENT ID TOO LONG");
    const db = await resolveTenantDb(c.env, session.tenant);

    await requireShipmentVisible(session, db, shipmentId);

    const parsed = ClaimBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError("VALIDATION_FAILED", 400, "INVALID CLAIM BODY");
    const body = parsed.data;

    // Deterministic event id from the Idempotency-Key (the mutation middleware already required it): a retry
    // reproduces the SAME id → DO dedupe → no duplicate claim. Two DIFFERENT keys are two DIFFERENT claims (a
    // party may legitimately file more than one), which is correct.
    //
    // §1615 — THE PRINCIPAL IS IN THE SEED, and it was not. This route is `requireRole("admin","ops","portal")`,
    // so a party and an operator both reach it. §1613 folded `sub` into the HTTP idempotency scope, which stops
    // the second caller being SERVED the first's cached response — and that is exactly what exposed this: the
    // second request now RUNS, derives the same `portal-claim:<shipment>:<key>` id, and the sequencer dedupes it.
    // The caller receives the first party's event with a 201 while their own claim is never recorded.
    //
    // Fixing one layer moved the collision down a layer rather than removing it. Seeding with `sub` keeps the
    // stated property — a retry reproduces its own id, two keys are two claims — and adds the missing one: two
    // PARTIES are two claims.
    const idemKey = c.req.header("Idempotency-Key");
    const eventId =
      idemKey === undefined
        ? crypto.randomUUID()
        : await deterministicUuid(`portal-claim:${shipmentId}:${session.sub}:${idemKey}`);

    // The message.received payload (typed MessageReceivedPayload). channel 'portal' + intent 'claim'; from_ref is
    // SERVER-CONTROLLED (who filed it), never a client field. The claim text rides inline in `body` (bounded);
    // `body_ref` is a stable per-event marker (no R2 object is uploaded on this path — the ledger event IS the
    // durable record). subject/thread pass through only when provided.
    const payload: Record<string, unknown> = {
      channel: "portal",
      from_ref: session.party_id ?? session.sub,
      body_ref: `portal-claim:${eventId}`,
      body: body.description,
      intent: "claim",
    };
    if (body.subject !== undefined) payload.subject = body.subject;
    if (body.thread !== undefined) payload.thread = body.thread;

    const event = await appendThroughSequencer(c.env, session, shipmentId, "message.received", eventId, payload);
    return c.json(event, 201);
  });
}
