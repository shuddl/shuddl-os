import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// The map is WebGL (maplibre) — stub it so jsdom never constructs a GL context. useFleet returns an empty
// scoped collection; the real party-lens scoping is proven in @shuddl/map's own suite. demoFleet is a SPY:
// Task 12 replaced the synthetic demo fleet with the server-scoped board, so the production client must NEVER
// fall back to it — every board test asserts the spy is never called.
const { demoFleetSpy } = vi.hoisted(() => ({ demoFleetSpy: vi.fn(() => []) }));
vi.mock("@shuddl/map", () => ({
  MapCanvas: () => <div data-testid="map" />,
  useFleet: () => ({ collection: { type: "FeatureCollection", features: [] }, states: new Map(), setState: () => {} }),
  demoFleet: demoFleetSpy,
  DEMO_TILE_URL: "tile://demo",
  DEMO_GLYPHS_URL: "glyph://demo",
}));

// Control the session lens directly; the real decode is covered by session.test.ts.
vi.mock("./session.js", () => ({
  adoptTokenFromUrl: vi.fn(),
  getClaims: vi.fn(),
  isAuthed: vi.fn(),
  clear: vi.fn(),
  getToken: vi.fn(() => "tok"),
}));

// The board (GET /v1/board) and the ruled lists (GET /v1/invoices) both go through `get`; spy it, keep ApiError.
vi.mock("./lib/api.js", async () => {
  const actual = await vi.importActual<typeof import("./lib/api.js")>("./lib/api.js");
  return { ...actual, get: vi.fn(), post: vi.fn() };
});

import { App } from "./App.js";
import { clear, getClaims, isAuthed } from "./session.js";
import { ApiError, get } from "./lib/api.js";

const mockGetClaims = getClaims as unknown as ReturnType<typeof vi.fn>;
const mockIsAuthed = isAuthed as unknown as ReturnType<typeof vi.fn>;
const mockClear = clear as unknown as ReturnType<typeof vi.fn>;
const mockGet = get as unknown as ReturnType<typeof vi.fn>;

const CLAIMS = { sub: "u-1", tenant: "tenant-a", role: "portal", party_id: "party-9", exp: 9_999_999_999 };

// A fixed server-derived freshness stamp: 1_700_000_000_000 ms → 2023-11-14T22:13:20Z → "22:13:20" (UTC).
const AS_OF = 1_700_000_000_000;
const AS_OF_HHMMSS = "22:13:20";
const ONE_MARK = [{ shipment_id: "shp-1", lat_e6: 41_200_000, lon_e6: -74_700_000, status: "healthy" }];

