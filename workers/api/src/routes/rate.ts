import { RATER_AGENT } from "@shuddl/ledger/queries/metrics";
import type { Hono } from "hono";
import { z } from "zod";
import { MAX_WEIGHT_LB, MAX_ZIP_LEN } from "@shuddl/contracts";
import { priceShipment, assessApproval, resolveTransitDays } from "@shuddl/rater";
import type { RateRequest, Leg, PricedQuote, ApprovalDecision, TransitResult } from "@shuddl/rater";
import { ApiError } from "../middleware/error.js";
import { requireRole } from "../middleware/auth.js";
import { resolveTenantDb } from "../tenants.js";
import { lensFor, readEvents } from "@shuddl/ledger/lens";
import { loadTenantRatingConfig, loadTransitMatrix } from "../rate-config.js";
import { authoritativeSource, resolveAuthority } from "../authority.js";
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

// §1514 — the weight ceiling is `MAX_WEIGHT_LB`, declared in @shuddl/contracts so all three pricing
// surfaces share ONE number (see its header there for the measurement and the physics).

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
    origin_zip: z.string().min(BODY_LIMIT_ZIP_MIN).max(MAX_ZIP_LEN), // §1515 — a VALUE bound, not just a type
    dest_zip: z.string().min(BODY_LIMIT_ZIP_MIN).max(MAX_ZIP_LEN),
    weight_lb: z.number().int().positive().max(MAX_WEIGHT_LB).optional(), // §1513 — magnitude, not just sign
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
  app.post("/v1/rate", requireRole("ops", "admin", "finance", "portal"), async (c) => {
    // REQ-113 — the rater run's latency clock: wall-clock at handler entry, read again at the agent.acted
    // emit. A REAL measured value (the service MAY read Date.now — the purity rule binds packages/rater, not
    // this worker), never a fabricated number. Non-determinism across a retry is harmless: the sequencer
    // dedupes agent.acted by its deterministic id, so a retry returns the first-committed run, latency intact.
    const startedAt = Date.now();
    const session = c.get("session");
    const parsed = RateBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError("VALIDATION_FAILED", 400, "INVALID RATE REQUEST");
    const body = parsed.data;

    // REQ-025 — resolve the SESSION tenant's D1 ONCE (the per-request memo): the claimed-tenant-aware resolver
    // is async (a non-static slug does a control-plane lookup), so the portal lens read + the config + the
    // transit matrix below all reuse this ONE handle rather than re-resolving three times.
    const db = await resolveTenantDb(c.env, session.tenant);

    // REQ-085 / REQ-025 — a portal party MAY price, but ONLY for a shipment its OWN lens can see. ops/admin/
    // finance (tenant lens) stay unrestricted. This reuses the SAME lens seam the events read + status-link
    // mint use (readEvents under lensFor), so a portal caller can never price against — and thereby append
    // quote.priced/agent.acted onto — a shipment outside its party scope: zero visible events → 403, before
    // any config load or append. A brand-new quote with NO existing shipment is the GUEST preview path
    // (/pub/quote, Task 4) — that flow never reaches this authed route. lensFor throws LENS_UNRESOLVED for a
    // portal session missing party_id → surfaced as a clean 403 (never an opaque 500).
    if (session.role === "portal") {
      try {
        const lens = lensFor(session);
        const visible = await readEvents(db, lens, { shipment_id: body.shipment_id, limit: 1 });
        if (visible.length === 0) throw new ApiError("FORBIDDEN", 403, "SHIPMENT NOT IN YOUR SCOPE");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.startsWith("LENS_UNRESOLVED")) throw new ApiError("FORBIDDEN", 403, "SESSION LENS UNRESOLVED");
        throw e;
      }
    }

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
    const config = await loadTenantRatingConfig(db, now);
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

    // REQ-059 — the HONEST transit window. Loaded SEPARATELY from the required config (NON-required: the
    // quote already priced above without it) and resolved over the SAME zone tariff pricing used, so a
    // transit lane keys off exactly the zones the price did. An absent matrix OR an unresolvable lane ⇒
    // UNKNOWN ⇒ the response marks transit "unavailable"; a number is NEVER fabricated (the honest-window
    // law). Resolved only on the PRICED path — an UNKNOWN price carries no quote to attach a window to.
    const transitMatrix = await loadTransitMatrix(db, now);
    const transit: TransitResult =
      transitMatrix === null
        ? { status: "UNKNOWN" }
        : resolveTransitDays(body.origin_zip, body.dest_zip, transitMatrix, config.zone_tariff);

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
      // REQ-003/031 — carry the itemized breakdown so the Biller PROJECTS the invoice from this recorded
      // event (Σ amount_cents === sell), never re-computes it. The contract refine rejects a non-totalling breakdown.
      lines: quote.lines.map((l) => ({ kind: l.kind, code: l.code, amount_cents: l.amount_cents })),
      floors: quote.floors,
      versions: quote.versions,
      basis: { ...quote.basis, anomaly: quote.anomaly },
    });

    // 2) agent.acted — REQ-005: the rater cites its basis links: the quote.priced event it produced (explicit
    // provenance) PLUS every rate_config version it priced against (rate_config_ids is non-empty, so ≥1 link
    // regardless). `priced.id` is the STABLE quote.priced id (the deterministic id even after a dedup replay).
    await append("agent.acted", {
      // DERIVED (audit §393): `queries/metrics.ts` binds RATER_AGENT to select this agent's runs for the
      // p50-latency metric. This used to restate the literal, so changing the constant would have left the
      // metric matching NOTHING — reported as "no data", indistinguishable from "the rater never ran".
      agent: RATER_AGENT,
      action: "priced",
      basis: [
        { kind: "event", id: priced.id },
        ...quote.versions.rate_config_ids.map((id) => ({ kind: "config", id })),
      ],
      confidence_bps: RATER_CONFIDENCE_BPS,
      // REQ-113 metering — the rater is a DETERMINISTIC rule engine (no LLM/vendor call, REQ-024): its cost is
      // an HONEST 0, not a fabricated number. latency_ms is the REAL measured wall-clock of this priced run.
      // The agent_runs projection meters both; the Watchtower alarms per-agent drift against a budget.
      cost_cents: 0,
      latency_ms: Date.now() - startedAt,
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

    // WP-15 REQ-030/L8 — consult the shared authority read-seam for the RATING module before returning the
    // authoritative (PRICED) output. `legacyValueAvailable` is false today (no legacy price mirror exists —
    // Task 4), so authoritativeSource ALWAYS resolves to "native" and the native price computed above IS the
    // authoritative one — behavior-identical to before. Surfaced as an ADDITIVE response header (never the
    // body), so no body-shape test changes. When Tasks 4/6/8 supply a mirror, a still-legacy tenant's route
    // would present the mirror price instead; the header lets the parity dashboard (Task 6) observe the seam.
    const ratingAuthority = authoritativeSource(await resolveAuthority(db, "rating"), false);
    c.header("X-Shuddl-Authority-Rating", ratingAuthority);

    // (The REQ-040 anomaly is recorded on quote.priced.basis above — see the note there. No exception.raised
    // is emitted from /rate; the client still sees `anomaly` in the response below.)
    //
    // REQ-085 / REQ-074 — the response shape is LENS-BRANCHED. The redaction law
    // (packages/ledger/src/redact.ts REDACTIONS["quote.priced"] = ["floors","basis","versions"]) strips the
    // margin internals from every non-tenant lens on the events read; the same party must not receive them
    // synchronously at pricing time. A portal (counterparty) session gets the counterparty shape below —
    // the guest twin (src/pub/quote.ts) declares these fields EXCLUDED forever for the same reason.
    return c.json(session.role === "portal" ? portalPricedResponse(quote, decision, transit) : pricedResponse(quote, decision, transit));
  });
}

