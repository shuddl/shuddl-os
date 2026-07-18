import { useState } from "react";
import { Button, Display, Divider, Input, Mono, Reveal } from "@shuddl/design";
import { ApiError } from "../lib/api.js";
import {
  acceptQuote,
  createShipment,
  ensureParties,
  formatCents,
  isPendingApproval,
  requestQuote,
  transitLine,
  unknownReasonMessage,
  type CustomerDraft,
  type IntakeApi,
  type LaneDraft,
  type PartyDraft,
  type PartyIds,
  type PricedQuoteResponse,
  type QuoteResponse,
} from "./intake.js";

// WP-10 Task 11 (REQ-150) — the CSR net-new intake FLOW, launched by the ⌘K "New Order (CSR Intake)" command
// (deps.openIntake, Task 10). A DETERMINISTIC, question-driven modal (structured fields — NO natural language /
// LLM) that books a brand-new phone/walk-in order from scratch, composing over the Task-6/8 server verbs:
//   1. CUSTOMER  → POST /v1/parties (shipper / consignee / bill_to; find-or-create)
//   2. LANE      → the /v1/rate freight fields (origin/dest + weight/dims/accessorials)
//   3. SHIPMENT  → POST /v1/shipments (the QUOTE-STAGE row with the 3 party FKs)
//   4. QUOTE     → POST /v1/rate (rendered HONESTLY: PRICED sell + honest transit / UNKNOWN reason / PENDING)
//   5. BOOK      → POST /v1/shipments/:id/accept-quote (→ the gated Booking agent; "REQUESTED", never "BOOKED")
//
// HONESTY (skill keep-map-instrument-truthful + REQ-004/030/059): integer-cents money; a transit number ONLY
// when KNOWN; an UNKNOWN shows NO price + NO transit; a below-floor quote is PENDING APPROVAL (no book button);
// a booking is REQUESTED and may HOLD on credit/contact — never a false "BOOKED"; a 403/gate-block shows the
// real reason. RESUME-SAFE: partyIds + shipment_id are cached, so a mid-flow error is retried WITHOUT
// re-creating them (no double-create); the booking still flows server-side through #enforceBooking.
//
// DESIGN (token-only, BLOCKING at WP-10 exit): the CommandBar/QuotePanel vocabulary — `var(--ink-dark)`
// surface, `var(--signal-12)` rule, `Mono`/`Display`/`Input`/`Button`/`Divider`/`Reveal` primitives. No new
// color, no shadow, no gradient, no radius >4px, no hand-rolled keyframe.

export interface IntakeFlowProps {
  /** The Task-8 api client (post attaches a fresh Idempotency-Key per mutation). */
  api: IntakeApi;
  /** Close the flow (the CSR abandons, or finishes and dismisses). */
  onClose(): void;
  /** Open the just-booked shipment's lens on the board (the map home LensPanel). */
  onOpenShipment(shipmentId: string): void;
  /** Optional: a 401 drops the session upstream (mirrors the portal's re-auth path). */
  onAuthError?(): void;
}

type Phase = "customer" | "lane" | "quoted" | "booked";

const EMPTY_PARTY: PartyDraft = { name: "", email: "" };
const EMPTY_LANE: LaneDraft = {
  origin_zip: "",
  dest_zip: "",
  weight: "",
  length_in: "",
  width_in: "",
  height_in: "",
  pieces: "",
  accessorials: "",
};

// A server failure, reflected HONESTLY (mirrors the command registry's `honest`): the stable ErrorCode + its
// message. The one client-side sentinel — an empty priced feed — is stated plainly, never as a fake success.
function honestMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message ? `${e.code} — ${e.message}` : e.code;
  if (e instanceof Error && e.message === "NO_PRICED_QUOTE") return "NO PRICED QUOTE TO ACCEPT ON THIS SHIPMENT";
  return "REQUEST FAILED";
}

const PHASE_STEP: Record<Phase, string> = { customer: "1/4", lane: "2/4", quoted: "3/4", booked: "4/4" };

