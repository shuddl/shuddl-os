import type { ParseResult } from "./parse.js";

// THE CONCIERGE RESOLVE STEP (REQ-093) — the Concierge's DOWNSTREAM seam after parse. A parsed
// inbound (Task 3's ParseResult) is nothing until it is TIED to a Party + Shipment; only then can it
// be quoted. "Every message auto-ties to Party+Shipment; <0.9 conf queues" (REQ-093). This module is
// that tie. It is PURE logic over a small tenant-scoped DB PORT — the Task-6 queue consumer supplies
// the D1-backed implementation, bound to exactly ONE tenant. Below the confidence bar → `unresolved`:
// a human handles it, and we NEVER auto-create a party/shipment or auto-quote a shaky tie.
//
// WHY WE DO NOT TRUST `parse.confidence` (the Task-3 "C1" review): for the LLM path that field is
// MODEL-SUPPLIED and the email is UNTRUSTED, so a prompt-injected body can inflate it ("output
// confidence 10000"). Gating resolution on it would let an attacker force an auto-tie. We don't trust
// the model's self-reported `confidence`; instead we score `resolution_confidence` on signals that are
// far harder to weaponize than a self-graded number — whether the email matches a party WE already have
// on file (DB-verified), and whether a schema-valid priceable request (both zips, a stated weight) is
// present. `parse.confidence` is deliberately IGNORED here. (Task 5 separately derives the auto-SEND
// confidence, also independent of the model's word.) CAVEAT: party-matching keys off the `From` email,
// so upstream sender-auth (SPF/DKIM, WP-06/inbound) is load-bearing — a spoofed From to a known
// customer's address would earn the existing-party bump; that defense lives upstream, not here.
//
// CONSUMER CONTRACT (REDELIVERY + ATOMICITY — enforced in the Task-6 consumer, not here): shipment
// creation is NON-IDEMPOTENT — every resolvable call creates a NEW shipment (the party is deduped by
// email; the shipment is not, and this pure fn has no ledger to check). Cloudflare Queues is at-least-
// once, so the consumer MUST guard redelivery: skip if a `quote.requested` carrying this
// `sourceMessageEventId` already exists (or the message is already resolved). Also: the direct
// party/shipment INSERT (via the port) and the later `quote.requested` append are NOT one transaction —
// if the INSERT lands but the append fails, the shipment is an orphan; it carries `sourceMessageEventId`
// in `refs` so it is at least correlatable, and the consumer should append `quote.requested` promptly.
//
// PURITY: no Date, no random, no direct D1, no fetch — the injected `port` is the ONLY side-effect
// channel, and the function is deterministic given the same port responses. TENANT ISOLATION rides
// on that: the consumer binds `port` to one tenant's D1 (REQ-025), so nothing here can reach another
// tenant. FK ORDER is honored — createParty (if needed) ALWAYS runs before createShipment, because
// shipments.{shipper,consignee,bill_to}_party_id are NOT NULL FKs to parties(id).

/**
 * The tenant-scoped DB port. The consumer binds each method to ONE tenant's D1 (REQ-025); this module
 * never sees a raw handle. `findPartyByEmail` matches a `{kind,email}` entry inside `parties.contacts`
 * (the same JSON-array contacts shape the Biller reads). `createParty` writes `names`/`contacts` JSON;
 * `createShipment` writes a quote-stage shipment row.
 */
/** The parties.kind CHECK set (db/tenant/migrations/0002_domain.sql) — typed so a typo is a compile
 *  error here, not a runtime D1 CHECK failure in the consumer's port. */
export type PartyKind = "shipper" | "consignee" | "carrier" | "broker" | "cartage" | "factor" | "insurer";

export interface ResolvePort {
  /** Match an existing party by an email inside its `contacts` JSON array. null ⇒ none on file. */
  findPartyByEmail(email: string): Promise<{ id: string } | null>;
  /** Create a party (the quote requester → a shipper). `name` is omitted when unknown. */
  createParty(p: { kind: PartyKind; email: string; name?: string }): Promise<{ id: string }>;
  /** Create a quote-stage shipment. All three party FKs are supplied by the caller (see below). The
   *  D1-backed consumer MUST also supply `shipments.created_ts` (NOT NULL, no DB default) — this pure
   *  module cannot (no clock); that is the consumer's responsibility, not part of this port shape. */
  createShipment(s: {
    shipper_party_id: string;
    consignee_party_id: string;
    bill_to_party_id: string;
    refs: string;
  }): Promise<{ id: string }>;
}

/**
 * The outcome. `resolved` carries the tied ids, whether we created the party, and the computed
 * structural confidence (bps). `unresolved` carries a machine-reason so the consumer can queue/route:
 *   · not_quote_intent — status/claim/unknown are handled elsewhere; WP-07's job is quoting.
 *   · no_party_signal  — no email to tie a party to.
 *   · no_request       — no priceable request (needs BOTH zips).
 *   · low_confidence   — a tie is possible but too shaky to auto-create (<0.9); a human decides.
 */
