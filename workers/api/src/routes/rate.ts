import type { Hono } from "hono";
import { z } from "zod";
import { priceShipment, assessApproval } from "@shuddl/rater";
import type { RateRequest, Leg, PricedQuote, ApprovalDecision } from "@shuddl/rater";
import { ApiError } from "../middleware/error.js";
import { requireRole } from "../middleware/auth.js";
import { tenantDb } from "../tenants.js";
import { loadTenantRatingConfig } from "../rate-config.js";
import { translateAppendError, type SeqStub } from "./events.js";
import type { AppendedEvent } from "../do/sequencer.js";
import type { Env, Vars } from "../index.js";

// REQ-030 / REQ-025 / REQ-005 / I5 — POST /v1/rate: the SERVER-SIDE pricing gate. It prices via the PURE
// engine (@shuddl/rater, no LLM/I/O in the engine — REQ-024) against the session tenant's OWN rate_config
// (tenant from the JWT claim only, never a header/body — REQ-025) and turns the result into append-only
// ledger facts:
//   - No tariff → 200 UNKNOWN no_tariff, NO event (REQ-151 cold start).
//   - UNKNOWN physics/lane → 200 UNKNOWN <reason>, NO quote.priced (no price on air, end to end — REQ-004);
//     this is the server-side half of the Quote→Booked gate: a weightless/dimless quote returns UNKNOWN (REQ-041).
//   - PRICED → append quote.priced (pins rate_config versions, I5; and CARRIES the REQ-040 anomaly on its
//     basis so a price that shouldn't exist is recorded AT pricing, atomically, forever) + agent.acted
//     (rater cites the configs it priced against, ≥1 basis link — REQ-005); enforce the below-floor
//     approval gate HERE by appending approval.requested (REQ-030 — the engine only COMPUTES the decision;
//     the SERVER records it). The UI only REFLECTS the gate.
// The engine stays pure; the SERVICE may use Date.now() for the event `ts` (the purity rule binds
// packages/rater, not this worker).

const BODY_LIMIT_ZIP_MIN = 1;
// Match events.ts: cap the shipment id BEFORE it reaches the DO name (idFromName) so an oversized id is a
// clean 400, not a 500 from the DO-name length limit. The DO owns the FORMAT check; this bounds LENGTH only.
const MAX_SHIPMENT_ID_LEN = 200;

const Dims = z
  .object({
    l_in: z.number().int().nonnegative(),
    w_in: z.number().int().nonnegative(),
    h_in: z.number().int().nonnegative(),
    pieces: z.number().int().positive(),
  })
  .strict();

const LegSchema = z
  .object({
    kind: z.enum(["pickup", "linehaul", "interline", "cartage", "delivery", "dray"]),
    executor: z.string().min(1),
    split_bps: z.number().int().min(0).max(10_000),
  })
  .strict();

// Zod at the boundary (integer-only canonical law): weight is integer pounds; cents are integers. A malformed
// body is VALIDATION_FAILED (400) via the ApiError envelope. Absent weight/dims are LEGAL here — they flow to
// the engine which returns UNKNOWN (no price on air), they are NOT a 400.
const RateBody = z
  .object({
    shipment_id: z.string().min(1).max(MAX_SHIPMENT_ID_LEN),
    origin_zip: z.string().min(BODY_LIMIT_ZIP_MIN),
    dest_zip: z.string().min(BODY_LIMIT_ZIP_MIN),
    weight_lb: z.number().int().positive().optional(),
    dims: Dims.nullish(), // absent OR null ⇒ UNKNOWN missing_physics
    accessorials: z.array(z.string()).optional(),
    proposed_sell_cents: z.number().int().nonnegative().optional(),
    legs: z.array(LegSchema).optional(),
    tenant_party: z.string().min(1).optional(),
  })
  .strict()
  // Interline split integrity at the BOUNDARY (REQ-040 / mirrors money.ts SplitComputedPayload): when legs
  // are present, their split_bps must total exactly 10000. LegSchema only bounds each leg's range; the
  // sum-to-100% invariant otherwise lived deep inside executingShare, which runs at assessApproval AFTER
  // quote.priced + agent.acted are already appended — so a body whose splits sum to ≠10000 (a plausible
  // typo) committed two events and then 500'd, un-retryable, leaving a priced fact with no approval.requested.
  // Rejecting here means NOTHING is appended for a malformed split: a clean 400, no partial write.
  .refine(
    (b) => b.legs === undefined || b.legs.length === 0 || b.legs.reduce((sum, l) => sum + l.split_bps, 0) === 10_000,
    { message: "interline leg split_bps must sum to exactly 10000", path: ["legs"] },
  );