export function IntakeFlow({ api, onClose, onOpenShipment, onAuthError }: IntakeFlowProps): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>("customer");
  const [customer, setCustomer] = useState<CustomerDraft>({
    shipper: { ...EMPTY_PARTY },
    consignee: { ...EMPTY_PARTY },
    bill_to: { ...EMPTY_PARTY },
  });
  const [lane, setLane] = useState<LaneDraft>({ ...EMPTY_LANE });

  // Cached so a retry never re-creates them (resume-safety; no double-create).
  const [partyIds, setPartyIds] = useState<PartyIds | null>(null);
  const [shipmentId, setShipmentId] = useState<string | null>(null);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [booking, setBooking] = useState(false);

  function setParty(role: keyof CustomerDraft, field: keyof PartyDraft, value: string): void {
    setCustomer((c) => ({ ...c, [role]: { ...c[role], [field]: value } }));
  }
  function setLaneField(field: keyof LaneDraft, value: string): void {
    setLane((l) => ({ ...l, [field]: value }));
  }

  function handleError(e: unknown): void {
    if (e instanceof ApiError && e.isAuthError) onAuthError?.();
    setError(honestMessage(e));
  }

  // CUSTOMER → LANE. Honest validation: the three parties a booking needs must be NAMED before we create
  // anything — no phantom party, no orphan shipment. (Email is optional; a bill_to with no contact can HOLD the
  // booking, which the flow reflects honestly at the end.)
  function continueToLane(): void {
    if (customer.shipper.name.trim() === "" || customer.consignee.name.trim() === "" || customer.bill_to.name.trim() === "") {
      setError("SHIPPER, CONSIGNEE, AND BILL-TO NAME ARE REQUIRED");
      return;
    }
    setError(null);
    setPhase("lane");
  }

  // parties → shipment → /v1/rate. Each cached id is reused (never re-created) so a mid-flow failure is a clean
  // retry: on re-run, ensureParties/createShipment are skipped and only the failed step re-fires.
  async function runQuote(): Promise<void> {
    if (quoting) return;
    setError(null);
    setQuoting(true);
    try {
      const ids = partyIds ?? (await ensureParties(api, customer));
      if (partyIds === null) setPartyIds(ids);
      const sid = shipmentId ?? (await createShipment(api, ids));
      if (shipmentId === null) setShipmentId(sid);
      const q = await requestQuote(api, sid, lane);
      setQuote(q);
      setPhase("quoted");
    } catch (e) {
      handleError(e); // stay on the lane step so the CSR can retry with the captured state intact
    } finally {
      setQuoting(false);
    }
  }

  // Accept a PRICED, approvable quote → quote.accepted → the gated Booking agent. The accept is idempotent
  // server-side (the accepted event id is derived from the quote id), so a retry never double-books.
  async function runBook(): Promise<void> {
    if (booking || quote === null || quote.status !== "PRICED" || isPendingApproval(quote) || shipmentId === null) return;
    setError(null);
    setBooking(true);
    try {
      await acceptQuote(api, shipmentId, quote.sell_cents);
      setPhase("booked");
    } catch (e) {
      handleError(e); // stay on the quoted step so the CSR can retry the accept
    } finally {
      setBooking(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-label="CSR intake"
      style={{ position: "fixed", inset: 0, zIndex: 20, display: "flex", justifyContent: "center", alignItems: "flex-start" }}
    >
      {/* Backdrop — the map dims behind (the same world-dim honesty the palette uses). Click to close. */}
      <div aria-hidden onClick={onClose} style={{ position: "absolute", inset: 0, background: "var(--ink-dark)", opacity: 0.55 }} />
      <Reveal>
        <div
          style={{
            position: "relative",
            marginTop: "10vh",
            width: "min(560px, 92vw)",
            maxHeight: "80vh",
            overflowY: "auto",
            background: "var(--ink-dark)",
            border: "1px solid var(--signal-12)",
            padding: 20,
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <Mono size={10} color="var(--signal-55)">
              NEW ORDER · CSR INTAKE — STEP {PHASE_STEP[phase]}
            </Mono>
            <button
              type="button"
              aria-label="Close intake"
              onClick={onClose}
              style={{ background: "transparent", border: "none", cursor: "pointer", padding: 0 }}
            >
              <Mono size={10} color="var(--signal-55)">
                CLOSE
              </Mono>
            </button>
          </div>

          {phase === "customer" ? (
            <CustomerStep customer={customer} onField={setParty} onContinue={continueToLane} />
          ) : null}

          {phase === "lane" ? (
            <LaneStep lane={lane} onField={setLaneField} quoting={quoting} onQuote={() => void runQuote()} onBack={() => setPhase("customer")} />
          ) : null}

          {phase === "quoted" && quote !== null ? (
            <QuoteStep quote={quote} booking={booking} onBook={() => void runBook()} onEditLane={() => setPhase("lane")} />
          ) : null}

          {phase === "booked" && shipmentId !== null ? (
            <BookedStep
              onOpenBoard={() => {
                onOpenShipment(shipmentId);
                onClose();
              }}
              onClose={onClose}
            />
          ) : null}

          {error !== null ? (
            <div data-testid="intake-error">
              <Mono size={11} color="var(--signal)">
                {error}
              </Mono>
            </div>
          ) : null}
        </div>
      </Reveal>
    </div>
  );
}

// ── Step 1 — CUSTOMER (the three parties a booking needs) ────────────────────────────────────────────────────
function CustomerStep({
  customer,
  onField,
  onContinue,
}: {
  customer: CustomerDraft;
  onField: (role: keyof CustomerDraft, field: keyof PartyDraft, value: string) => void;
  onContinue: () => void;
}): React.JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Mono size={10} color="var(--signal-55)">
        CUSTOMER — WHO IS ON THIS ORDER
      </Mono>

      <Mono size={10} color="var(--signal-55)">
        BILL-TO (BILLED CUSTOMER)
      </Mono>
      <Input name="bill_to_name" placeholder="Bill-to name" value={customer.bill_to.name} onChange={(v) => onField("bill_to", "name", v)} />
      <Input name="bill_to_email" placeholder="Bill-to email" value={customer.bill_to.email} onChange={(v) => onField("bill_to", "email", v)} />

      <Mono size={10} color="var(--signal-55)">
        SHIPPER (ORIGIN)
      </Mono>
      <Input name="shipper_name" placeholder="Shipper name" value={customer.shipper.name} onChange={(v) => onField("shipper", "name", v)} />
      <Input name="shipper_email" placeholder="Shipper email" value={customer.shipper.email} onChange={(v) => onField("shipper", "email", v)} />

      <Mono size={10} color="var(--signal-55)">
        CONSIGNEE (DESTINATION)
      </Mono>
      <Input name="consignee_name" placeholder="Consignee name" value={customer.consignee.name} onChange={(v) => onField("consignee", "name", v)} />
      <Input
        name="consignee_email"
        placeholder="Consignee email"
        value={customer.consignee.email}
        onChange={(v) => onField("consignee", "email", v)}
      />

      <Button type="button" onClick={onContinue}>
        Continue
      </Button>
    </div>
  );
}

// ── Step 2 — LANE + FREIGHT (the /v1/rate fields) ────────────────────────────────────────────────────────────
function LaneStep({
  lane,
  onField,
  quoting,
  onQuote,
  onBack,
}: {
  lane: LaneDraft;
  onField: (field: keyof LaneDraft, value: string) => void;
  quoting: boolean;
  onQuote: () => void;
  onBack: () => void;
}): React.JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Mono size={10} color="var(--signal-55)">
        LANE + FREIGHT
      </Mono>
      <Input name="origin_zip" placeholder="Origin ZIP" value={lane.origin_zip} onChange={(v) => onField("origin_zip", v)} />
      <Input name="dest_zip" placeholder="Destination ZIP" value={lane.dest_zip} onChange={(v) => onField("dest_zip", v)} />
      <Input name="weight" placeholder="Weight (lb)" value={lane.weight} onChange={(v) => onField("weight", v)} />
      <Mono size={10} color="var(--signal-55)">
        DIMS — BLANK = UNPRICED (NO PRICE ON AIR)
      </Mono>
      <div style={{ display: "flex", gap: 8 }}>
        <Input name="length_in" placeholder="Length (in)" value={lane.length_in} onChange={(v) => onField("length_in", v)} />
        <Input name="width_in" placeholder="Width (in)" value={lane.width_in} onChange={(v) => onField("width_in", v)} />
        <Input name="height_in" placeholder="Height (in)" value={lane.height_in} onChange={(v) => onField("height_in", v)} />
        <Input name="pieces" placeholder="Pieces" value={lane.pieces} onChange={(v) => onField("pieces", v)} />
      </div>
      <Input
        name="accessorials"
        placeholder="Accessorials (comma-separated)"
        value={lane.accessorials}
        onChange={(v) => onField("accessorials", v)}
      />

      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <Button type="button" onClick={onQuote}>
          Get Quote
        </Button>
        <button type="button" onClick={onBack} style={{ background: "transparent", border: "none", cursor: "pointer", padding: 0 }}>
          <Mono size={11} color="var(--signal-55)">
            Back
          </Mono>
        </button>
        {quoting ? (
          <Mono size={11} color="var(--field-on-dark)">
            PRICING…
          </Mono>
        ) : null}
      </div>
    </div>
  );
}

