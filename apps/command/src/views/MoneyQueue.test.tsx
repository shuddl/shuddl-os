import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("../lib/api.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/api.js")>("../lib/api.js");
  return { ...actual, get: vi.fn(), post: vi.fn() };
});
import { MoneyQueue } from "./MoneyQueue.js";
import { ApiError, get } from "../lib/api.js";

const mockGet = get as unknown as ReturnType<typeof vi.fn>;
const DAY_MS = 86_400_000;
const NOW = 1_000 * DAY_MS;

beforeEach(() => mockGet.mockReset());
afterEach(() => cleanup());

describe("MoneyQueue (REQ-082/083)", () => {
  it("shows the unbilled-PODs count (from the KPI tile) + open-AR aging in integer cents; a PAID invoice is excluded", async () => {
    mockGet.mockResolvedValue({
      invoices: [
        { id: "INV-1", total_cents: 100000, status: "issued", due_ts: NOW - 10 * DAY_MS }, // 10 days past due → 1–30D
        { id: "INV-2", total_cents: 50000, status: "issued", due_ts: NOW + 5 * DAY_MS }, // not due yet → CURRENT
        { id: "INV-3", total_cents: 999999, status: "paid", due_ts: NOW - 100 * DAY_MS }, // settled → not aging
      ],
    });
    render(<MoneyQueue unbilled={3} onAuthError={vi.fn()} now={NOW} />);

    // unbilled PODs (needing an invoice) straight from the tile
    expect((await screen.findByTestId("money-unbilled")).textContent).toBe("3");
    // aging in integer cents
    expect(screen.getByText("$1,000.00")).toBeTruthy(); // 1–30D
    expect(screen.getByText("$500.00")).toBeTruthy(); // CURRENT
    expect(screen.getByText("1–30D")).toBeTruthy();
    expect(screen.getByText("CURRENT")).toBeTruthy();
    // the settled invoice is NOT counted as open AR
    expect(screen.queryByText("$9,999.99")).toBeNull();
    expect(mockGet).toHaveBeenCalledWith("/v1/invoices");
  });

  it("§1689 a FAILED AR read shows the error — never 'NO OPEN AR', which means the opposite", async () => {
    // The money view's three arms are loading → error → empty → list, and only the first three are one
    // keystroke apart. If the error arm is skipped, a failed read falls through to the EMPTY arm and the
    // queue reads "NO OPEN AR" — i.e. *nothing to collect* — to an operator whose AR was simply unreadable.
    // Measured before writing this: making `error !== null` unreachable left command 102/102 GREEN.
    mockGet.mockRejectedValueOnce(new ApiError("INTERNAL", 500, "AR READ FAILED"));
    render(<MoneyQueue unbilled={3} onAuthError={vi.fn()} now={NOW} />);

    await screen.findByText("AR READ FAILED");
    expect(
      screen.queryByText(/NO OPEN AR/),
      "an unreadable ledger is not an empty one — the money queue must never say there is nothing to collect",
    ).toBeNull();
  });

  it("§1689 a 401 DELEGATES to onAuthError and renders no local error text", async () => {
    // The other fork: an auth failure belongs to the shell (it clears the session and re-prompts), so this
    // view must hand it up rather than paint its own message. §1688 established the rule — a component's
    // contract includes what its parent does with the callback.
    mockGet.mockRejectedValueOnce(new ApiError("UNAUTHORIZED", 401, "NO SESSION"));
    const onAuthError = vi.fn();
    render(<MoneyQueue unbilled={3} onAuthError={onAuthError} now={NOW} />);

    await waitFor(() => expect(onAuthError).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("NO SESSION"), "the auth path is the shell's, not this view's").toBeNull();
  });

  it("an UNKNOWN unbilled shows an honest em-dash (never a fabricated number)", async () => {
    mockGet.mockResolvedValue({ invoices: [] });
    render(<MoneyQueue unbilled="UNKNOWN" onAuthError={vi.fn()} now={NOW} />);
    expect((await screen.findByTestId("money-unbilled")).textContent).toBe("—");
    expect(screen.getByText(/NO OPEN AR/)).toBeTruthy();
  });
});
