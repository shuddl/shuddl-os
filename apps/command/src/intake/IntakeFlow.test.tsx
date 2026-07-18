import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntakeFlow } from "./IntakeFlow.js";
import { ApiError } from "../lib/api.js";
import type { IntakeApi, QuoteResponse } from "./intake.js";

// WP-10 Task 11 (REQ-150) — the CSR net-new intake flow: customer → lane → shipment → quote → book, composing
// over the Task-6/8 seams. These tests drive the flow with a MOCKED api client and assert the HONEST renders:
//   · a PRICED quote shows the sell (integer cents → dollars) + the honest transit, then books → "BOOKING
//     REQUESTED — may hold" (NEVER "BOOKED"), and offers to open the shipment on the board;
//   · an UNKNOWN quote shows NO price and NO fabricated transit — just the honest reason;
//   · a below-floor quote shows PENDING APPROVAL with NO book button;
//   · a gate-block (403) on accept surfaces the REAL reason, not a false success;
//   · a mid-flow API error surfaces + allows retry WITHOUT re-creating parties/shipment (no double-create).

const PRICED: QuoteResponse = {
  status: "PRICED",
  sell_cents: 148000, // $1,480.00
  lines: [
    { kind: "freight", code: "LINEHAUL", amount_cents: 140000 },
    { kind: "fsc", code: "FSC", amount_cents: 8000 },
  ],
  transit: { status: "known", business_days: 3 },
  approval: { approval: "none", approvals_required: 0, rule: null, required_role: null },
  anomaly: null,
};