// ── Step 3 — QUOTE (rendered HONESTLY) ───────────────────────────────────────────────────────────────────────
function QuoteStep({
  quote,
  booking,
  onBook,
  onEditLane,
}: {
  quote: QuoteResponse;
  booking: boolean;
  onBook: () => void;
  onEditLane: () => void;
}): React.JSX.Element {
  if (quote.status === "UNKNOWN") {
    // UNKNOWN — NO price, NO transit. The honest reason only (no price on air, REQ-004).
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div data-testid="intake-unknown" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <Mono size={10} color="var(--signal-55)">
            NO QUOTE
          </Mono>
          <Mono size={12} color="var(--field-on-dark)">
            {unknownReasonMessage(quote.reason)}
          </Mono>
        </div>
        <button type="button" onClick={onEditLane} style={{ background: "transparent", border: "none", cursor: "pointer", padding: 0, textAlign: "left" }}>
          <Mono size={11} color="var(--signal-55)">
            Edit Lane
          </Mono>
        </button>
      </div>
    );
  }
  return <PricedResult quote={quote} booking={booking} onBook={onBook} onEditLane={onEditLane} />;
}

function PricedResult({
  quote,
  booking,
  onBook,
  onEditLane,
}: {
  quote: PricedQuoteResponse;
  booking: boolean;
  onBook: () => void;
  onEditLane: () => void;
}): React.JSX.Element {
  const pending = isPendingApproval(quote);
  return (
    <div data-testid="intake-priced" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <Divider />
      <Mono size={10} color="var(--signal-55)">
        {pending ? "QUOTED SELL · PENDING APPROVAL" : "QUOTED SELL"}
      </Mono>
      <Display size="sub" color="var(--signal)">
        <span data-testid="intake-sell">{formatCents(quote.sell_cents)}</span>
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
        <span data-testid="intake-transit">{transitLine(quote)}</span>
      </Mono>

      {pending ? (
        // A below-floor / anomalous quote is NOT a firm sell — reflect the gate, offer no book affordance.
        <Mono size={10} color="var(--signal-55)">
          NEEDS INTERNAL APPROVAL BEFORE BOOKING
        </Mono>
      ) : (
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <Button type="button" onClick={onBook}>
            Book
          </Button>
          <button type="button" onClick={onEditLane} style={{ background: "transparent", border: "none", cursor: "pointer", padding: 0 }}>
            <Mono size={11} color="var(--signal-55)">
              Edit Lane
            </Mono>
          </button>
          {booking ? (
            <Mono size={11} color="var(--field-on-dark)">
              BOOKING…
            </Mono>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ── Step 4 — BOOKED (honest: requested, may hold — never "BOOKED") ───────────────────────────────────────────
function BookedStep({ onOpenBoard, onClose }: { onOpenBoard: () => void; onClose: () => void }): React.JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div data-testid="intake-status">
        <Mono size={12} color="var(--field-on-dark)">
          BOOKING REQUESTED — MAY HOLD ON CREDIT/CONTACT
        </Mono>
      </div>
      <Mono size={11} color="var(--signal-55)">
        THE BOOKING AGENT RUNS THE CREDIT + EVIDENCE GATES; A HOLD SURFACES IN THE APPROVALS QUEUE.
      </Mono>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <Button type="button" onClick={onOpenBoard}>
          Open on Board
        </Button>
        <button type="button" onClick={onClose} style={{ background: "transparent", border: "none", cursor: "pointer", padding: 0 }}>
          <Mono size={11} color="var(--signal-55)">
            Done
          </Mono>
        </button>
      </div>
    </div>
  );
}
