// WP-10 Task 11 (REQ-150) — the CSR net-new intake ORCHESTRATION + the pure HONEST-render helpers. The
// question-driven flow (IntakeFlow.tsx) books a brand-new phone/walk-in order from scratch by composing over
// the EXISTING server verbs the earlier tasks shipped — this module is the thin, testable seam between the
// flow's structured questions and those verbs:
//   parties  → POST /v1/parties           (Task 6 find-or-create; idempotent on email/name)
//   shipment → POST /v1/shipments          (Task 6; the QUOTE-STAGE shipments row with the 3 party FKs)
//   quote    → POST /v1/rate               (the server-side pricing gate; PRICED / UNKNOWN / below-floor)
//   book     → POST /v1/shipments/:id/accept-quote  (Task 8; appends quote.accepted → the gated Booking agent)
//
// HONESTY LAWS (skill keep-map-instrument-truthful + REQ-004/030/059) this module encodes ONCE so the flow can
// only REFLECT the server, never invent:
//   · money is formatted from INTEGER cents (formatCents), never float math;
//   · transit prints a number ONLY when transit.status === "known"; "unavailable" carries NO number;
//   · an UNKNOWN quote shows NO price and NO transit — just the honest reason (no price on air);
//   · a below-floor / anomalous quote is PENDING APPROVAL — never a firm, bookable sell;
//   · a booking is REQUESTED (it runs the credit/evidence gates async and can HOLD) — never a false "BOOKED".
//
// RESUME-SAFETY / no double-create: the flow caches the created `PartyIds` and `shipment_id`, so a mid-flow
// failure (a 403, a network drop) is retried WITHOUT re-creating them. Parties are additionally content-
// idempotent server-side (id derived from the email/name, INSERT OR IGNORE), so even a re-run collapses to the
// same row; the shipment is created exactly once (cached) so a retry after it exists never duplicates it.

/** The narrow api seam the flow dispatches through — the Task-8 client's post/get. `post` attaches a fresh
 * Idempotency-Key per mutation (the client owns it); `get` reads the lens-scoped feed. */
export interface IntakeApi {
  post<T>(path: string, body?: unknown): Promise<T>;
  get<T>(path: string): Promise<T>;
}

// ── The captured order draft (structured questions — NO natural language / LLM) ──────────────────────────────
/** One party the CSR keys: a legal name (required to create) + an optional deliverable email (the one contact a
 * new customer's booking gate reads; a bill_to with no contact can HOLD the booking, which we reflect honestly). */
export interface PartyDraft {
  name: string;
  email: string;
}

/** The three parties a booking needs. The bill_to is the billed customer; the parties table has no `bill_to`
 * kind (the 7 kinds are shipper/consignee/carrier/broker/cartage/factor/insurer), so — mirroring the Concierge,
 * which writes the billed requester as a `shipper` — the bill_to party is created as a `shipper`. */
export interface CustomerDraft {
  shipper: PartyDraft;
  consignee: PartyDraft;
  bill_to: PartyDraft;
}

/** The lane + freight the rater prices on. Weight/dims are OPTIONAL: absent ⇒ the server returns UNKNOWN
 * missing_physics (no price on air), never a fabricated 0. Everything is a raw string from the field; parsing
 * (integer-only) happens at freightBody. */
export interface LaneDraft {
  origin_zip: string;
  dest_zip: string;
  weight: string;
  length_in: string;
  width_in: string;
  height_in: string;
  pieces: string;
  accessorials: string;
}

/** The three server party ids, cached so a retry never re-creates them. */
export interface PartyIds {
  shipper_party_id: string;
  consignee_party_id: string;
  bill_to_party_id: string;
}

