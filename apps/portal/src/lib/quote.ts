// REQ-085/051 — the wire shapes the portal quote panel branches on, plus the PURE helpers that keep the
// render HONEST. These mirror the SERVER responses exactly (workers/api/src/routes/rate.ts pricedResponse
// and src/pub/quote.ts GuestQuoteResponse) — the client never reconstructs a price or a transit number, it
// only DISPLAYS what the server sent. Margin internals (floors/basis/versions) are absent from these types
// by design: the server already redacts them, and we never read them onto the wire object.

/** One margin-free price line (kind/code/amount_cents) — the same three fields the counterparty lens keeps. */
export interface QuoteLine {
  kind: "freight" | "fsc" | "accessorial";
  code: string;
  amount_cents: number;
}

/** The HONEST transit window: a whole business-day count when KNOWN, else an explicit "unavailable" carrying
 * NO number. A number is NEVER fabricated (the honest-window law, REQ-059). */
export type TransitWindow =
  | { status: "known"; business_days: number }
  | { status: "unavailable" };

/** The server's below-floor approval decision (present only on the authed /v1/rate response). "none" = a firm
 * sell; "single"/"dual" = the sell is pending a named approval and must NOT be presented as firm. */
export interface ApprovalInfo {
  approval: "none" | "single" | "dual";
  approvals_required: 0 | 1 | 2;
  rule: string | null;
  required_role: string | null;
}

/** A pricing anomaly flag (REQ-040) — a price that shouldn't exist. Present (non-null) only on the authed
 * response; the panel flags it and never presents the number as a firm, bookable sell. */
export interface AnomalyInfo {
  code: "over_per_lb" | "negative";
  detail: string;
}

/** PRICED — from /v1/rate (authed; carries approval + anomaly) OR /pub/quote (guest preview; neither field). */
export interface PricedQuoteResponse {
  status: "PRICED";
  sell_cents: number;
  lines?: QuoteLine[];
  transit: TransitWindow;
  approval?: ApprovalInfo; // authed /v1/rate only
  anomaly?: AnomalyInfo | null; // authed /v1/rate only
}

/** UNKNOWN — no price, no transit, just the honest reason. No price on air (REQ-004). */
export interface UnknownQuoteResponse {
  status: "UNKNOWN";
  reason: string;
}

export type QuoteResponse = PricedQuoteResponse | UnknownQuoteResponse;

/** A minimal ledger-event row as the lens read returns it (id/kind/payload) — used to resolve the
 * quote.priced event id to accept. */
export interface EventRow {
  id: string;
  kind: string;
  payload: unknown;
}

export interface EventsResponse {
  events: EventRow[];
}

/** Whether a PRICED quote is pending internal approval or carries a pricing anomaly. Such a quote is NOT a
 * firm sell — the panel reflects the pending state and does not offer it as bookable (REQ-030: the server is
 * the gate; the UI only reflects it). A guest preview (no approval field) is not "pending" here — it simply
 * carries no authed approval decision (it can never be booked at all). */
export function isPendingApproval(q: PricedQuoteResponse): boolean {
  const belowFloor = q.approval !== undefined && q.approval.approval !== "none";
  const anomalous = q.anomaly !== undefined && q.anomaly !== null;
  return belowFloor || anomalous;
}

/** The HONEST message for an UNKNOWN reason — states what is missing (weight/dims) or why the lane can't be
 * priced. NEVER a number, NEVER a fabricated transit. Unknown reasons fall back to a generic honest line. */
export function unknownReasonMessage(reason: string): string {
  switch (reason) {
    case "missing_physics":
      return "We need the shipment weight and dimensions to price this.";
    case "no_tariff":
      return "No published tariff for this account yet — we can't quote this automatically.";
    case "no_zone":
    case "no_rate_group":
      return "This lane isn't on the published tariff — reach out and we'll quote it by hand.";
    default:
      return "We can't price this one automatically yet.";
  }
}

/** Resolve the quote.priced event id to ACCEPT from a shipment's event feed. Prefers the NEWEST quote.priced
 * whose recorded `sell` matches the shown price (so the accept binds to EXACTLY the quote the party saw, never
 * a stale one); falls back to the newest quote.priced on the stream. Returns null when none exists. Events
 * arrive ascending by seq (lens read `ORDER BY stream_id, seq`), so the LAST match is the newest. */
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
