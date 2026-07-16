import { QuotePricedPayload } from "@shuddl/contracts";
import type { QuotePricedPayload as QuotePricedPayloadT } from "@shuddl/contracts";
import { priceShipment, assessApproval } from "@shuddl/rater";
import type { PricedQuote, TenantRatingConfig, RateRequest } from "@shuddl/rater";
import { DeterministicParser } from "./parse.js";
import type { ParseResult, InboundEmail } from "./parse.js";
import { renderQuoteReply } from "./quote-reply.js";

// THE CONCIERGE DECIDE STEP (REQ-026/093/098) — the PURE composition after parse (Task 3) → resolve
// (Task 4). It PRICES the parsed request through the Rater, DRAFTS the tenant-voice reply, and DECIDES
// whether to AUTO-REPLY (send a priced quote this second) or QUEUE for a human. The Task-6 consumer takes
// this decision, appends the events, and sends — compose itself appends nothing and sends nothing.
//
// TWO HARD AUTO-SEND GATES (REQ-026/093), both independent of the model's word:
//   (a) FLOOR-CLEAN — mirrors the Biller's PERMANENT HOLD (composeInvoice holds on a recorded pricing-time
//       anomaly OR a below-floor figure, REQ-040/048). A concierge quote is a DIRECT move, so assessApproval
//       compares the sell itself against the floors; AND the REQ-040 anomaly net ($222,084/35-lb — floor-CLEAN
//       yet absurd, and the reachable not-clean case for a direct move) is the permanent guard. Either a
//       below-floor sell OR a non-null anomaly ⇒ NEVER auto-send.
//   (b) INDEPENDENT CORROBORATION (the Task-3 "C1" defense, sharpened per REQ-171) — the auto-send confidence is
//       NOT the model's self-reported `parse.confidence` (it is prompt-injectable: the email is untrusted). Instead
//       we RE-PARSE the SAME raw email with the DeterministicParser and require agreement on EVERY price-affecting
//       field, FAILING CLOSED on anything we cannot independently confirm: both zips match; weight fails closed (a
//       priced weight the deterministic parser can't confirm cannot auto-send); accessorials must be an equal set.
//       A model request that diverges from the deterministic re-extraction (an injected lane, an unconfirmed/low
//       weight, a dropped or added accessorial) can never auto-send. `parse.confidence` NEVER gates the send.
//   plus RESOLUTION CONFIDENCE >= 9000 (REQ-093) — redundant with Task-4's gate, re-checked here so compose
//   does not assume the caller enforced it (belt-and-suspenders).
//
// PURITY: no Date, no random, no direct D1, no fetch. priceShipment / assessApproval / renderQuoteReply /
// the DeterministicParser are all pure; QuotePricedPayload.parse is pure. Given the same input the decision is
// byte-identical. The money NEVER comes from the model — the PRICE is the Rater's over the CORROBORATED
// request, and the reply shows the Rater's `sell_cents`.

/** The floor at which the resolution tie is trusted (REQ-093 "<0.9 queues"): 9000 bps, inclusive. */
const MIN_RESOLUTION_BPS = 9_000;

export interface ComposeInput {
  /** The model (or deterministic) parse of the inbound. Its `confidence` is NEVER an auto-send gate (C1). */
  parse: ParseResult;
  /** The RAW inbound email — re-parsed deterministically here for the C1 corroboration. */
  email: InboundEmail;
  /** The Task-4 resolution: the tied ids + the structural confidence (re-gated here). */
  resolved: { party_id: string; shipment_id: string; resolution_confidence: number };
  /** The tenant's rate_config bundle priceShipment prices against (loaded by the consumer, one tenant). */
  ratingConfig: TenantRatingConfig;
  /** REQ-098 tenant voice — the config-seeded from-name that signs the reply. */
  tenantFromName: string;
  /**
   * REQ-059 the HONEST transit window in whole BUSINESS DAYS — RESOLVED BY THE CONSUMER (loadTransitMatrix +
   * resolveTransitDays over the SAME zone tariff pricing used), passed ONLY on a KNOWN lane. Present ⇒ the
   * reply/draft shows an "Estimated transit: N business days" line; ABSENT (an unresolvable lane, or a tenant
   * with no transit_matrix) ⇒ the line is OMITTED — compose NEVER fabricates a number. compose stays pure: it
   * does not load the matrix (that is I/O the consumer owns), it only threads the resolved days into the render.
   */
  transitDays?: number;
}

