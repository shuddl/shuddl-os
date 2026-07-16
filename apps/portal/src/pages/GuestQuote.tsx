import { useState } from "react";
import { Button, Display, Divider, Input, Mono, TextLink } from "@shuddl/design";
import { ApiError, post } from "../lib/api.js";
import { formatCents } from "../lib/money.js";
import { unknownReasonMessage, type PricedQuoteResponse, type QuoteResponse } from "../lib/quote.js";

// PUBLIC GUEST QUOTE (REQ-051) — the "<60s guest quote" surface. A stranger prices freight with NO account
// and ZERO ledger residue: it posts to POST /pub/quote (no session, no bearer) and renders the result
// HONESTLY. Structurally, a guest may QUOTE but NEVER BOOK — the public route appends nothing and there is no
// accept affordance here; the only next step is a CTA to create an account.
//
// HONESTY LAWS (mirrors the authed QuotePanel):
//   · money is formatted from INTEGER cents (formatCents), never float math;
//   · transit prints "N business days" ONLY when transit.status === "known"; "unavailable" prints NO number;
//   · UNKNOWN shows NO price and NO fabricated transit — just the honest reason;
//   · margin internals never ride the wire (the server redacts them; we read only sell + margin-free lines).

// The honest transit line — a whole business-day count when KNOWN, else NO number (REQ-059).
function transitLine(q: PricedQuoteResponse): string {
  if (q.transit.status !== "known") return "TRANSIT UNAVAILABLE";
  const d = q.transit.business_days;
  if (d === 0) return "TRANSIT · SAME BUSINESS DAY";
  return `TRANSIT · ${d} BUSINESS DAY${d === 1 ? "" : "S"}`;
}

// An empty / non-numeric weight is ABSENT (the engine then returns UNKNOWN missing_physics), never a fake 0.
function parseWeight(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function GuestQuote(): React.JSX.Element {
  const [origin, setOrigin] = useState("");
  const [dest, setDest] = useState("");
  const [weight, setWeight] = useState("");

  const [loading, setLoading] = useState(false);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleQuote(): Promise<void> {
    setLoading(true);
    setError(null);
    setQuote(null);
    const weight_lb = parseWeight(weight);
    const body: Record<string, unknown> = { origin_zip: origin.trim(), dest_zip: dest.trim() };
    if (weight_lb !== undefined) body["weight_lb"] = weight_lb;
    try {
      // PUBLIC preview — no shipment_id (a guest has nothing to book against), no session bearer required.
      const res = await post<QuoteResponse>("/pub/quote", body);
      setQuote(res);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "REQUEST FAILED");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--field)",
        overflow: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 16,
        padding: 32,
        maxWidth: 520,
      }}
    >
      <Mono size={11} color="var(--signal-55)">
        SHUDDL · INSTANT QUOTE
      </Mono>
      <Display size="section">QUOTE FREIGHT</Display>
      <Mono size={12} color="var(--signal-deep)">
        Price a lane in seconds — no account needed.
      </Mono>

      <Input name="origin" placeholder="Origin ZIP" value={origin} onChange={setOrigin} />
      <Input name="dest" placeholder="Destination ZIP" value={dest} onChange={setDest} />
      <Input name="weight" placeholder="Weight (lb)" value={weight} onChange={setWeight} />
      <div>
        <Button type="button" onClick={() => void handleQuote()}>
          Get Quote
        </Button>
      </div>

      {loading ? (
        <Mono size={11} color="var(--signal-55)">
          PRICING…
        </Mono>
      ) : null}

      {error !== null ? (
        <Mono size={11} color="var(--signal)">
          {error}
        </Mono>
      ) : null}

      {quote !== null && quote.status === "UNKNOWN" ? (
        <div data-testid="guest-unknown" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <Divider />
          <Mono size={10} color="var(--signal-55)">
            NO QUOTE
          </Mono>
          <Mono size={12} color="var(--signal-deep)">
            {unknownReasonMessage(quote.reason)}
          </Mono>
        </div>
      ) : null}

      {quote !== null && quote.status === "PRICED" ? <GuestPriced quote={quote} /> : null}
    </main>
  );
}

function GuestPriced({ quote }: { quote: PricedQuoteResponse }): React.JSX.Element {
  return (
    <div data-testid="guest-priced" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <Divider />
      <Mono size={10} color="var(--signal-55)">
        QUOTED SELL
      </Mono>
      <Display size="sub" color="var(--signal)">
        <span data-testid="guest-sell">{formatCents(quote.sell_cents)}</span>
      </Display>

      {quote.lines && quote.lines.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {quote.lines.map((line) => (
            <div key={`${line.kind}:${line.code}`} style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
              <Mono size={11} color="var(--signal-deep)">
                {line.code}
              </Mono>
              <Mono size={11} color="var(--signal-deep)">
                {formatCents(line.amount_cents)}
              </Mono>
            </div>
          ))}
        </div>
      ) : null}

      <Mono size={11} color="var(--signal-deep)">
        <span data-testid="guest-transit">{transitLine(quote)}</span>
      </Mono>

      {/* Structural: a guest can NEVER book. The only next step is to create an account (booking is the authed
          Booking agent, behind the server-side credit/evidence gate). */}
      <div data-testid="guest-cta" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <Mono size={11} color="var(--signal-55)">
          TO BOOK, CREATE AN ACCOUNT
        </Mono>
        <TextLink href="/?screen=portal">Create an account</TextLink>
      </div>
    </div>
  );
}