type RateBody = z.infer<typeof RateBody>;

const RATER_CONFIDENCE_BPS = 10_000; // a deterministic rule engine, not a probabilistic agent — full confidence.

// The approval-matrix options for assessApproval. INTERLINE (compare the executing share, not the gross —
// REQ-040 Law 5) requires BOTH a non-empty legs set AND tenant_party; a partial signal is rejected upstream
// (see the route) so this only ever passes both-or-neither and never trips assessApproval's fail-loud guard.
function approvalOpts(body: RateBody): { proposedSellCents?: number; legs?: readonly Leg[]; tenantParty?: string } {
  const opts: { proposedSellCents?: number; legs?: readonly Leg[]; tenantParty?: string } = {};
  if (body.proposed_sell_cents !== undefined) opts.proposedSellCents = body.proposed_sell_cents;
  if (body.legs !== undefined && body.legs.length > 0 && body.tenant_party !== undefined) {
    opts.legs = body.legs;
    opts.tenantParty = body.tenant_party;
  }
  return opts;
}

// Deterministic, STABLE event id derived from the request's Idempotency-Key. This route emits up to three
// events; a mid-sequence failure returns 5xx, which the HTTP idempotency cache does NOT store (it only
// caches <500), so the client's retry re-runs the WHOLE handler. Random ids would then DUPLICATE the events
// that already committed. Deriving each event's id from (idempotencyKey, shipment_id, kind) makes a retry
// reproduce the SAME id per event, and the sequencer dedupes by id (SELECT ... WHERE id = ? → returns the
// existing row, never a second append) — so the sequence is resumable: already-committed events return
// their existing rows, the missing ones complete, nothing duplicates. Shaped into a v4-variant UUID so it
// satisfies EventInput.id (z.string().uuid()).
async function deterministicEventId(idempotencyKey: string, shipmentId: string, kind: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${idempotencyKey}:${shipmentId}:${kind}`));
  const h = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  const variant = ((parseInt(h.slice(16, 17) || "0", 16) & 0x3) | 0x8).toString(16); // 8/9/a/b
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function mountRateRoutes(app: Hono<{ Bindings: Env; Variables: Vars }>): void {
  app.post("/v1/rate", requireRole("ops", "admin", "finance"), async (c) => {
    const session = c.get("session");
    const parsed = RateBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError("VALIDATION_FAILED", 400, "INVALID RATE REQUEST");
    const body = parsed.data;

    // REQ-040 — interline legs without the tenant's executing party would force a GROSS comparison, the one
    // thing the executing-share law forbids. Reject it rather than silently compare the whole move.
    if (body.legs !== undefined && body.legs.length > 0 && body.tenant_party === undefined) {
      throw new ApiError("VALIDATION_FAILED", 400, "INTERLINE LEGS REQUIRE tenant_party (REQ-040)");
    }

    // One clock for the whole request: the config's effective-now bound AND the events' actor-claimed ts.
    const now = Date.now();

    // REQ-025 — the config comes from the SESSION tenant's D1 only (tenantDb allowlist, keyed off the JWT
    // claim), and only the tariff IN EFFECT as of `now` (a future-dated row must not price today). No tariff
    // ⇒ UNKNOWN no_tariff, and NO event (REQ-151: no tariff = no sell).
    const config = await loadTenantRatingConfig(tenantDb(c.env, session.tenant), now);
    if (config === null) return c.json({ status: "UNKNOWN", reason: "no_tariff" as const });

    const request: RateRequest = {
      origin_zip: body.origin_zip,
      dest_zip: body.dest_zip,
      // exactOptionalPropertyTypes: attach optional physics only when present (null dims are kept — the
      // engine reads them as missing_physics; undefined must never become an explicit key).
      ...(body.weight_lb !== undefined ? { weight_lb: body.weight_lb } : {}),
      ...(body.dims !== undefined ? { dims: body.dims } : {}),
      ...(body.accessorials !== undefined ? { accessorials: body.accessorials } : {}),
    };

    const quote = priceShipment(request, config);
    // No price on air (REQ-004), end to end: an UNKNOWN emits NO quote.priced.
    if (quote.status === "UNKNOWN") return c.json({ status: "UNKNOWN", reason: quote.reason });

    // ---- PRICED: turn the quote into append-only ledger facts on the shipment stream ----
    const streamId = `s:${body.shipment_id}`;
    const stub = c.env.SHIPMENT_SEQ.get(
      c.env.SHIPMENT_SEQ.idFromName(`${session.tenant}|${streamId}`),
    ) as unknown as SeqStub;

    // The audit actor of these server-emitted events is SERVER-CONTROLLED — never derived from the request
    // body. `tenant_party` is ONLY the interline executing-party input for the approval matrix (below); it
    // must not become the event's actor.party (a client could otherwise label who "acted"). Use the session
    // party lens if one is present, else an "agent:rater" sentinel. Safe as a sentinel because none of the
    // events this route emits (quote.priced / agent.acted / approval.requested) accrue a projection with a
    // parties FK — no event's durability depends on the actor party.
    const actorParty = session.party_id ?? "agent:rater";

    // The Idempotency-Key the mutation middleware already required (present on every POST that reaches here).
    // Kept optional for decoupling: WITHOUT a key, retries are NOT idempotent (random ids) — see deterministicEventId.
    const idemKey = c.req.header("Idempotency-Key");
    const eventId = (kind: string): Promise<string> =>
      idemKey === undefined ? Promise.resolve(crypto.randomUUID()) : deterministicEventId(idemKey, body.shipment_id, kind);

    const append = async (kind: string, payload: Record<string, unknown>): Promise<AppendedEvent> => {
      try {
        return await stub.append({
          tenant: session.tenant, // claim only — the DO re-derives its id from it and rejects a mismatch
          streamId,
          input: {
            id: await eventId(kind),
            shipment_id: body.shipment_id,
            ts: now,
            actor: { party: actorParty },
            party_refs: [],
            evidence: [],
            source: "native",
            confidence: RATER_CONFIDENCE_BPS,
            kind,
            payload,
          },
        });
      } catch (e) {
        throw translateAppendError(e);
      }
    };

    // 1) quote.priced — I5: pins EVERY rate_config version this price was computed against. REQ-040: the
    // anomaly (a price that shouldn't exist — $222,084 / 35 lb) rides the SAME event on `basis.anomaly`, so
    // it is recorded AT pricing, atomically, forever — no separate event and no dependency on a `parties`
    // FK. A pricing anomaly is not a physical-custody exception: surfacing it as an exceptions-QUEUE alarm
    // is the Watchtower's job (REQ-036, WP-11), which reads anomalies from the ledger; it is intentionally
    // NOT a /rate responsibility (that coupling is what would 500 a direct-move anomaly on the passports FK).
    const priced = await append("quote.priced", {
      sell: quote.sell_cents,
      floors: quote.floors,
      versions: quote.versions,
      basis: { ...quote.basis, anomaly: quote.anomaly },
    });

    // 2) agent.acted — REQ-005: the rater cites its basis links: the quote.priced event it produced (explicit
    // provenance) PLUS every rate_config version it priced against (rate_config_ids is non-empty, so ≥1 link
    // regardless). `priced.id` is the STABLE quote.priced id (the deterministic id even after a dedup replay).
    await append("agent.acted", {
      agent: "rater",
      action: "priced",
      basis: [
        { kind: "event", id: priced.id },
        ...quote.versions.rate_config_ids.map((id) => ({ kind: "config", id })),
      ],
      confidence_bps: RATER_CONFIDENCE_BPS,
    });

    // 3) below-floor approval gate — REQ-030 enforced HERE (the engine only DECIDED it). A dual approval is
    // recorded as ONE approval.requested carrying approvals_required: 2 (kept simple; the decision object in
    // the response conveys the full detail the UI reflects). This is EVENT-SOURCED (approval.requested
    // satisfies REQ-048/REQ-030); writing the `approvals` TABLE row is a read-model projection owned by
    // WP-10's approvals-queue view — deliberately NOT built here.
    const decision = assessApproval(quote, approvalOpts(body));
    if (decision.approval !== "none") {
      await append("approval.requested", {
        rule: decision.rule,
        required_role: decision.required_role,
        approvals_required: decision.approvals_required,
        evaluated_sell_cents: decision.evaluated_sell_cents,
        gross_sell_cents: decision.gross_sell_cents,
        executing_share_bps: decision.executing_share_bps,
      });
    }

    // (The REQ-040 anomaly is recorded on quote.priced.basis above — see the note there. No exception.raised
    // is emitted from /rate; the client still sees `anomaly` in the response below.)
    return c.json(pricedResponse(quote, decision));
  });
}

// The PRICED response the client sees — the price plus the SERVER's gate result. The UI only reflects it.
function pricedResponse(quote: PricedQuote, decision: ApprovalDecision) {
  return {
    status: "PRICED" as const,
    sell_cents: quote.sell_cents,
    floors: quote.floors,
    versions: quote.versions,
    lines: quote.lines,
    approval: decision,
    anomaly: quote.anomaly,
  };
}