// The reply/draft render — one shape, whether it is SENT (auto_reply.reply) or held for review (queued.draft).
type QuoteReply = { subject: string; html: string };

export type ConciergeDecision =
  | {
      status: "auto_reply";
      quote: PricedQuote;
      reply: QuoteReply;
      // The payload the consumer appends as quote.priced (compose does NOT append) — mirrors routes/rate.ts.
      quote_priced: QuotePricedPayloadT;
    }
  | {
      status: "queued";
      reason: "below_floor" | "not_corroborated" | "unknown_price" | "low_resolution";
      quote?: PricedQuote;
      draft?: QuoteReply;
    };

/**
 * Build the quote.priced payload the consumer will append — the SAME mapping routes/rate.ts uses: the sell,
 * the itemized lines (penny-parity), the floors, the pinned config versions, and the basis carrying the REQ-040
 * anomaly. Parsed through the contract so a broken mapping fails loud here (pure) rather than at the DO append.
 */
function toQuotePriced(quote: PricedQuote): QuotePricedPayloadT {
  return QuotePricedPayload.parse({
    sell: quote.sell_cents,
    lines: quote.lines.map((l) => ({ kind: l.kind, code: l.code, amount_cents: l.amount_cents })),
    floors: quote.floors,
    versions: { rate_config_ids: [...quote.versions.rate_config_ids] },
    basis: { ...quote.basis, anomaly: quote.anomaly },
  });
}

/**
 * FLOOR-CLEAN — mirror the Biller's PERMANENT HOLD: a below-floor figure OR a non-null pricing-time anomaly
 * is NOT auto-sendable (REQ-040/048). `assessApproval(quote).approval === "none"` means at/above target.
 * NOTE: for a direct concierge quote today `approval` is ALWAYS "none" (cost = freight, so sell ≥ cost ≥ target
 * since target_or_bps ≤ 10000) — so the approval term is a DEFENSIVE guard, retained on purpose so that a future
 * cost surface where cost > freight (making a genuine below-target sell reachable) still queues as below_floor;
 * do NOT drop it as "redundant." The anomaly (REQ-040, e.g. the floor-CLEAN-yet-absurd $222,084/35-lb case) is
 * the reachable not-clean case today, ANDed in — either condition ⇒ never auto-send.
 */
function isFloorClean(quote: PricedQuote): boolean {
  return assessApproval(quote).approval === "none" && quote.anomaly === null;
}

/** Order-independent set equality over two string lists (accessorials are a set). */
function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

/**
 * C1 INDEPENDENT CORROBORATION — re-parse the RAW email deterministically and require the model's request to
 * agree on EVERY PRICE-AFFECTING FIELD, FAILING CLOSED on anything the deterministic parser cannot independently
 * confirm (REQ-171/175). The sell is a function of {lane, weight, accessorials}; dims are PRICE-INERT under
 * today's cwt engine (so a dims divergence does not mis-price the sell), and WP-09 keeps them price-inert — it
 * ships NO density/class rating. Even so, the doctrine "a model request diverging from the deterministic
 * re-extraction can never auto-send" must cover dims too — so dims FAIL CLOSED on PRESENCE (value-matching joins
 * the rule only when a FUTURE density/class WP makes dims price-affecting):
 *   · both zips must MATCH;
 *   · weight FAILS CLOSED — if the model priced on a weight, the deterministic parser MUST also have extracted a
 *     weight and it must MATCH; a model weight the deterministic parser could not confirm (a format WEIGHT_RE
 *     misses, or an injected value) cannot auto-send (weight scales freight — the highest-leverage under-quote field);
 *   · accessorials must be an EQUAL SET — a dropped accessorial under-quotes, an added one over-quotes; either breaks it;
 *   · dims FAIL CLOSED on PRESENCE — if the model priced WITH dims, the deterministic parser MUST also carry dims
 *     (a format DIMS_RE misses, e.g. "48 by 40 by 60", or an injected block cannot auto-send); values are NOT
 *     compared while dims stay price-inert (through WP-09) — only presence.
 * Anything else → NOT corroborated → queue for a human. Deterministic + network-free (a pure re-derivation of the bytes).
 */
