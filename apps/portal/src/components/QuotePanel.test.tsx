import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QuotePanel } from "./QuotePanel.js";

// Mock the api client: get/post become spies, but ApiError stays the REAL class (so isAuthError works and
// `instanceof ApiError` holds in the component). No test ever hits a real network. jest-dom is NOT a
// dependency here, so assertions use plain textContent / null checks (no toHaveTextContent / toBeInTheDocument).
vi.mock("../lib/api.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/api.js")>("../lib/api.js");
  return { ...actual, get: vi.fn(), post: vi.fn() };
});
import { ApiError, get, post } from "../lib/api.js";

const mockGet = get as unknown as ReturnType<typeof vi.fn>;
const mockPost = post as unknown as ReturnType<typeof vi.fn>;

function fillLane(): void {
  fireEvent.change(screen.getByPlaceholderText("Origin ZIP"), { target: { value: "80202" } });
  fireEvent.change(screen.getByPlaceholderText("Destination ZIP"), { target: { value: "60601" } });
  fireEvent.change(screen.getByPlaceholderText("Weight (lb)"), { target: { value: "1200" } });
}

function clickGetQuote(): void {
  fireEvent.click(screen.getByRole("button", { name: /get quote/i }));
}

const PRICED_KNOWN = {
  status: "PRICED" as const,
  sell_cents: 148000,
  lines: [{ kind: "freight", code: "freight", amount_cents: 140000 }],
  transit: { status: "known" as const, business_days: 5 },
  approval: { approval: "none", approvals_required: 0, rule: null, required_role: null },
  anomaly: null,
};

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
});
afterEach(() => cleanup());

describe("QuotePanel (REQ-085/051)", () => {
  it("PRICED renders the sell (integer cents → dollars) and the honest transit window", async () => {
    mockPost.mockResolvedValue(PRICED_KNOWN);
    render(<QuotePanel shipmentId="SHP-1" onAuthError={vi.fn()} />);

    fillLane();
    clickGetQuote();

    const sell = await screen.findByTestId("quote-sell");
    expect(sell.textContent).toBe("$1,480.00");
    expect(screen.getByTestId("quote-transit").textContent ?? "").toMatch(/5 BUSINESS DAYS/);
    // an owned-shipment quote used the authed lens-scoped rate route, carrying the shipment id
    expect(mockPost).toHaveBeenCalledWith("/v1/rate", expect.objectContaining({ shipment_id: "SHP-1", weight_lb: 1200 }));
  });

  it("a net-new lane (no shipment) previews via /pub/quote and offers NO booking", async () => {
    mockPost.mockResolvedValue({ status: "PRICED", sell_cents: 90000, transit: { status: "unavailable" } });
    render(<QuotePanel onAuthError={vi.fn()} />);

    fillLane();
    clickGetQuote();

    await screen.findByTestId("quote-sell");
    expect(mockPost).toHaveBeenCalledWith("/pub/quote", expect.objectContaining({ origin_zip: "80202" }));
    expect(mockPost.mock.calls[0]?.[1]).not.toHaveProperty("shipment_id");
    expect(screen.queryByRole("button", { name: /accept/i })).toBeNull();
    expect(screen.getByText(/preview only/i)).toBeTruthy();
  });

  it("UNKNOWN shows NO price and NO fabricated transit — just the honest reason", async () => {
    mockPost.mockResolvedValue({ status: "UNKNOWN", reason: "missing_physics" });
    render(<QuotePanel shipmentId="SHP-1" onAuthError={vi.fn()} />);

    fillLane();
    clickGetQuote();

    const unknown = await screen.findByTestId("quote-unknown");
    expect(unknown.textContent ?? "").toMatch(/weight and dimensions/i);
    expect(screen.queryByTestId("quote-sell")).toBeNull();
    expect(screen.queryByTestId("quote-transit")).toBeNull();
    expect(unknown.textContent ?? "").not.toMatch(/\d/); // no number is ever fabricated
  });

  it("a transit.status:'unavailable' renders NO number", async () => {
    mockPost.mockResolvedValue({ ...PRICED_KNOWN, transit: { status: "unavailable" } });
    render(<QuotePanel shipmentId="SHP-1" onAuthError={vi.fn()} />);

    fillLane();
    clickGetQuote();

    const transit = await screen.findByTestId("quote-transit");
    expect(transit.textContent ?? "").toMatch(/transit unavailable/i);
    expect(transit.textContent ?? "").not.toMatch(/\d/);
  });

  it("a below-floor / pending-approval quote is NOT presented as a firm, bookable sell", async () => {
    mockPost.mockResolvedValue({
      ...PRICED_KNOWN,
      approval: { approval: "single", approvals_required: 1, rule: "below_target_or", required_role: "ops" },
    });
    render(<QuotePanel shipmentId="SHP-1" onAuthError={vi.fn()} />);

    fillLane();
    clickGetQuote();

    expect((await screen.findByTestId("quote-priced")).textContent ?? "").toMatch(/pending approval/i);
    expect(screen.getByText(/needs internal approval/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /accept/i })).toBeNull();
  });

  it("Accept resolves the shown quote's event id and calls accept-quote (party accepts, never books directly)", async () => {
    mockPost.mockImplementation((path: string) => {
      if (path === "/v1/rate") return Promise.resolve(PRICED_KNOWN);
      if (path.endsWith("/accept-quote")) return Promise.resolve({ id: "e-accepted" });
      return Promise.reject(new Error(`unexpected POST ${path}`));
    });
    mockGet.mockResolvedValue({
      events: [
        { id: "q-old", kind: "quote.priced", payload: { sell: 100000 } },
        { id: "q-shown", kind: "quote.priced", payload: { sell: 148000 } },
      ],
    });

    render(<QuotePanel shipmentId="SHP-1" onAuthError={vi.fn()} />);
    fillLane();
    clickGetQuote();
    await screen.findByTestId("quote-sell");

    fireEvent.click(screen.getByRole("button", { name: /accept \/ book/i }));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith("/v1/shipments/SHP-1/accept-quote", { quote_event_id: "q-shown" }),
    );
    // reads the shipment's own lens feed to resolve the quote id
    expect(mockGet).toHaveBeenCalledWith(expect.stringContaining("/v1/shipments/SHP-1/events"));
    // never claims "booked" — the Booking agent gate runs async and may HOLD
    expect((await screen.findByTestId("accept-status")).textContent ?? "").toMatch(/booking requested/i);
  });

  it("a 401 from the quote call drops the session (onAuthError)", async () => {
    const onAuthError = vi.fn();
    mockPost.mockRejectedValue(new ApiError("UNAUTHORIZED", 401, "NO SESSION"));
    render(<QuotePanel shipmentId="SHP-1" onAuthError={onAuthError} />);

    fillLane();
    clickGetQuote();

    await waitFor(() => expect(onAuthError).toHaveBeenCalledTimes(1));
  });
});