/** A router-style api double: resolves each seam by path, with per-path call counts via post.mock.calls. */
function mkApi(overrides?: {
  quote?: QuoteResponse;
  post?: (path: string, body?: unknown) => Promise<unknown>;
  get?: (path: string) => Promise<unknown>;
}): IntakeApi & { post: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> } {
  const quote = overrides?.quote ?? PRICED;
  const defaultPost = async (path: string, body?: unknown): Promise<unknown> => {
    if (path === "/v1/parties") {
      const b = body as { kind: string; name: string };
      return { id: `party_${b.kind}_${b.name.replace(/\s+/g, "")}`, created: true };
    }
    if (path === "/v1/shipments") return { shipment_id: "shp_intake_1" };
    if (path === "/v1/rate") return quote;
    if (path.endsWith("/accept-quote")) return { id: "evt-accepted" };
    throw new Error(`unexpected POST ${path}`);
  };
  const defaultGet = async (path: string): Promise<unknown> => {
    if (path.includes("/events")) {
      const sell = quote.status === "PRICED" ? quote.sell_cents : 0;
      return { events: [{ id: "evt-quote-1", kind: "quote.priced", payload: { sell } }] };
    }
    throw new Error(`unexpected GET ${path}`);
  };
  const post = vi.fn(overrides?.post ?? defaultPost);
  const get = vi.fn(overrides?.get ?? defaultGet);
  return { post, get } as IntakeApi & { post: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
}

function fillCustomer(): void {
  fireEvent.change(screen.getByPlaceholderText("Shipper name"), { target: { value: "Acme Shipper" } });
  fireEvent.change(screen.getByPlaceholderText("Consignee name"), { target: { value: "Beta Consignee" } });
  fireEvent.change(screen.getByPlaceholderText("Bill-to name"), { target: { value: "Acme Billing" } });
  fireEvent.change(screen.getByPlaceholderText("Bill-to email"), { target: { value: "ap@acme.example" } });
  fireEvent.click(screen.getByText("Continue"));
}

function fillLane(opts?: { weight?: string }): void {
  fireEvent.change(screen.getByPlaceholderText("Origin ZIP"), { target: { value: "07001" } });
  fireEvent.change(screen.getByPlaceholderText("Destination ZIP"), { target: { value: "30301" } });
  const weight = opts?.weight ?? "1200";
  if (weight !== "") fireEvent.change(screen.getByPlaceholderText("Weight (lb)"), { target: { value: weight } });
}

describe("IntakeFlow (REQ-150) — the CSR net-new intake", () => {
  afterEach(() => cleanup());

  it("HAPPY PATH: customer → lane → shipment → PRICED quote → accept → BOOKING REQUESTED (never BOOKED)", async () => {
    const api = mkApi();
    const onOpenShipment = vi.fn();
    render(<IntakeFlow api={api} onClose={vi.fn()} onOpenShipment={onOpenShipment} />);

    fillCustomer();
    fillLane();
    fireEvent.click(screen.getByText("Get Quote"));

    // The honest PRICED render: the sell from integer cents, the honest transit number (only because KNOWN).
    const sell = await screen.findByTestId("intake-sell");
    expect(sell.textContent).toBe("$1,480.00");
    expect(screen.getByTestId("intake-transit").textContent).toMatch(/3 BUSINESS DAYS/);

    // Parties (3), the shipment (1), and the rate (1) each fired via the real seams.
    expect(api.post.mock.calls.filter((c) => c[0] === "/v1/parties")).toHaveLength(3);
    expect(api.post.mock.calls.filter((c) => c[0] === "/v1/shipments")).toHaveLength(1);
    expect(api.post.mock.calls.filter((c) => c[0] === "/v1/rate")).toHaveLength(1);

    // Book the approvable quote → accept-quote with the resolved quote.priced id.
    fireEvent.click(screen.getByText("Book"));
    const status = await screen.findByTestId("intake-status");
    expect(status.textContent).toMatch(/BOOKING REQUESTED/);
    expect(status.textContent).toMatch(/MAY HOLD/i);
    expect(status.textContent).not.toMatch(/\bBOOKED\b/); // never a false "BOOKED"
    const acceptCall = api.post.mock.calls.find((c) => String(c[0]).endsWith("/accept-quote"));
    expect(acceptCall?.[1]).toEqual({ quote_event_id: "evt-quote-1" });

    // Offer to open the new shipment on the board (the LensPanel).
    fireEvent.click(screen.getByText("Open on Board"));
    expect(onOpenShipment).toHaveBeenCalledWith("shp_intake_1");
  });

  it("UNKNOWN quote renders NO price and NO fabricated transit — just the honest reason", async () => {
    const api = mkApi({ quote: { status: "UNKNOWN", reason: "missing_physics" } });
    render(<IntakeFlow api={api} onClose={vi.fn()} onOpenShipment={vi.fn()} />);

    fillCustomer();
    fillLane({ weight: "" }); // no weight ⇒ the server returns UNKNOWN missing_physics
    fireEvent.click(screen.getByText("Get Quote"));

    const unknown = await screen.findByTestId("intake-unknown");
    expect(unknown.textContent).toMatch(/weight and dimensions/i);
    expect(screen.queryByTestId("intake-sell")).toBeNull(); // no price on air
    expect(screen.queryByTestId("intake-transit")).toBeNull(); // no fabricated transit
    expect(screen.queryByText("Book")).toBeNull(); // nothing to book
  });

  it("a below-floor quote is PENDING APPROVAL — no firm sell to book, no Book button", async () => {
    const api = mkApi({
      quote: {
        status: "PRICED",
        sell_cents: 90000,
        transit: { status: "known", business_days: 2 },
        approval: { approval: "single", approvals_required: 1, rule: "below_floor", required_role: "ops_lead" },
        anomaly: null,
      },
    });
    render(<IntakeFlow api={api} onClose={vi.fn()} onOpenShipment={vi.fn()} />);

    fillCustomer();
    fillLane();
    fireEvent.click(screen.getByText("Get Quote"));

    expect(await screen.findByText(/PENDING APPROVAL/)).toBeTruthy();
    expect(screen.queryByText("Book")).toBeNull(); // a pending quote is not a bookable firm sell
  });

  it("an accept the gate BLOCKS (403) surfaces the real reason — not a false BOOKED", async () => {
    const api = mkApi({
      post: async (path: string, body?: unknown) => {
        if (path === "/v1/parties") return { id: `party_${(body as { name: string }).name}` };
        if (path === "/v1/shipments") return { shipment_id: "shp_intake_1" };
        if (path === "/v1/rate") return PRICED;
        if (path.endsWith("/accept-quote")) throw new ApiError("FORBIDDEN", 403, "BOOKING BLOCKED — CREDIT HOLD");
        throw new Error(`unexpected POST ${path}`);
      },
    });
    render(<IntakeFlow api={api} onClose={vi.fn()} onOpenShipment={vi.fn()} />);

    fillCustomer();
    fillLane();
    fireEvent.click(screen.getByText("Get Quote"));
    fireEvent.click(await screen.findByText("Book"));

    const err = await screen.findByTestId("intake-error");
    expect(err.textContent).toMatch(/FORBIDDEN/);
    expect(err.textContent).toMatch(/CREDIT HOLD/);
    expect(screen.queryByTestId("intake-status")).toBeNull(); // no false "booking requested"
    expect(screen.queryByText(/\bBOOKED\b/)).toBeNull();
  });

  it("a mid-flow error surfaces and retry does NOT double-create parties/shipment", async () => {
    let rateCalls = 0;
    const api = mkApi({
      post: async (path: string, body?: unknown) => {
        if (path === "/v1/parties") {
          const b = body as { kind: string; name: string };
          return { id: `party_${b.kind}_${b.name.replace(/\s+/g, "")}` };
        }
        if (path === "/v1/shipments") return { shipment_id: "shp_intake_1" };
        if (path === "/v1/rate") {
          rateCalls += 1;
          if (rateCalls === 1) throw new ApiError("BAD_RESPONSE", 500, "TRANSIENT");
          return PRICED;
        }
        throw new Error(`unexpected POST ${path}`);
      },
    });
    render(<IntakeFlow api={api} onClose={vi.fn()} onOpenShipment={vi.fn()} />);

    fillCustomer();
    fillLane();
    fireEvent.click(screen.getByText("Get Quote"));

    // The first attempt surfaces the honest error and keeps the captured state (still on the lane step).
    const err = await screen.findByTestId("intake-error");
    expect(err.textContent).toMatch(/BAD_RESPONSE|TRANSIENT/);

    // Retry — the parties + shipment were cached, so only the rate re-fires.
    fireEvent.click(screen.getByText("Get Quote"));
    await screen.findByTestId("intake-sell");

    expect(api.post.mock.calls.filter((c) => c[0] === "/v1/parties")).toHaveLength(3); // NOT 6
    expect(api.post.mock.calls.filter((c) => c[0] === "/v1/shipments")).toHaveLength(1); // NOT 2
    expect(api.post.mock.calls.filter((c) => c[0] === "/v1/rate")).toHaveLength(2); // the retry
  });

  it("Close invokes onClose (the CSR can abandon the flow)", () => {
    const onClose = vi.fn();
    render(<IntakeFlow api={mkApi()} onClose={onClose} onOpenShipment={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Close intake"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("blocks Continue until the required parties are named (honest validation, no phantom booking)", () => {
    render(<IntakeFlow api={mkApi()} onClose={vi.fn()} onOpenShipment={vi.fn()} />);
    fireEvent.click(screen.getByText("Continue")); // nothing filled
    expect(screen.getByTestId("intake-error").textContent).toMatch(/NAME/i);
    expect(screen.queryByPlaceholderText("Origin ZIP")).toBeNull(); // still on the customer step
  });

  it("waits for pure-helper mid-flow retry idempotency", async () => {
    // A GET-events resolve that returns no matching quote → the accept honestly reports nothing to accept.
    const api = mkApi({ get: async () => ({ events: [] }) });
    render(<IntakeFlow api={api} onClose={vi.fn()} onOpenShipment={vi.fn()} />);
    fillCustomer();
    fillLane();
    fireEvent.click(screen.getByText("Get Quote"));
    fireEvent.click(await screen.findByText("Book"));
    await waitFor(() => expect(screen.getByTestId("intake-error").textContent).toMatch(/NO PRICED QUOTE/));
  });
});
