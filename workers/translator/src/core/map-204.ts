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
import { partyIdForEmail, EventInput } from "@shuddl/contracts";
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
  // Every N1/N3/N4 postal address the wire carried — carried through so the worker writes parties.addresses
  // and NOTHING is silently dropped (CLAUDE.md #10 / REQ-201).
  addresses: { shipper?: EdiAddress; consignee?: EdiAddress; billTo?: EdiAddress };
  appends: EventInput[];
}

export interface MapTenderCtx {
  partnerId: string;
  // The interchange control number — the shipment-id fallback key when the tender carries no SID (B204).
  isaControl: string;
  // The 204-arrival clock the worker injects (keeps the core pure/deterministic — no Date inside). Stamped as
  // the append's actor-claimed `ts`; the sequencer still stamps the authoritative recorded_at server-side.
  receivedTs: number;
}

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

  // ── The party (bill-to, else the shipper) ──────────────────────────────────────────────────────────────
  let party: { id: string; kind: PartyKind; name: string; email?: string };
  const billTo = tender.billTo;
  if (billTo !== undefined) {
    const rawEmail = billTo.email; // stored original-case; partyIdForEmail normalizes (trim+lower) internally
    if (rawEmail !== undefined && rawEmail.trim() !== "") {
      // REQ-196: the SHARED matcher (normalizes internally) — the SAME id the CSR/Concierge derive.
      party = { id: await partyIdForEmail(rawEmail), kind: "broker", name: billTo.name, email: rawEmail };
    } else {
      // EXACT intake.ts no-email derivation (workers/api/src/routes/intake.ts:128) — name-keyed convergence.
      const normName = billTo.name.trim().toLowerCase();
      party = { id: `party_${(await sha256Hex(`intake:party:name:${normName}`)).slice(0, 16)}`, kind: "broker", name: billTo.name };
    }
  } else {
    // No bill-to on the tender: the shipper IS the counterparty (Concierge: requester = shipper). shipperStop
    // is defined here (we returned above unless originZip came from it).
    const shName = (shipperStop as NonNullable<typeof shipperStop>).name;
    const normName = shName.trim().toLowerCase();
    party = { id: `party_${(await sha256Hex(`intake:party:name:${normName}`)).slice(0, 16)}`, kind: "shipper", name: shName };
  }

  // ── The shipment id (deterministic; SID if present else the ISA control) ───────────────────────────────
  const sidOrIsa = tender.refs["SID"] ?? ctx.isaControl;
  const shipmentId = `shp_${(await sha256Hex(`edi:shipment:${ctx.partnerId}:${sidOrIsa}`)).slice(0, 16)}`;

  // ── The addresses (nothing dropped) ────────────────────────────────────────────────────────────────────
  const addresses: BookingPlan["addresses"] = {};
  const shipperAddr = nonEmptyAddress(shipperStop?.address);
  const consigneeAddr = nonEmptyAddress(consigneeStop?.address);
  const billToAddr = nonEmptyAddress(tender.billTo?.address);
  if (shipperAddr !== undefined) addresses.shipper = shipperAddr;
  if (consigneeAddr !== undefined) addresses.consignee = consigneeAddr;
  if (billToAddr !== undefined) addresses.billTo = billToAddr;

  // ── The append: a valid edi-source quote.requested ─────────────────────────────────────────────────────
  const request: { origin_zip: string; dest_zip: string; weight_lb?: number } = { origin_zip: originZip, dest_zip: destZip };
  // Attach weight ONLY when it is a clean positive integer (RateRequestPayload.weight_lb is SafeInt.min(1)); a
  // fractional/absent weight stays UNKNOWN — the engine returns UNKNOWN, never a fabricated (rounded) weight.
  if (tender.weightLb !== undefined && Number.isInteger(tender.weightLb) && tender.weightLb >= 1) {
    request.weight_lb = tender.weightLb;
  }
  const append = EventInput.parse({
    id: await deterministicUuid(`edi:quote-requested:${shipmentId}`),
    shipment_id: shipmentId,
    ts: ctx.receivedTs,
    actor: { party: party.id }, // the tendering counterparty
    party_refs: [party.id],
    evidence: [],
    source: "edi",
    confidence: 10_000, // a structured EDI tender is a high-confidence, machine-originated request
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
    addresses,
    appends: [append],
  };
}
