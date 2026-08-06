// WP-12 Task 6 · REQ-201/196 — the 204 → BOOKING-PLAN core. A parsed X12 204 load tender becomes a
// deterministic plan the Translator worker (Task 7/8) persists with INSERT OR IGNORE, so a 204-originated
// booking is IDENTICAL in shape to a CSR one (workers/api/src/routes/intake.ts) and a Concierge one
// (packages/agents/src/concierge/resolve.ts). PURE (REQ-204: zero I/O, no D1/R2/network) — it returns the
// plan and writes nothing; the worker owns the writes + the find-or-create against the tenant DB.
//
// CONVERGENCE (REQ-196): the bill-to party id is derived through the SHARED @shuddl/contracts matcher
// (partyIdForEmail) when the bill-to carries an email, so a mixed-case EDI `Bob@Acme.com` and a CSR/Concierge
// `bob@acme.com` collapse onto ONE party row (no split-billing duplicate). With no email, the id is derived
// EXACTLY as intake.ts derives a name-only party (`intake:party:name:<lower(name)>`) — the same scheme, so an
// EDI-created and a CSR-created name-only party still converge. IDEMPOTENCE: the shipment id + the whole plan
// (incl. the append's event id) are deterministic in the tender + ctx, so a redelivered 204 reproduces the
// SAME ids and the worker's INSERT OR IGNORE / id-dedup is a no-op (the make-agent-idempotent doctrine).
import { partyIdForEmail, partyIdForName, normalizePartyEmail, EventInput } from "@shuddl/contracts";
import type { TenderDoc, EdiAddress } from "@shuddl/edi";

// The parties.kind CHECK set (db/tenant/migrations/0002_domain.sql) — a 204 bill-to is the tendering
// counterparty (a broker), so the created party is kind "broker"; a tender with no bill-to falls back to the
// shipper stop (kind "shipper"), mirroring the Concierge (requester = shipper).
type PartyKind = "shipper" | "consignee" | "carrier" | "broker" | "cartage" | "factor" | "insurer";

export interface BookingPlan {
  party: { id: string; kind: PartyKind; name: string; email?: string };
  shipment: {
    id: string;
    partnerScac: string;
    // The three NOT-NULL party FKs. Self-referenced to the resolved party (the Concierge precedent,
    // resolve.ts): a tender's real shipper/consignee firm up at BOOKING via a party-correction, and the
    // physical N1/N3/N4 addresses below are preserved meanwhile (never dropped — Migrator rule).
    shipperPartyId: string;
    consigneePartyId: string;
    billToPartyId: string;
    refs: Record<string, string>;
  };
  // The 204's DISTINCT freight-stop IDENTITIES per role: the N102 firm NAME + its N3/N4 address. Unlike a
  // Concierge single-party quote (where consignee/bill-to are genuinely unknown), a 204 CARRIES real shipper +
  // consignee firms — so their names must survive into the plan for Task 8's worker to persist (as party rows
  // and/or shipment metadata) rather than be silently collapsed into the self-referenced bill-to FKs above
  // (Migrator rule 10 / CLAUDE.md #10 — never a silent drop). `addresses` below is the flattened postal view
  // (incl. bill-to, for parties.addresses); `stops` is the identity view (name-bearing) the FK collapse omits.
  stops: { shipper?: { name: string; address: EdiAddress }; consignee?: { name: string; address: EdiAddress } };
  // Every N1/N3/N4 postal address the wire carried — carried through so the worker writes parties.addresses
  // and NOTHING is silently dropped (CLAUDE.md #10 / REQ-201).
  addresses: { shipper?: EdiAddress; consignee?: EdiAddress; billTo?: EdiAddress };
  appends: EventInput[];
}

export interface MapTenderCtx {
  partnerId: string;
  // The 204-arrival clock the worker injects (keeps the core pure/deterministic — no Date inside). Stamped as
  // the append's actor-claimed `ts`; the sequencer still stamps the authoritative recorded_at server-side.
  receivedTs: number;
  // The CANONICAL shipment id (F-1 convergence): when a PRIOR tender for this physical load already exists — a
  // re-tender that ADDS or CHANGES a higher-priority ref (e.g. {PO} then {PO,SID}) — the worker resolves the
  // existing shipment id and passes it HERE so EVERY deterministic append id + the stream compute against it.
  // Threading it through the ctx (never a post-hoc id swap under already-built appends) keeps the
  // shipment_id↔stream invariant intact and lets the per-stream one-booking guard suppress the duplicate.
  shipmentIdOverride?: string;
}

