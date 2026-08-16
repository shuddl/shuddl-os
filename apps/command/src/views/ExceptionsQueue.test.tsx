import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../lib/api.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/api.js")>("../lib/api.js");
  return { ...actual, get: vi.fn(), post: vi.fn() };
});
import { ExceptionsQueue } from "./ExceptionsQueue.js";
import { ApiError, get } from "../lib/api.js";

const mockGet = get as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => mockGet.mockReset());
afterEach(() => cleanup());

describe("ExceptionsQueue (REQ-082)", () => {
  it("lists open exceptions (shipment, reason_code, ts) and reads the durable open queue", async () => {
    mockGet.mockResolvedValue({
      exceptions: [
        { shipment_id: "shp-9", exception_event_id: "evt-x", kind: "exception.raised", reason_code: "DETENTION", ts: 1_720_000_000_000, open: true },
      ],
    });
    render(<ExceptionsQueue onAuthError={vi.fn()} onOpenShipment={vi.fn()} />);

    expect(await screen.findByText("shp-9")).toBeTruthy();
    expect(screen.getByText("DETENTION")).toBeTruthy();
    expect(mockGet).toHaveBeenCalledWith("/v1/exceptions?status=open");
  });

  it("clicking an exception NAVIGATES to the shipment (opens its lens); it is READ-ONLY (no resolve action)", async () => {
    const onOpenShipment = vi.fn();
    mockGet.mockResolvedValue({
      exceptions: [
        { shipment_id: "shp-9", exception_event_id: "evt-x", kind: "osd.captured", reason_code: null, ts: 1_720_000_000_000, open: true },
      ],
    });
    render(<ExceptionsQueue onAuthError={vi.fn()} onOpenShipment={onOpenShipment} />);

    fireEvent.click(await screen.findByText("shp-9"));
    expect(onOpenShipment).toHaveBeenCalledWith("shp-9");
    // Resolution is WP-11 — no resolve/close affordance on this surface.
    expect(screen.queryByText(/RESOLVE/i)).toBeNull();
    // reason_code absent falls back to the kind (honest, never a fabricated code)
    expect(screen.getByText("osd.captured")).toBeTruthy();
  });

  it("an empty queue renders an honest empty state", async () => {
    mockGet.mockResolvedValue({ exceptions: [] });
    render(<ExceptionsQueue onAuthError={vi.fn()} onOpenShipment={vi.fn()} />);
    expect(await screen.findByText(/NO OPEN EXCEPTIONS/)).toBeTruthy();
  });

  // §1667 — a MALFORMED body, not a rejected fetch. Every failure case in the app suites injects a
  // REJECTION (25 of them repo-wide), which proves the .catch handles a network/ApiError. None injects a
  // 200 whose SHAPE is wrong, so nothing exercises `ExceptionsResponse.parse` throwing INTO that catch —
  // and that is the hazard this view's own header names: "an absent key ⇒ state undefined ⇒ the next render
  // hits .length/.map ⇒ an uncaught TypeError that white-screens Command". The parse is what converts that
  // into an honest error state, and until now the conversion was untested on this surface.
  it("a MALFORMED response becomes the honest error state, never a white screen", async () => {
    mockGet.mockResolvedValue({ exceptions: [{ shipment_id: 7, kind: {}, ts: "tuesday", open: "yes" }] });
    render(<ExceptionsQueue onAuthError={vi.fn()} onOpenShipment={vi.fn()} />);

    // POSITIVE assertions, deliberately. The first draft asserted only the ABSENCE of a fabricated row and
    // it passed under the pre-§782 cast — because the cast makes React render an object child, the whole tree
    // throws, and the DOM comes back EMPTY. An empty document satisfies every "is not present" check, which is
    // §1626's rule met head-on: an absence claim needs a positive companion. The panel surviving IS the
    // difference between a degraded view and a white screen.
    expect(await screen.findByText("COULD NOT LOAD EXCEPTIONS")).toBeTruthy();
    expect(screen.getByText("EXCEPTIONS"), "the panel itself must survive a bad body").toBeTruthy();
    expect(screen.queryByText("7"), "a malformed row must never render as an exception").toBeNull();
  });

  it("a 401 drops the session (onAuthError)", async () => {
    const onAuthError = vi.fn();
    mockGet.mockRejectedValueOnce(new ApiError("UNAUTHORIZED", 401, "no session"));
    render(<ExceptionsQueue onAuthError={onAuthError} onOpenShipment={vi.fn()} />);
    await vi.waitFor(() => expect(onAuthError).toHaveBeenCalled());
  });
});
