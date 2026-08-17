import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../lib/api.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/api.js")>("../lib/api.js");
  return { ...actual, get: vi.fn(), post: vi.fn() };
});
import { GuestQuote } from "./GuestQuote.js";
import { ApiError, post } from "../lib/api.js";

const mockPost = post as unknown as ReturnType<typeof vi.fn>;

function fillLane(): void {
  fireEvent.change(screen.getByPlaceholderText("Origin ZIP"), { target: { value: "80202" } });
  fireEvent.change(screen.getByPlaceholderText("Destination ZIP"), { target: { value: "60601" } });
  fireEvent.change(screen.getByPlaceholderText("Weight (lb)"), { target: { value: "1200" } });
}
function clickGetQuote(): void {
  fireEvent.click(screen.getByRole("button", { name: /get quote/i }));
}

beforeEach(() => mockPost.mockReset());
afterEach(() => cleanup());

// REQ-051 — the PUBLIC guest quote. NO session. Guest may QUOTE, never BOOK (structural). It renders the
// result HONESTLY: a PRICED sell + margin-free lines + honest transit only when KNOWN; UNKNOWN → the honest
// reason, no price. There is NO booking affordance — only a "create an account" CTA.

describe("GuestQuote public page (REQ-051)", () => {
  it("PRICED renders the sell (integer cents), margin-free lines, the honest transit, and a create-account CTA — no booking", async () => {
    mockPost.mockResolvedValue({
      status: "PRICED",
      sell_cents: 148000,
      lines: [{ kind: "freight", code: "freight", amount_cents: 140000 }],
      transit: { status: "known", business_days: 5 },
    });
    render(<GuestQuote />);
    fillLane();
    clickGetQuote();

    expect((await screen.findByTestId("guest-sell")).textContent).toBe("$1,480.00");
    expect(screen.getByTestId("guest-transit").textContent ?? "").toMatch(/5 BUSINESS DAYS/);
    // the guest can never book — only a CTA to create an account
    expect(screen.getByTestId("guest-cta").textContent ?? "").toMatch(/create an account/i);
    expect(screen.queryByRole("button", { name: /accept|book/i })).toBeNull();
    // posts to the PUBLIC quote route with NO shipment_id (a guest has nothing to book against)
    expect(mockPost).toHaveBeenCalledWith("/pub/quote", expect.objectContaining({ origin_zip: "80202", weight_lb: 1200 }));
    expect(mockPost.mock.calls[0]?.[1]).not.toHaveProperty("shipment_id");
  });

  it("an 'unavailable' transit renders NO fabricated number", async () => {
    mockPost.mockResolvedValue({ status: "PRICED", sell_cents: 90000, transit: { status: "unavailable" } });
    render(<GuestQuote />);
    fillLane();
    clickGetQuote();

    const transit = await screen.findByTestId("guest-transit");
    expect(transit.textContent ?? "").toMatch(/transit unavailable/i);
    expect(transit.textContent ?? "").not.toMatch(/\d/);
  });

  it("UNKNOWN shows NO price and the honest reason (no price on air)", async () => {
    mockPost.mockResolvedValue({ status: "UNKNOWN", reason: "missing_physics" });
    render(<GuestQuote />);
    fillLane();
    clickGetQuote();

    const unknown = await screen.findByTestId("guest-unknown");
    expect(unknown.textContent ?? "").toMatch(/weight and dimensions/i);
    expect(screen.queryByTestId("guest-sell")).toBeNull();
    expect(unknown.textContent ?? "").not.toMatch(/\d/);
  });

  it("renders (and quotes) with NO session token present", () => {
    // No token was ever set in localStorage — the page mounts and works regardless (public surface).
    expect(window.localStorage.getItem("shuddl.portal.token")).toBeNull();
    render(<GuestQuote />);
    expect(screen.getByPlaceholderText("Origin ZIP")).toBeTruthy();
  });

  it("§1691 a FAILED quote shows the reason — the public page never goes quiet on a stranger", async () => {
    // The one surface with no session and no operator: acceptance demo 2's stranger. If the request fails and
    // nothing renders, the page simply stops responding to the button — indistinguishable from a broken app.
    // Measured before writing: making `error !== null` unreachable left portal 110/110 GREEN.
    mockPost.mockRejectedValueOnce(new ApiError("INTERNAL", 500, "QUOTE SERVICE UNAVAILABLE"));
    render(<GuestQuote />);
    fillLane();
    clickGetQuote();

    await screen.findByText("QUOTE SERVICE UNAVAILABLE");
    expect(screen.queryByTestId("guest-sell"), "no price may render beside a failure").toBeNull();
  });

  it("§1691 a failing SECOND quote clears the first price — no stranded number the system no longer stands behind", async () => {
    // The sharper case, and the reason the handler calls setQuote(null) BEFORE awaiting: a guest quotes, gets
    // $1,480.00, changes the lane, and the re-quote fails. If the old sell survives, the page shows a price
    // for a lane it was not quoted on — a price on air (REQ-004) produced by the UI rather than the rater.
    mockPost.mockResolvedValueOnce({
      status: "PRICED",
      sell_cents: 148000,
      lines: [{ kind: "freight", code: "freight", amount_cents: 140000 }],
      transit: { status: "known", business_days: 5 },
    });
    render(<GuestQuote />);
    fillLane();
    clickGetQuote();
    expect((await screen.findByTestId("guest-sell")).textContent).toBe("$1,480.00");

    mockPost.mockRejectedValueOnce(new ApiError("INTERNAL", 500, "RATER DOWN"));
    fireEvent.change(screen.getByPlaceholderText("Destination ZIP"), { target: { value: "97203" } });
    clickGetQuote();

    await screen.findByText("RATER DOWN");
    await waitFor(() =>
      expect(screen.queryByTestId("guest-sell"), "the previous lane's price must not survive a failed re-quote").toBeNull(),
    );
  });
});