// ── The reference taxonomy that drives shipment identity (REQ-191) ─────────────────────────────────────────
// LOAD-UNIQUE refs each identify ONE physical load: SID (B204), BOL (L11 BM), PRO (L11 PRO). The id seeds
// deterministically on them, AND the inbound handler CONVERGES a re-tender onto a prior shipment sharing one
// (a redelivery under a new interchange lands on the same stream — the true F-1 win).
export const LOAD_UNIQUE_REF_KEYS = ["SID", "BM", "PRO"] as const;
// ORDER-LEVEL refs are NOT a load id — one PO (purchase order) commonly spans MANY truckloads — so they must
// NEVER be a convergence key: converging on a shared PO would silently merge two DISTINCT loads and drop the
// second while ACKing 200 (a silent freight drop, CLAUDE.md #10). A tender whose ONLY stable ref is order-level
// is treated as distinct-per-delivery by the handler (prefer a VISIBLE duplicate over a SILENT drop); the id is
// still deterministic per delivery. Full B2A revision-code convergence is a go-live hardening item (REQ-205).
export const ORDER_LEVEL_REF_KEYS = ["PO"] as const;
// The shipment-id SEED priority (unchanged value: SID → BM → PRO → PO). A load-unique ref wins; PO is the
// last-resort seed. A per-interchange value (ISA13) is NEVER used for a load-unique seed (two redeliveries of the
// SAME no-SID tender arrive under DIFFERENT interchange controls → an ISA13-keyed id would mint two streams →
// two booking.created → a duplicate freight commitment; REQ-191 fires only WITHIN a stream). A tender carrying
// NONE of these has no stable identifier — the worker QUARANTINES it rather than mint a dup-prone id.
export const STABLE_REF_KEYS = [...LOAD_UNIQUE_REF_KEYS, ...ORDER_LEVEL_REF_KEYS] as const;

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A deterministic RFC-4122 UUID (version nibble 4, variant nibble 8-b) derived from a seed — so the
// quote.requested append has a STABLE id under redelivery (idempotent) yet still satisfies EventInput's
// `z.string().uuid()`. No randomness, no clock.
async function deterministicUuid(seed: string): Promise<string> {
  const h = await sha256Hex(seed); // 64 hex chars
  const variant = ((parseInt(h.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function nonEmptyAddress(a: EdiAddress | undefined): EdiAddress | undefined {
  return a !== undefined && Object.keys(a).length > 0 ? a : undefined;
}

export async function mapTenderToBooking(tender: TenderDoc, ctx: MapTenderCtx): Promise<BookingPlan> {
  const shipperStop = tender.stops.find((s) => s.role === "SH");
  const consigneeStop = tender.stops.find((s) => s.role === "CN");

  // "No price on air" (CLAUDE.md #4): a tender without BOTH stop zips is not a quotable lane. RateRequestPayload
  // requires both — reject here with a clear domain error rather than let EventInput.parse throw opaquely (the
  // worker quarantines a non-priceable tender via quarantineDescriptor).
  const originZip = shipperStop?.address.zip;
  const destZip = consigneeStop?.address.zip;
  if (originZip === undefined || destZip === undefined || originZip === "" || destZip === "") {
    throw new Error("MAP204_NO_LANE: a 204 without both stop zips is not priceable (no price on air)");
  }

  // ── The stable shipment identity (SID → BOL → PRO → PO; NEVER the per-interchange ISA13) ─────────────────
  // Resolved BEFORE any party/append work so a no-stable-ref tender fails fast: the worker quarantines it
  // (edi_no_shipment_ref) rather than mint an ISA13-derived id that a redelivery under a new interchange would
  // duplicate into a second booking. See STABLE_REF_KEYS.
  let stableRef: string | undefined;
  let stableRefKey: string | undefined;
  for (const key of STABLE_REF_KEYS) {
    const v = tender.refs[key]?.trim();
    if (v !== undefined && v !== "") {
      stableRef = v;
      stableRefKey = key; // F-2: the WINNING qualifier namespaces the id so SID:5000 ≠ PO:5000 (no bare collision)
      break;
    }
  }
  if (stableRef === undefined || stableRefKey === undefined) {
    throw new Error("MAP204_NO_SHIPMENT_REF: a 204 without a stable business ref (SID/BOL/PRO/PO) cannot mint an idempotent shipment id (would duplicate under a new ISA13)");
  }

  // ── The party (bill-to, else the shipper) ──────────────────────────────────────────────────────────────
  let party: { id: string; kind: PartyKind; name: string; email?: string };
  const billTo = tender.billTo;
  if (billTo !== undefined) {
    const rawEmail = billTo.email;
    if (rawEmail !== undefined && rawEmail.trim() !== "") {
      // REQ-196: the SHARED matcher (normalizes internally) — the SAME id the CSR/Concierge derive. The STORED
      // contact email is normalized too (trim+lower) so a messy wire value carries no stray case/whitespace;
      // the id already converges on the normalized form, and this keeps the stored value consistent with it.
      party = { id: await partyIdForEmail(rawEmail), kind: "broker", name: billTo.name, email: normalizePartyEmail(rawEmail) };
    } else {
        // The name-keyed derivation is now SHARED, not mirrored: `packages/contracts/src/party.ts:49@partyIdForName`
        // (REQ-196), called here and by workers/api/src/intake-core.ts. The refactor this comment used to ask
        // for has been done (audit §433) — the scheme was inlined in three places under a "parity LOCK" that
        // pinned only this side, so changing intake-core's prefix left it green while the two surfaces derived
        // different ids for one firm. Do not re-inline it; test/party-id-parity.test.ts fails in two distinct
        // ways if you do (comparison tests) or if the scheme's BYTES change (frozen goldens).
      const normName = billTo.name.trim().toLowerCase();
      party = { id: await partyIdForName(normName), kind: "broker", name: billTo.name };
    }
  } else {
    // No bill-to on the tender: the shipper IS the counterparty (Concierge: requester = shipper). shipperStop
    // is defined here (we returned above unless originZip came from it). Name-keyed derivation — see the
      // shared-derivation note above (`packages/contracts/src/party.ts:49@partyIdForName`, pinned by
      // test/party-id-parity.test.ts).
    const shName = (shipperStop as NonNullable<typeof shipperStop>).name;
    const normName = shName.trim().toLowerCase();
    party = { id: await partyIdForName(normName), kind: "shipper", name: shName };
  }

  // ── The shipment id ──────────────────────────────────────────────────────────────────────────────────────
  // The canonical override (F-1 convergence) wins when a prior tender for this load already exists; otherwise a
  // FRESH id seeded on (partner, QUALIFIER, value) — qualifier-namespaced (F-2) so SID:5000 and PO:5000 are two
  // distinct loads, never one swallowing the other.
  const shipmentId =
    ctx.shipmentIdOverride ?? `shp_${(await sha256Hex(`edi:shipment:${ctx.partnerId}:${stableRefKey}:${stableRef}`)).slice(0, 16)}`;

  // ── The addresses (nothing dropped) ────────────────────────────────────────────────────────────────────
  const addresses: BookingPlan["addresses"] = {};
  const shipperAddr = nonEmptyAddress(shipperStop?.address);
  const consigneeAddr = nonEmptyAddress(consigneeStop?.address);
  const billToAddr = nonEmptyAddress(tender.billTo?.address);
  if (shipperAddr !== undefined) addresses.shipper = shipperAddr;
  if (consigneeAddr !== undefined) addresses.consignee = consigneeAddr;
  if (billToAddr !== undefined) addresses.billTo = billToAddr;

  // ── The stop identities (the N102 firm names — never dropped, Migrator rule 10) ────────────────────────────
  const stops: BookingPlan["stops"] = {};
  if (shipperStop !== undefined) stops.shipper = { name: shipperStop.name, address: shipperStop.address };
  if (consigneeStop !== undefined) stops.consignee = { name: consigneeStop.name, address: consigneeStop.address };

  // ── The append: a valid edi-source quote.requested ─────────────────────────────────────────────────────
  const request: {
    origin_zip: string;
    dest_zip: string;
    weight_lb?: number;
    dims?: { l_in: number; w_in: number; h_in: number; pieces: number };
  } = { origin_zip: originZip, dest_zip: destZip };
  // Attach weight ONLY when it is a SAFE positive integer (RateRequestPayload.weight_lb is SafeInt.min(1)):
  // Number.isSafeInteger rejects BOTH a fractional AT8 value AND an absurd one above Number.MAX_SAFE_INTEGER,
  // so either routes to UNKNOWN (the engine returns UNKNOWN — no price on air) rather than throwing opaquely at
  // EventInput.parse. A weight is never fabricated (no rounding).
  if (tender.weightLb !== undefined && Number.isSafeInteger(tender.weightLb) && tender.weightLb >= 1) {
    request.weight_lb = tender.weightLb;
  }
  // Attach dims ONLY when the wire carried a COMPLETE measured set (l/w/h from an inch-unit L4 + pieces from AT8
  // AT804 — parse-204's single dims parse path). An incomplete/absent set leaves dims off ⇒ the rater returns
  // UNKNOWN (no price on air, CLAUDE.md #4). This is the ONE place a 204's dims reach the pricing request — the
  // handler prices the SAME recorded quote.requested request (no second parser, no divergence).
  const d = tender.dims;
  if (d?.lengthIn !== undefined && d.widthIn !== undefined && d.heightIn !== undefined && d.pieces !== undefined) {
    request.dims = { l_in: d.lengthIn, w_in: d.widthIn, h_in: d.heightIn, pieces: d.pieces };
  }
  const append = EventInput.parse({
    id: await deterministicUuid(`edi:quote-requested:${shipmentId}`),
    shipment_id: shipmentId,
    ts: ctx.receivedTs,
    actor: { party: party.id }, // the tendering counterparty
    party_refs: [party.id],
    evidence: [],
    source: "edi",
    // Envelope confidence is CAPTURE confidence (how sure we are the event was recorded correctly), NOT a trust
    // score of the counterparty's data — a structured, machine-parsed 204 is captured at least as reliably as
    // the Concierge's LLM-parsed inbound email, which appends quote.requested at 10_000 (concierge.ts:651). Held
    // at 10_000 to match that quote.requested precedent (lowering it here would be unexplained drift).
    confidence: 10_000,
    kind: "quote.requested",
    payload: { request },
  });

  return {
    party,
    shipment: {
      id: shipmentId,
      partnerScac: tender.partnerScac,
      shipperPartyId: party.id,
      consigneePartyId: party.id,
      billToPartyId: party.id,
      refs: { ...tender.refs },
    },
    stops,
    addresses,
    appends: [append],
  };
}