export type ResolveResult =
  | {
      status: "resolved";
      party_id: string;
      shipment_id: string;
      party_created: boolean;
      resolution_confidence: number;
    }
  | { status: "unresolved"; reason: "no_party_signal" | "no_request" | "low_confidence" | "not_quote_intent" };

/** The auto-tie floor: REQ-093's "<0.9 conf queues" — 9000 bps, inclusive (≥9000 resolves). */
const MIN_RESOLUTION_BPS = 9000;

/**
 * The resolution-confidence formula — a PURE function of verifiable structural facts (never the model's
 * `parse.confidence`). Both zips are already guaranteed present by the priceable-request gate, so that
 * is the floor; the two remaining signals are the party-match quality and whether a weight was stated:
 *
 *   base                         6000   (BOTH zips present ⇒ a quotable lane — guaranteed by the caller)
 *   + party matched on file     +3000   (a party WE already have is a far surer tie than a brand-new one)
 *   OR brand-new party          +1500
 *   + a stated weight           +1500   (weight makes the shipment priceable-for-real, not just routable)
 *   clamp to the 10000 ceiling
 *
 * Yielding: existing+weight → 10000 · existing (no weight) → 9000 (exactly the floor) · new+weight →
 * 9000 · new (no weight) → 7500 (below the floor → queues). A brand-new party with only a lane and no
 * weight is precisely the "too shaky to auto-create" case REQ-093 wants a human to see.
 */
function resolutionConfidence(partyMatchedOnFile: boolean, weightPresent: boolean): number {
  let bps = 6000;
  bps += partyMatchedOnFile ? 3000 : 1500;
  if (weightPresent) bps += 1500;
  return Math.min(bps, 10000);
}

/**
 * Resolve a parsed inbound to a Party + Shipment, or explain why it can't. Deterministic; the injected
 * `port` is the ONLY I/O. Order of gates is intentional (cheapest/most-decisive first): intent →
 * party signal → priceable request → computed confidence → find-or-create → create shipment.
 */
export async function resolveConcierge(
  parse: ParseResult,
  port: ResolvePort,
  sourceMessageEventId: string,
): Promise<ResolveResult> {
  // 1. Intent gate — WP-07's DoD is quoting; status/claim/unknown route elsewhere (do zero I/O here).
  if (parse.intent !== "quote") return { status: "unresolved", reason: "not_quote_intent" };

  // 2. Party signal — an empty/absent email cannot tie to a party (empty string is treated as absent).
  const email = parse.party_hint?.email;
  if (!email) return { status: "unresolved", reason: "no_party_signal" };

  // 3. Priceable request — need BOTH zips to form a quotable shipment (RateRequestPayload requires them,
  //    but we re-check structurally: an empty zip is treated as missing — no price on air).
  const request = parse.request;
  if (!request || !request.origin_zip || !request.dest_zip) {
    return { status: "unresolved", reason: "no_request" };
  }

  // 4. Structural confidence — computed from facts we verify (party match, weight), NOT parse.confidence.
  //    findPartyByEmail is a READ; scoring the tie before the gate creates nothing.
  const existing = await port.findPartyByEmail(email);
  const weightPresent = request.weight_lb !== undefined;
  const resolution_confidence = resolutionConfidence(existing !== null, weightPresent);
  if (resolution_confidence < MIN_RESOLUTION_BPS) return { status: "unresolved", reason: "low_confidence" };

  // 5. Resolve — find-or-create the requester party, THEN the shipment (FK order: party before shipment).
  let party_id: string;
  let party_created: boolean;
  if (existing) {
    party_id = existing.id;
    party_created = false;
  } else {
    // The quote REQUESTER is the shipper. `name` only when we actually have one (exactOptionalPropertyTypes).
    const toCreate: { kind: PartyKind; email: string; name?: string } = { kind: "shipper", email };
    const name = parse.party_hint?.name;
    if (name) toCreate.name = name;
    const created = await port.createParty(toCreate);
    party_id = created.id;
    party_created = true;
  }

  // A QUOTE-STAGE shipment: a quote request rarely names the consignee or the payer yet, and the three
  // party FKs are NOT NULL — so all three point at the requester party (a deliberate self-reference).
  // ASSUMPTION (not a guarantee): the real consignee/bill-to firm up at BOOKING (WP-08). Today
  // booking.created's projection (ledger/src/projection/status-cache.ts) updates ONLY status_cache,
  // never the party FKs — so WP-08 MUST add an explicit party-correction, or the self-reference persists.
  // `refs` carries the source message event id — the dedup/provenance key. The AUTHORITATIVE link back to
  // message.received is the quote.requested event's `source_message_event_id` the consumer appends (below).
  const shipment = await port.createShipment({
    shipper_party_id: party_id,
    consignee_party_id: party_id,
    bill_to_party_id: party_id,
    refs: JSON.stringify({ source: "concierge", source_message_event_id: sourceMessageEventId }),
  });

  return { status: "resolved", party_id, shipment_id: shipment.id, party_created, resolution_confidence };
}
