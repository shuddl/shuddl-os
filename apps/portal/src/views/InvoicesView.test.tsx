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

  // ── §781: the response is PARSED, so a malformed body is a refusal on screen, never a white screen ──
  //
  // These three fail without `fetchPartyInvoices`'s Zod parse. Before it, the components asserted
  // `get<{ invoices: InvoiceRow[] }>(...)` — a compile-time claim over an unchecked body — and set state to
  // whatever arrived. Measured in a real browser: `PAGEERROR: Cannot read properties of undefined (reading
  // 'length')` and an empty `<body>`. The `.catch` below each fetch could never help, because the failure is
  // in the NEXT RENDER, not in the promise.
  it("a body with NO `invoices` key renders the error state — it does NOT crash the view (§781)", async () => {
    mockGet.mockResolvedValue({ board: [] }); // the wrong endpoint's shape — exactly what the e2e mock sent
    render(<InvoicesView onAuthError={vi.fn()} />);
    // The point is that SOMETHING honest renders. Unparsed, `invoices` became undefined and `.length` threw.
    await waitFor(() => expect(screen.getByText(/COULD NOT LOAD INVOICES/i)).toBeTruthy());
  });

  it("a row missing total_cents is REFUSED — never a NaN total (§781)", async () => {
    // The worse half of the defect: `invoices.reduce((s, inv) => s + inv.total_cents, 0)` over a row with no
    // total renders NaN as a billing total — money on screen that is not money, with no error state at all.
    mockGet.mockResolvedValue({ invoices: [{ id: "INV-1", party_id: "party-9", status: "issued", due_ts: null }] });
    render(<InvoicesView onAuthError={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/COULD NOT LOAD INVOICES/i)).toBeTruthy());
    expect(screen.queryByText(/NaN/)).toBeNull();
  });

  it("an unknown key is STRIPPED rather than rejected — the allowlist, enforced (§781)", async () => {
    // Non-strict on purpose (unlike the board seam): the documented intent is that a leaked internal "can
    // never render", which stripping delivers. `.strict()` would instead blank the page whenever the server
    // adds a harmless field. This pins that choice — a valid row plus an extra key still renders.
    mockGet.mockResolvedValue({
      invoices: [{ id: "INV-9", party_id: "party-9", shipment_ids: "[]", total_cents: 1000, status: "issued", due_ts: null, some_future_field: "x" }],
    });
    render(<InvoicesView onAuthError={vi.fn()} />);
    await screen.findByText("INV-9");
    expect(screen.getByTestId("invoices-total").textContent ?? "").toMatch(/\$10\.00/);
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
