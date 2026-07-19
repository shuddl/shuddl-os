import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../lib/api.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/api.js")>("../lib/api.js");
  return { ...actual, get: vi.fn(), post: vi.fn() };
});
import { StatementView } from "./StatementView.js";
import { ApiError, get, post } from "../lib/api.js";

const mockGet = get as unknown as ReturnType<typeof vi.fn>;
const mockPost = post as unknown as ReturnType<typeof vi.fn>;

const DAY = 86_400_000;
const NOW = 1_000 * DAY;

// The party's own invoices (party-lens columns only; a buggy leak of division/gl_map must NOT render).
const INVOICES = [
  { id: "INV-A", party_id: "party-9", shipment_ids: '["SHP-1"]', total_cents: 100_000, status: "issued", due_ts: NOW - 10 * DAY },
  { id: "INV-B", party_id: "party-9", shipment_ids: "[]", total_cents: 50_000, status: "issued", due_ts: NOW + 5 * DAY },
  { id: "INV-C", party_id: "party-9", shipment_ids: "[]", total_cents: 30_000, status: "issued", due_ts: NOW - 45 * DAY },
  { id: "INV-D", party_id: "party-9", shipment_ids: "[]", total_cents: 20_000, status: "issued", due_ts: NOW - 90 * DAY },
  { id: "INV-N", party_id: "party-9", shipment_ids: "[]", total_cents: 70_000, status: "issued", due_ts: null },
  { id: "INV-P", party_id: "party-9", shipment_ids: "[]", total_cents: 999_999, status: "paid", due_ts: NOW - 100 * DAY },
];

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
});
afterEach(() => cleanup());

describe("StatementView (REQ-090)", () => {
  it("renders the aging summary in integer cents, keyed on due_ts vs now", async () => {
    mockGet.mockResolvedValue({ invoices: INVOICES });
    render(<StatementView onAuthError={vi.fn()} now={NOW} />);

    await screen.findByTestId("aging-current");
    expect(screen.getByTestId("aging-current").textContent ?? "").toMatch(/\$500\.00/);
    expect(screen.getByTestId("aging-1-30").textContent ?? "").toMatch(/\$1,000\.00/);
    expect(screen.getByTestId("aging-31-60").textContent ?? "").toMatch(/\$300\.00/);
    expect(screen.getByTestId("aging-over-60").textContent ?? "").toMatch(/\$200\.00/);
    expect(screen.getByTestId("aging-no-terms").textContent ?? "").toMatch(/\$700\.00/);
    expect(mockGet).toHaveBeenCalledWith("/v1/invoices");
  });

  it("shows an honest paid-vs-open balance (a paid invoice never counts toward owed)", async () => {
    mockGet.mockResolvedValue({ invoices: INVOICES });
    render(<StatementView onAuthError={vi.fn()} now={NOW} />);

    // total owed = the sum of OPEN (issued) invoices, integer cents = $2,700.00
    expect((await screen.findByTestId("statement-owed")).textContent ?? "").toMatch(/\$2,700\.00/);
    // paid total is the settled invoice only ($9,999.99); it is NOT added to the balance owed
    expect(screen.getByTestId("statement-paid").textContent ?? "").toMatch(/\$9,999\.99/);
    expect(screen.getByTestId("statement-owed").textContent ?? "").not.toMatch(/\$12,699\.99/);
    // the paid invoice renders with a PAID marker in its own list
    expect(screen.getByTestId("invoice-INV-P").textContent ?? "").toMatch(/PAID/);
  });

  it("a NULL-due invoice shows NO TERMS, never a fabricated overdue", async () => {
    mockGet.mockResolvedValue({
      invoices: [{ id: "INV-N", party_id: "party-9", shipment_ids: "[]", total_cents: 70_000, status: "issued", due_ts: null }],
    });
    render(<StatementView onAuthError={vi.fn()} now={NOW} />);

    const row = await screen.findByTestId("invoice-INV-N");
    expect(row.textContent ?? "").toMatch(/NO TERMS/);
    expect(row.textContent ?? "").not.toMatch(/OVERDUE/);
    expect(row.textContent ?? "").not.toMatch(/PAST DUE/);
  });

  it("the pay affordance is informational — no settle/Stripe call ever fires", async () => {
    mockGet.mockResolvedValue({ invoices: INVOICES });
    render(<StatementView onAuthError={vi.fn()} now={NOW} />);

    await screen.findByTestId("statement-owed");
    // the remit / how-to-pay affordance is present and clearly labelled as affordance-only
    expect(screen.getByText(/how to pay/i)).toBeTruthy();
    expect(screen.getByText(/no payment is taken here/i)).toBeTruthy();

    // clicking the pay CTA reveals remit info but executes NOTHING — no POST/settle, no Stripe
    fireEvent.click(screen.getByRole("button", { name: /remit payment/i }));
    expect(await screen.findByTestId("statement-remit-detail")).toBeTruthy();
    expect(mockPost).not.toHaveBeenCalled();
    expect(screen.queryByText(/stripe/i)).toBeNull();
  });

  it("NEVER renders margin internals even if a buggy server leaks them (division / gl_map)", async () => {
    mockGet.mockResolvedValue({
      invoices: [
        { id: "INV-A", party_id: "party-9", shipment_ids: "[]", total_cents: 100_000, status: "issued", due_ts: null, division: "SECRET-DIV", gl_map: "4000-REV" },
      ],
    });
    render(<StatementView onAuthError={vi.fn()} now={NOW} />);
    await screen.findByTestId("invoice-INV-A");
    expect(screen.queryByText(/SECRET-DIV/)).toBeNull();
    expect(screen.queryByText(/4000-REV/)).toBeNull();
  });

  it("an empty account renders a clean, zeroed statement", async () => {
    mockGet.mockResolvedValue({ invoices: [] });
    render(<StatementView onAuthError={vi.fn()} now={NOW} />);
    expect((await screen.findByTestId("statement-owed")).textContent ?? "").toMatch(/\$0\.00/);
  });

  it("a 401 drops the session (onAuthError)", async () => {
    const onAuthError = vi.fn();
    mockGet.mockRejectedValueOnce(new ApiError("UNAUTHORIZED", 401, "NO SESSION"));
    render(<StatementView onAuthError={onAuthError} now={NOW} />);
    await waitFor(() => expect(onAuthError).toHaveBeenCalledTimes(1));
  });
});
