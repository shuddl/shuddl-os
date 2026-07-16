import { useState } from "react";
import { Button, Display, Divider, Input, Mono } from "@shuddl/design";
import { ApiError, get, post } from "../lib/api.js";
import { formatCents } from "../lib/money.js";
import {
  findAcceptableQuoteId,
  isPendingApproval,
  unknownReasonMessage,
  type EventsResponse,
  type PricedQuoteResponse,
  type QuoteResponse,
} from "../lib/quote.js";

// REQ-085/051 — the QUOTE → BOOK panel, wired to the real server and rendered HONESTLY (the WP-03 shell's
// "Get Quote" button had NO handler; this is the live seam). Two price paths:
//   · an authed party quoting a shipment it OWNS  → POST /v1/rate {shipment_id,…}  (lens-scoped, Task 8)
//   · a net-new lane with no shipment (preview)   → POST /pub/quote {…}             (guest preview, Task 4)
// and one book path: Accept a PRICED authed quote → POST /v1/shipments/:id/accept-quote {quote_event_id}
// (Task 8) → the WP-08 Booking agent. The portal party can NEVER book directly; it only ACCEPTS, and the
// booking is HELD server-side behind the credit/evidence gate — so we say "booking requested", never "booked".
//
// HONESTY LAWS this panel obeys (skill keep-map-instrument-truthful + REQ-004/059):
//   · money is formatted from INTEGER cents (formatCents), never float math;
//   · transit prints "N business days" ONLY when transit.status === "known"; "unavailable" prints NO number;
//   · UNKNOWN shows NO price and NO fabricated transit — just the honest reason;
//   · a below-floor / anomalous quote is shown as PENDING APPROVAL, never as a firm, bookable sell;
//   · margin internals (floors/basis/versions) are never read onto the wire — the server already redacts them.

export interface QuotePanelProps {
  /** When present, the party is quoting a shipment it OWNS → /v1/rate + an Accept/Book affordance. Absent ⇒
   * a net-new lane priced via /pub/quote as a PREVIEW ONLY (a net-new lane has no shipment to book against). */
  shipmentId?: string | undefined;
  /** Called on any ApiError.isAuthError so the board can drop the session and show the re-auth prompt. */
  onAuthError: () => void;
}

type AcceptPhase = "idle" | "accepting" | "requested" | "error";