// Route the board read and the list read independently: they hit distinct paths through the same `get` spy.
function routeGet(opts: { board?: unknown; boardReject?: unknown; invoices?: unknown } = {}): void {
  mockGet.mockImplementation((path: string) => {
    if (path === "/v1/board") {
      if (opts.boardReject !== undefined) return Promise.reject(opts.boardReject);
      if (opts.board === "pending") return new Promise(() => {}); // never resolves — the LOADING state
      return Promise.resolve(opts.board ?? { board: [], as_of: AS_OF });
    }
    return Promise.resolve(opts.invoices ?? { invoices: [] });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("App portal board (REQ-085/051)", () => {
  it("an authed party sees the board keyed to its REAL lens identity, fed from GET /v1/board (never demoFleet)", async () => {
    mockGetClaims.mockReturnValue(CLAIMS);
    mockIsAuthed.mockReturnValue(true);
    routeGet({ board: { board: ONE_MARK, as_of: AS_OF } });

    render(<App />);

    expect(screen.getByText("party-9")).toBeTruthy(); // the hero is the real party id, not "MERIDIAN SUPPLY CO."
    expect(screen.getByPlaceholderText("Origin ZIP")).toBeTruthy(); // the quote→book panel is present
    await screen.findByText(/no invoices yet/i); // invoices load settled (empty, lens-scoped)
    expect(mockGet).toHaveBeenCalledWith("/v1/board"); // the fleet came from the SERVER board
    expect(demoFleetSpy).not.toHaveBeenCalled(); // ...never from a synthetic demo fleet
  });

  it("a missing / expired session renders the clean re-auth prompt, NOT the board", () => {
    mockGetClaims.mockReturnValue(null);
    mockIsAuthed.mockReturnValue(false);

    render(<App />);

    expect(screen.getByText(/sign in again/i)).toBeTruthy();
    expect(screen.queryByPlaceholderText("Origin ZIP")).toBeNull();
    expect(demoFleetSpy).not.toHaveBeenCalled();
  });

  it("the tab nav surfaces the authed views (INVOICES tab mounts the InvoicesView)", async () => {
    mockGetClaims.mockReturnValue(CLAIMS);
    mockIsAuthed.mockReturnValue(true);
    routeGet();

    render(<App />);
    await screen.findByText(/no invoices yet/i); // overview's ShipmentList settled

    fireEvent.click(screen.getByRole("button", { name: /invoices/i }));

    // the InvoicesView (its own distinctive empty state) is now surfaced
    await screen.findByText(/no invoices billed to you yet/i);
  });

  it("a 401 from the board read drops the session and shows the re-auth prompt", async () => {
    mockGetClaims.mockReturnValue(CLAIMS);
    mockIsAuthed.mockReturnValue(true);
    routeGet({ boardReject: new ApiError("UNAUTHORIZED", 401, "NO SESSION") });

    render(<App />);

    await waitFor(() => expect(screen.getByText(/sign in again/i)).toBeTruthy());
    expect(mockClear).toHaveBeenCalled();
  });

  it("shows an honest LOADING state before the first board load resolves", () => {
    mockGetClaims.mockReturnValue(CLAIMS);
    mockIsAuthed.mockReturnValue(true);
    routeGet({ board: "pending" });

    render(<App />);

    expect(screen.getByTestId("board-status").textContent).toMatch(/syncing|loading/i);
    expect(demoFleetSpy).not.toHaveBeenCalled();
  });

  it("renders a VISIBLE server-derived freshness timestamp when the board is live", async () => {
    mockGetClaims.mockReturnValue(CLAIMS);
    mockIsAuthed.mockReturnValue(true);
    routeGet({ board: { board: ONE_MARK, as_of: AS_OF } });

    render(<App />);

    await waitFor(() => expect(screen.getByTestId("board-status").textContent).toContain(AS_OF_HHMMSS));
  });

  it("an EMPTY board renders an honest empty state (never a fabricated fleet)", async () => {
    mockGetClaims.mockReturnValue(CLAIMS);
    mockIsAuthed.mockReturnValue(true);
    routeGet({ board: { board: [], as_of: AS_OF } });

    render(<App />);

    await waitFor(() => expect(screen.getByTestId("board-status").textContent).toMatch(/no active freight/i));
    expect(demoFleetSpy).not.toHaveBeenCalled();
  });

  it("an UNAVAILABLE board (non-401 failure, first load) shows an honest unavailable state — no demo fallback", async () => {
    mockGetClaims.mockReturnValue(CLAIMS);
    mockIsAuthed.mockReturnValue(true);
    routeGet({ boardReject: new ApiError("BAD_RESPONSE", 503, "BOARD DOWN") });

    render(<App />);

    await waitFor(() => expect(screen.getByTestId("board-status").textContent).toMatch(/unavailable/i));
    expect(demoFleetSpy).not.toHaveBeenCalled();
  });

  it("a failed REFRESH after a good load marks the board STALE, keeping the last-good freshness stamp", async () => {
    vi.useFakeTimers();
    try {
      mockGetClaims.mockReturnValue(CLAIMS);
      mockIsAuthed.mockReturnValue(true);
      let failBoard = false;
      mockGet.mockImplementation((path: string) => {
        if (path === "/v1/board") {
          return failBoard
            ? Promise.reject(new ApiError("BAD_RESPONSE", 503, "BOARD DOWN"))
            : Promise.resolve({ board: ONE_MARK, as_of: AS_OF });
        }
        return Promise.resolve({ invoices: [] });
      });

      render(<App />);
      // settle the immediate first load (a resolved promise → microtasks)
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByTestId("board-status").textContent).toContain(AS_OF_HHMMSS);

      // the NEXT poll fails — the board must go STALE while retaining the last-good marks + stamp.
      failBoard = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      const text = screen.getByTestId("board-status").textContent ?? "";
      expect(text).toMatch(/stale/i);
      expect(text).toContain(AS_OF_HHMMSS); // last-good freshness retained, honestly labelled stale
    } finally {
      vi.useRealTimers();
    }
  });
});