async function corroborates(email: InboundEmail, modelRequest: RateRequest): Promise<boolean> {
  const det = await new DeterministicParser().parse(email);
  const detReq = det.request;
  if (detReq === undefined) return false; // no independent request to confirm against
  if (detReq.origin_zip !== modelRequest.origin_zip || detReq.dest_zip !== modelRequest.dest_zip) return false;
  // Weight: fail closed. A priced (weight-bearing) model request must be independently confirmed.
  if (modelRequest.weight_lb !== undefined) {
    if (detReq.weight_lb === undefined || detReq.weight_lb !== modelRequest.weight_lb) return false;
  }
  // Accessorials: set equality — an added OR dropped accessorial changes the sell.
  if (!sameStringSet(modelRequest.accessorials ?? [], detReq.accessorials ?? [])) return false;
  // Dims: fail closed on PRESENCE (REQ-175). A model that priced WITH dims the deterministic re-parse cannot
  // see must not auto-send — even though dims are price-inert today AND WP-09 keeps them price-inert (no
  // density/class rating this WP), the divergence-can't-send doctrine holds. Do NOT weaken to "always true."
  if (modelRequest.dims !== undefined && detReq.dims === undefined) return false;
  return true;
}

/**
 * composeConcierge — PRICE → DRAFT → DECIDE. Returns auto_reply (all gates pass) or queued(<reason>).
 * ASYNC because the C1 corroboration re-runs the DeterministicParser (whose parse() is async by design so
 * every failure surfaces as a rejection) — the decision remains pure and deterministic.
 */
export async function composeConcierge(input: ComposeInput): Promise<ConciergeDecision> {
  const { parse, email, resolved, ratingConfig, tenantFromName, transitDays } = input;

  // 1. PRICE. No price on air (REQ-004): an absent request or an UNKNOWN result queues — a human handles it.
  const request = parse.request;
  if (request === undefined) return { status: "queued", reason: "unknown_price" };
  const priced = priceShipment(request, ratingConfig);
  if (priced.status === "UNKNOWN") return { status: "queued", reason: "unknown_price" };
  const quote: PricedQuote = priced;

  // Draft the tenant-voice reply once (pure). It is the SENT body on auto_reply, or the human-review DRAFT on
  // a queue. valid_until is omitted here — compose is Date-free; the consumer may stamp one before sending.
  const reply = renderQuoteReply({
    shipment_ref: resolved.shipment_id,
    lane: { origin_zip: request.origin_zip, dest_zip: request.dest_zip },
    sell_cents: quote.sell_cents,
    tenant_from_name: tenantFromName,
    // REQ-059 — thread the resolved window only when KNOWN; ABSENT ⇒ renderQuoteReply omits the line (never fakes it).
    ...(transitDays !== undefined ? { transit_days: transitDays } : {}),
  });

  // 2. FLOOR-CLEAN — a below-floor OR anomalous quote is NEVER auto_reply (permanent, REQ-040). Queue it with
  //    the quote + a draft so a human can review/send.
  if (!isFloorClean(quote)) {
    return { status: "queued", reason: "below_floor", quote, draft: reply };
  }

  // 3. C1 CORROBORATION — the model request must survive an independent deterministic re-extraction.
  if (!(await corroborates(email, request))) {
    return { status: "queued", reason: "not_corroborated", quote, draft: reply };
  }

  // 4. RESOLUTION CONFIDENCE — re-gate REQ-093's floor here; do not assume Task 4 enforced it.
  if (resolved.resolution_confidence < MIN_RESOLUTION_BPS) {
    return { status: "queued", reason: "low_resolution", quote, draft: reply };
  }

  // 5. ALL GATES PASS ⇒ AUTO-REPLY. The consumer appends quote_priced + sends `reply`.
  return { status: "auto_reply", quote, reply, quote_priced: toQuotePriced(quote) };
}
