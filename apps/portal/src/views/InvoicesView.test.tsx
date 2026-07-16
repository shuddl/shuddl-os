import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("../lib/api.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/api.js")>("../lib/api.js");
  return { ...actual, get: vi.fn(), post: vi.fn() };
});
import { InvoicesView } from "./InvoicesView.js";
import { ApiError, get } from "../lib/api.js";

const mockGet = get as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => mockGet.mockReset());
afterEach(() => cleanup());

describe("InvoicesView (REQ-085)", () => {
  it("renders the party's invoices (money from integer cents) and a summary total", async () => {
    mockGet.mockResolvedValue({
      invoices: [
        { id: "INV-1", party_id: "party-9", shipment_ids: '["SHP-1"]', total_cents: 148000, status: "issued", due_ts: null },
        { id: "INV-2", party_id: "party-9", shipment_ids: '["SHP-2"]', total_cents: 52000, status: "paid", due_ts: null },
      ],
    });
    render(<InvoicesView onAuthError={vi.fn()} />);

    await screen.findByText("INV-1");
    expect(screen.getByText(/\$1,480\.00/)).toBeTruthy();
    expect(screen.getByText(/\$520\.00/)).toBeTruthy();
    expect(screen.getByText(/ISSUED/)).toBeTruthy();
    expect(screen.getByText(/PAID/)).toBeTruthy();
    // the summary total is the integer-cents sum ($2,000.00)
    expect(screen.getByTestId("invoices-total").textContent ?? "").toMatch(/\$2,000\.00/);
    expect(mockGet).toHaveBeenCalledWith("/v1/invoices");
  });

  it("NEVER renders margin internals even if a buggy server leaks them (division / gl_map)", async () => {
    mockGet.mockResolvedValue({
      invoices: [
        {
          id: "INV-1",
          party_id: "party-9",
          shipment_ids: "[]",
          total_cents: 148000,
          status: "issued",
          due_ts: null,
          division: "SECRET-DIVISION",
          gl_map: "4000-REVENUE",
        },
      ],
    });
    render(<InvoicesView onAuthError={vi.fn()} />);

    await screen.findByText("INV-1");
    expect(screen.queryByText(/SECRET-DIVISION/)).toBeNull();
    expect(screen.queryByText(/4000-REVENUE/)).toBeNull();
  });

  it("an empty list renders a clean empty state", async () => {
    mockGet.mockResolvedValue({ invoices: [] });
    render(<InvoicesView onAuthError={vi.fn()} />);
    expect((await screen.findByText(/no invoices/i)).textContent).toBeTruthy();
  });

  it("a 401 drops the session (onAuthError)", async () => {
    const onAuthError = vi.fn();
    mockGet.mockRejectedValueOnce(new ApiError("UNAUTHORIZED", 401, "NO SESSION"));
    render(<InvoicesView onAuthError={onAuthError} />);
    await waitFor(() => expect(onAuthError).toHaveBeenCalledTimes(1));
  });
});