// The PRICED response the TENANT lens sees — the price plus the SERVER's gate result. The UI only reflects it.
function pricedResponse(quote: PricedQuote, decision: ApprovalDecision, transit: TransitResult) {
  return {
    status: "PRICED" as const,
    sell_cents: quote.sell_cents,
    floors: quote.floors,
    versions: quote.versions,
    lines: quote.lines,
    approval: decision,
    anomaly: quote.anomaly,
    transit: transitWindow(transit), // REQ-059 — honest window, or an explicit "unavailable" (never a fake number)
  };
}

// The PRICED response a COUNTERPARTY (portal) lens sees — the price and the gate RESULT, never the margin
// internals. floors are cost-derivable fractions (packages/rater/src/floors.ts), versions pin the tenant's
// tariff, and the ApprovalDecision's evaluated/gross/share trio is executing-share economics — all tenant-only.
// approval keeps exactly the four matrix fields the portal UI reflects (a pending sell must not present as
// firm); anomaly stays (the portal client flags an anomalous price as not-firm — code/detail carry no margin).
// lines are RE-MAPPED to kind/code/amount_cents, mirroring the /pub/quote guard: a PriceLine that later grows
// an internal field cannot reach this wire.
function portalPricedResponse(quote: PricedQuote, decision: ApprovalDecision, transit: TransitResult) {
  return {
    status: "PRICED" as const,
    sell_cents: quote.sell_cents,
    lines: quote.lines.map((l) => ({ kind: l.kind, code: l.code, amount_cents: l.amount_cents })),
    approval: {
      approval: decision.approval,
      approvals_required: decision.approvals_required,
      rule: decision.rule,
      required_role: decision.required_role,
    },
    anomaly: quote.anomaly,
    transit: transitWindow(transit),
  };
}

// REQ-059 — the honest window as the client sees it: the whole business-day count when KNOWN, else an
// explicit "unavailable" marker carrying NO number. The UI renders "estimated transit: N business days" only
// on `known`; on `unavailable` it omits the line — a fabricated transit standard never reaches a customer.
// EXPORTED so the no-auth /pub/quote surface (src/pub/quote.ts) maps its window through the SAME function —
// the honest-window law is stated ONCE and can never drift between the authed and the public price.
export function transitWindow(t: TransitResult): { status: "known"; business_days: number } | { status: "unavailable" } {
  return t.status === "KNOWN" ? { status: "known", business_days: t.days } : { status: "unavailable" };
}