// The one integer parse used for weight — an empty / non-numeric field is simply ABSENT (the engine then
// returns UNKNOWN missing_physics: no price on air), never a fabricated 0.
function parseWeight(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function transitLine(q: PricedQuoteResponse): string {
  if (q.transit.status !== "known") return "TRANSIT UNAVAILABLE"; // NEVER a fabricated number
  const d = q.transit.business_days;
  if (d === 0) return "TRANSIT · SAME BUSINESS DAY";
  return `TRANSIT · ${d} BUSINESS DAY${d === 1 ? "" : "S"}`;
}

export function QuotePanel({ shipmentId, onAuthError }: QuotePanelProps): React.JSX.Element {
  const [origin, setOrigin] = useState("");
  const [dest, setDest] = useState("");
  const [weight, setWeight] = useState("");
  const [pickup, setPickup] = useState(""); // captured for the booking context; the rater does NOT price on date

  const [loading, setLoading] = useState(false);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [acceptPhase, setAcceptPhase] = useState<AcceptPhase>("idle");
  const [acceptError, setAcceptError] = useState<string | null>(null);

  // A 401 from ANY call drops the session and re-prompts; every other ApiError surfaces its honest message.
  function handleApiError(e: unknown, setLocal: (m: string) => void): void {
    if (e instanceof ApiError && e.isAuthError) {
      onAuthError();
      return;
    }
    setLocal(e instanceof ApiError ? e.message : "REQUEST FAILED");
  }

  async function handleQuote(): Promise<void> {
    setLoading(true);
    setError(null);
    setQuote(null);
    setAcceptPhase("idle");
    setAcceptError(null);

    const weight_lb = parseWeight(weight);
    // pickup is deliberately NOT sent: both rate bodies are .strict() and price on physics + lane only.
    const body: Record<string, unknown> = { origin_zip: origin.trim(), dest_zip: dest.trim() };
    if (weight_lb !== undefined) body["weight_lb"] = weight_lb;

    try {
      const res = shipmentId
        ? await post<QuoteResponse>("/v1/rate", { shipment_id: shipmentId, ...body })
        : await post<QuoteResponse>("/pub/quote", body);
      setQuote(res);
    } catch (e) {
      handleApiError(e, setError);
    } finally {
      setLoading(false);
    }
  }

  async function handleAccept(priced: PricedQuoteResponse): Promise<void> {
    if (shipmentId === undefined) return; // guarded: a preview has no shipment to book against
    setAcceptPhase("accepting");
    setAcceptError(null);
    try {
      // /v1/rate does not echo the quote.priced id, so resolve it from the shipment's own lens-scoped feed —
      // binding the accept to EXACTLY the quote just shown (matched on the recorded sell).
      const feed = await get<EventsResponse>(`/v1/shipments/${encodeURIComponent(shipmentId)}/events?limit=200`);
      const quoteEventId = findAcceptableQuoteId(feed.events, priced.sell_cents);
      if (quoteEventId === null) {
        setAcceptPhase("error");
        setAcceptError("NO PRICED QUOTE TO ACCEPT ON THIS SHIPMENT");
        return;
      }
      await post(`/v1/shipments/${encodeURIComponent(shipmentId)}/accept-quote`, { quote_event_id: quoteEventId });
      // The accept only appends quote.accepted; the Booking agent runs async behind the credit/evidence gate,
      // so we report BOOKING REQUESTED — never "booked" (a held booking must not read as confirmed).
      setAcceptPhase("requested");
    } catch (e) {
      setAcceptPhase("error");
      handleApiError(e, setAcceptError);
    }
  }

  return (
    <section
      aria-label="Quote and book"
      style={{
        position: "absolute",
        top: 40,
        right: 32,
        width: "min(360px, 90vw)",
        background: "var(--ink-dark)",
        padding: 24,
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <Mono size={10} color="var(--signal-55)">
        {shipmentId ? "QUOTE → BOOK" : "QUOTE (PREVIEW)"}
      </Mono>
      <Input name="origin" placeholder="Origin ZIP" value={origin} onChange={setOrigin} />
      <Input name="dest" placeholder="Destination ZIP" value={dest} onChange={setDest} />
      <Input name="weight" placeholder="Weight (lb)" value={weight} onChange={setWeight} />
      <Input name="pickup" placeholder="Pickup date" value={pickup} onChange={setPickup} />
      <Button type="button" onClick={() => void handleQuote()}>
        Get Quote
      </Button>

      {loading ? (
        <Mono size={11} color="var(--field-on-dark)">
          PRICING…
        </Mono>
      ) : null}

      {error !== null ? (
        <Mono size={11} color="var(--signal)">
          {error}
        </Mono>
      ) : null}

      {quote !== null && quote.status === "UNKNOWN" ? (
        // UNKNOWN — NO price, NO transit. The honest reason only (no price on air, REQ-004).
        <div data-testid="quote-unknown" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <Mono size={10} color="var(--signal-55)">
            NO QUOTE
          </Mono>
          <Mono size={12} color="var(--field-on-dark)">
            {unknownReasonMessage(quote.reason)}
          </Mono>
        </div>
      ) : null}

      {quote !== null && quote.status === "PRICED" ? (
        <PricedResult
          quote={quote}
          canBook={shipmentId !== undefined}
          acceptPhase={acceptPhase}
          acceptError={acceptError}
          onAccept={() => void handleAccept(quote)}
        />
      ) : null}
    </section>
  );
}

function PricedResult({
  quote,
  canBook,
  acceptPhase,
  acceptError,
  onAccept,
}: {
  quote: PricedQuoteResponse;
  canBook: boolean;
  acceptPhase: AcceptPhase;
  acceptError: string | null;
  onAccept: () => void;
}): React.JSX.Element {
  const pending = isPendingApproval(quote);
  return (
    <div data-testid="quote-priced" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <Divider />
      <Mono size={10} color="var(--signal-55)">
        {pending ? "QUOTED SELL · PENDING APPROVAL" : "QUOTED SELL"}
      </Mono>
      <Display size="sub" color="var(--signal)">
        <span data-testid="quote-sell">{formatCents(quote.sell_cents)}</span>
      </Display>

      {quote.lines && quote.lines.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {quote.lines.map((line) => (
            <div key={`${line.kind}:${line.code}`} style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
              <Mono size={11} color="var(--field-on-dark)">
                {line.code}
              </Mono>
              <Mono size={11} color="var(--field-on-dark)">
                {formatCents(line.amount_cents)}
              </Mono>
            </div>
          ))}
        </div>
      ) : null}

      <Mono size={11} color="var(--field-on-dark)">
        <span data-testid="quote-transit">{transitLine(quote)}</span>
      </Mono>

      {pending ? (
        // A below-floor / anomalous quote is NOT a firm sell — reflect the gate, do not offer it to book.
        <Mono size={10} color="var(--signal-55)">
          NEEDS INTERNAL APPROVAL BEFORE BOOKING
        </Mono>
      ) : canBook ? (
        <AcceptControl phase={acceptPhase} error={acceptError} onAccept={onAccept} />
      ) : (
        <Mono size={10} color="var(--signal-55)">
          PREVIEW ONLY — SELECT A SHIPMENT TO BOOK
        </Mono>
      )}
    </div>
  );
}

function AcceptControl({
  phase,
  error,
  onAccept,
}: {
  phase: AcceptPhase;
  error: string | null;
  onAccept: () => void;
}): React.JSX.Element {
  if (phase === "requested") {
    return (
      <Mono size={11} color="var(--field-on-dark)">
        <span data-testid="accept-status">
          QUOTE ACCEPTED · BOOKING REQUESTED — we&apos;ll confirm; a credit hold or a missing delivery contact holds it for our team.
        </span>
      </Mono>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <Button type="button" onClick={onAccept}>
        {phase === "accepting" ? "Accepting…" : "Accept / Book"}
      </Button>
      {phase === "error" && error !== null ? (
        <Mono size={11} color="var(--signal)">
          <span data-testid="accept-status">{error}</span>
        </Mono>
      ) : null}
    </div>
  );
}