// ── The wire shapes /v1/rate returns (mirrors workers/api/src/routes/rate.ts pricedResponse) ─────────────────
// Margin internals (floors/basis/versions) are deliberately ABSENT — the flow never reads them onto the render.
export interface QuoteLine {
  kind: "freight" | "fsc" | "accessorial";
  code: string;
  amount_cents: number;
}
export type TransitWindow = { status: "known"; business_days: number } | { status: "unavailable" };
export interface ApprovalInfo {
  approval: "none" | "single" | "dual";
  approvals_required: 0 | 1 | 2;
  rule: string | null;
  required_role: string | null;
}
export interface AnomalyInfo {
  code: "over_per_lb" | "negative";
  detail: string;
}
export interface PricedQuoteResponse {
  status: "PRICED";
  sell_cents: number;
  lines?: QuoteLine[];
  transit: TransitWindow;
  approval?: ApprovalInfo;
  anomaly?: AnomalyInfo | null;
}
export interface UnknownQuoteResponse {
  status: "UNKNOWN";
  reason: string;
}
export type QuoteResponse = PricedQuoteResponse | UnknownQuoteResponse;

/** A minimal ledger-event row (id/kind/payload) as the lens read returns it — used to resolve the quote.priced
 * event id to accept (the /v1/rate response does not echo it). */
export interface EventRow {
  id: string;
  kind: string;
  payload: unknown;
}
export interface EventsResponse {
  events: EventRow[];
}

// ── Pure render helpers (the honest laws, stated once) ───────────────────────────────────────────────────────

/** Format integer cents as a US-dollar string with thousands separators — integer-only (Math.floor/% on the
 * exact integer), so no float division ever touches the money (mirrors the portal's money helper). */
export function formatCents(cents: number): string {
  const whole = Math.trunc(cents);
  const negative = whole < 0;
  const abs = Math.abs(whole);
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `${negative ? "-" : ""}$${dollars.toLocaleString("en-US")}.${String(remainder).padStart(2, "0")}`;
}

/** Whether a PRICED quote is pending internal approval OR carries a pricing anomaly — NOT a firm, bookable sell.
 * The flow reflects the pending state and offers no Book affordance (REQ-030: the server is the gate). */
export function isPendingApproval(q: PricedQuoteResponse): boolean {
  const belowFloor = q.approval !== undefined && q.approval.approval !== "none";
  const anomalous = q.anomaly !== undefined && q.anomaly !== null;
  return belowFloor || anomalous;
}

/** The HONEST message for an UNKNOWN reason — states what is missing (weight/dims) or why the lane can't be
 * priced. NEVER a number, NEVER a fabricated transit (mirrors the portal's mapping). */
export function unknownReasonMessage(reason: string): string {
  switch (reason) {
    case "missing_physics":
      return "We need the shipment weight and dimensions to price this.";
    case "no_tariff":
      return "No published tariff for this account yet — we can't quote this automatically.";
    case "no_zone":
    case "no_rate_group":
      return "This lane isn't on the published tariff — quote it by hand.";
    default:
      return "We can't price this one automatically yet.";
  }
}

/** The HONEST transit line: a whole business-day count ONLY when KNOWN; "unavailable" prints NO number. */
export function transitLine(q: PricedQuoteResponse): string {
  if (q.transit.status !== "known") return "TRANSIT UNAVAILABLE";
  const d = q.transit.business_days;
  if (d === 0) return "TRANSIT · SAME BUSINESS DAY";
  return `TRANSIT · ${d} BUSINESS DAY${d === 1 ? "" : "S"}`;
}

/** Resolve the quote.priced event id to ACCEPT from a shipment's event feed. Prefers the NEWEST quote.priced
 * whose recorded `sell` matches the shown price (so the accept binds to EXACTLY the quote the CSR saw), else the
 * newest quote.priced. Returns null when none exists (mirrors the portal's helper). */
export function findAcceptableQuoteId(events: readonly EventRow[], sellCents: number): string | null {
  const priced = events.filter((e) => e.kind === "quote.priced");
  for (let i = priced.length - 1; i >= 0; i--) {
    const row = priced[i];
    if (row === undefined) continue;
    const sell = (row.payload as { sell?: unknown } | null | undefined)?.sell;
    if (sell === sellCents) return row.id;
  }
  const newest = priced[priced.length - 1];
  return newest ? newest.id : null;
}

