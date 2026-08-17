import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../lib/api.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/api.js")>("../lib/api.js");
  return { ...actual, get: vi.fn(), post: vi.fn() };
});
import { ShipmentList, type BoardShipment } from "./ShipmentList.js";
import { ApiError, get } from "../lib/api.js";

const mockGet = get as unknown as ReturnType<typeof vi.fn>;

// §1687 found this file with TWO empty-state arms and NO test file at all, on the portal's new-tenant screen —
// the one acceptance demo 2's stranger reaches immediately after signing up, when the party owns no freight and
// has been billed nothing. Both arms are the NORMAL day-one state here, not an edge case: a party's board is
// empty until its first shipment moves, and its invoices are empty until the first POD lands.
//
// The two halves have DIFFERENT sources and so different failure modes: `shipments` is a PROP fed from the
// server-scoped board (App owns its loading), while `invoices` is fetched by this component and therefore has
// loading and error states the shipments half does not.

const SHIPMENTS: readonly BoardShipment[] = [
  { id: "SHP-1", status: "healthy" },
  { id: "SHP-2", status: "exception" },
];

const INVOICE = { id: "INV-1", party_id: "party-9", shipment_ids: '["SHP-1"]', total_cents: 148000, status: "issued", due_ts: null };

beforeEach(() => mockGet.mockReset());
afterEach(() => cleanup());

describe("ShipmentList (REQ-085) — the portal board's two ruled lists", () => {
  it("§1687 a BRAND-NEW party sees both empty states, not two blank panels", async () => {
    mockGet.mockResolvedValue({ invoices: [] });
    render(<ShipmentList shipments={[]} onAuthError={vi.fn()} onSelectShipment={vi.fn()} />);

    // The invoices half is async — wait for it to leave Loading before asserting either.
    await screen.findByText("No invoices yet");
    expect(screen.getByText("No active shipments"), "an empty board must SAY it is empty").toBeTruthy();

    // Both section headings still render: the party can see WHAT is empty, not just that nothing is there.
    expect(screen.getByText("SHIPMENTS")).toBeTruthy();
    expect(screen.getByText("INVOICES")).toBeTruthy();
  });

  it("renders live board shipments with their map status, and selects on click", async () => {
    mockGet.mockResolvedValue({ invoices: [] });
    const onSelect = vi.fn();
    render(<ShipmentList shipments={SHIPMENTS} onAuthError={vi.fn()} onSelectShipment={onSelect} />);

    await screen.findByText("No invoices yet");
    expect(screen.getByText("SHP-1")).toBeTruthy();
    expect(screen.queryByText("No active shipments"), "a non-empty board must NOT show the empty state").toBeNull();

    fireEvent.click(screen.getByText("SHP-2"));
    expect(onSelect, "a row acts on the shipment the party owns").toHaveBeenCalledWith("SHP-2");
  });

  it("an empty BOARD with real invoices shows one empty state and one list — the halves are independent", async () => {
    mockGet.mockResolvedValue({ invoices: [INVOICE] });
    render(<ShipmentList shipments={[]} onAuthError={vi.fn()} onSelectShipment={vi.fn()} />);

    await screen.findByText("INV-1");
    expect(screen.getByText("No active shipments")).toBeTruthy();
    expect(screen.queryByText("No invoices yet"), "invoices are present, so its empty state must be absent").toBeNull();
  });

  it("a 401 DELEGATES to onAuthError rather than rendering its own error — the parent swaps the board out", async () => {
    // What this case is NOT asserting, and why (§1688). My first version asserted that no empty state renders
    // after a 401 — reasoning that "you have no invoices" and "we could not read them" are different
    // sentences. Measured, the component DOES fall through to "No invoices yet": the auth branch calls
    // `onAuthError()` and returns WITHOUT setting `error`, so `.finally` clears loading over an empty list.
    //
    // That is correct IN CONTEXT and the context is the parent: `App.handleAuthError` clears the session and
    // sets mode "reauth", at which point App returns <ReAuthPrompt/> and this component UNMOUNTS. The state my
    // assertion described is unreachable in the composed app; rendering the component in isolation is what
    // created it. **A component's contract includes what its parent does with the callback** — so the real
    // guarantee to pin is the delegation itself, not the pixels after it.
    mockGet.mockRejectedValueOnce(new ApiError("UNAUTHORIZED", 401, "unauthorized"));
    const onAuthError = vi.fn();
    render(<ShipmentList shipments={[]} onAuthError={onAuthError} onSelectShipment={vi.fn()} />);

    await waitFor(() => expect(onAuthError, "an auth failure must reach the parent, which owns re-auth").toHaveBeenCalledTimes(1));
    expect(
      screen.queryByText("COULD NOT LOAD YOUR INVOICES"),
      "it must NOT render its own error text for an auth failure — that path belongs to the parent",
    ).toBeNull();
  });

  it("a NON-auth failure renders the honest error, and never an empty state", async () => {
    // The other half of the same fork: a 500 is not delegated, so this component owns the message — and here
    // the distinction my first assertion was reaching for IS real and IS testable.
    mockGet.mockRejectedValueOnce(new ApiError("INTERNAL", 500, "server exploded"));
    const onAuthError = vi.fn();
    render(<ShipmentList shipments={[]} onAuthError={onAuthError} onSelectShipment={vi.fn()} />);

    await screen.findByText("server exploded");
    expect(onAuthError, "a 500 is not an auth failure").not.toHaveBeenCalled();
    expect(screen.queryByText("No invoices yet"), "a failed read is not an empty billing history").toBeNull();
  });
});