// ── Field parsing (integer-only canonical law; absent ⇒ UNKNOWN, never a fabricated 0) ───────────────────────
function parsePositiveInt(raw: string): number | undefined {
  const t = raw.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
function parseNonNegativeInt(raw: string): number | undefined {
  const t = raw.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** Build the /v1/rate freight body from the lane draft. weight_lb/dims/accessorials are attached ONLY when
 * present + valid — an absent/invalid weight or an incomplete dims set is simply omitted (⇒ the server returns
 * UNKNOWN missing_physics; no price on air). exactOptionalPropertyTypes-safe: no `undefined` keys. */
export function freightBody(lane: LaneDraft): Record<string, unknown> {
  const body: Record<string, unknown> = { origin_zip: lane.origin_zip.trim(), dest_zip: lane.dest_zip.trim() };
  const weight = parsePositiveInt(lane.weight);
  if (weight !== undefined) body.weight_lb = weight;
  const l = parseNonNegativeInt(lane.length_in);
  const w = parseNonNegativeInt(lane.width_in);
  const h = parseNonNegativeInt(lane.height_in);
  const pieces = parsePositiveInt(lane.pieces);
  if (l !== undefined && w !== undefined && h !== undefined && pieces !== undefined) {
    body.dims = { l_in: l, w_in: w, h_in: h, pieces };
  }
  const acc = lane.accessorials
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (acc.length > 0) body.accessorials = acc;
  return body;
}

// ── The orchestration verbs (each awaits a real seam; each is safe to re-run per the resume-safety note) ──────

/** find-or-create ONE party (Task-6 seam). Content-idempotent server-side: a re-POST of the same email/name
 * returns the existing id. Returns the party id. */
async function createParty(api: IntakeApi, kind: string, draft: PartyDraft): Promise<string> {
  const body: Record<string, unknown> = { kind, name: draft.name.trim() };
  const email = draft.email.trim();
  if (email !== "") body.email = email;
  const res = await api.post<{ id: string }>("/v1/parties", body);
  return res.id;
}

/** Create (find-or-create) the three parties a booking needs. The bill_to is created as a `shipper` (see
 * CustomerDraft). Content-idempotent, so this is always safe to re-run; the flow still caches the result. */
export async function ensureParties(api: IntakeApi, customer: CustomerDraft): Promise<PartyIds> {
  const shipper_party_id = await createParty(api, "shipper", customer.shipper);
  const consignee_party_id = await createParty(api, "consignee", customer.consignee);
  const bill_to_party_id = await createParty(api, "shipper", customer.bill_to);
  return { shipper_party_id, consignee_party_id, bill_to_party_id };
}

/** Materialize the QUOTE-STAGE shipments row with the three party FKs (Task-6 seam). Returns the shipment id.
 * Created exactly once per order (the flow caches it), so a post-shipment retry never duplicates it. */
export async function createShipment(api: IntakeApi, ids: PartyIds): Promise<string> {
  const res = await api.post<{ shipment_id: string }>("/v1/shipments", ids);
  return res.shipment_id;
}

/** Price the shipment through the SERVER-SIDE pricing gate (/v1/rate). Returns the honest PRICED/UNKNOWN result
 * the flow reflects — the price/transit/approval come straight from the server; the flow invents nothing. */
export function requestQuote(api: IntakeApi, shipmentId: string, lane: LaneDraft): Promise<QuoteResponse> {
  return api.post<QuoteResponse>("/v1/rate", { shipment_id: shipmentId, ...freightBody(lane) });
}

/** Resolve the priced quote's event id from the shipment's lens-scoped feed, then accept it (/accept-quote →
 * quote.accepted → the gated Booking agent). Idempotent: the accepted event id is server-derived from the quote
 * id, so twice-in is once-out (one booking). Throws `NO_PRICED_QUOTE` when the feed has no matching quote. */
export async function acceptQuote(api: IntakeApi, shipmentId: string, sellCents: number): Promise<void> {
  const feed = await api.get<EventsResponse>(`/v1/shipments/${encodeURIComponent(shipmentId)}/events?limit=200`);
  const quoteEventId = findAcceptableQuoteId(feed.events, sellCents);
  if (quoteEventId === null) throw new Error("NO_PRICED_QUOTE");
  await api.post(`/v1/shipments/${encodeURIComponent(shipmentId)}/accept-quote`, { quote_event_id: quoteEventId });
}
