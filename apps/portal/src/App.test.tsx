import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

// The map is WebGL (maplibre) — stub it so jsdom never constructs a GL context. useFleet returns an empty
// scoped collection; the real party-lens scoping is proven in @shuddl/map's own suite.
vi.mock("@shuddl/map", () => ({
  MapCanvas: () => <div data-testid="map" />,
  useFleet: () => ({ collection: { type: "FeatureCollection", features: [] }, states: new Map(), setState: () => {} }),
  demoFleet: () => [],
  DEMO_TILE_URL: "tile://demo",
  DEMO_GLYPHS_URL: "glyph://demo",
}));

// Control the session lens directly; the real decode is covered by session.test.ts.
vi.mock("./session.js", () => ({
  adoptTokenFromUrl: vi.fn(),
  getClaims: vi.fn(),
  isAuthed: vi.fn(),
  clear: vi.fn(),
}));

// ShipmentList loads GET /v1/invoices; spy get/post, keep the real ApiError.
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

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("App portal board (REQ-085/051)", () => {
  it("an authed party sees the board keyed to its REAL lens identity (party_id, not a hardcoded name)", async () => {
    mockGetClaims.mockReturnValue(CLAIMS);
    mockIsAuthed.mockReturnValue(true);
    mockGet.mockResolvedValue({ invoices: [] });

    render(<App />);

    expect(screen.getByText("party-9")).toBeTruthy(); // the hero is the real party id, not "MERIDIAN SUPPLY CO."
    expect(screen.getByPlaceholderText("Origin ZIP")).toBeTruthy(); // the quote→book panel is present
    await screen.findByText(/no invoices yet/i); // invoices load settled (empty, lens-scoped)
  });

  it("a missing / expired session renders the clean re-auth prompt, NOT the board", () => {
    mockGetClaims.mockReturnValue(null);
    mockIsAuthed.mockReturnValue(false);

    render(<App />);

    expect(screen.getByText(/sign in again/i)).toBeTruthy();
    expect(screen.queryByPlaceholderText("Origin ZIP")).toBeNull();
  });

  it("a 401 from a board read drops the session and shows the re-auth prompt", async () => {
    mockGetClaims.mockReturnValue(CLAIMS);
    mockIsAuthed.mockReturnValue(true);
    mockGet.mockRejectedValue(new ApiError("UNAUTHORIZED", 401, "NO SESSION"));

    render(<App />);

    await waitFor(() => expect(screen.getByText(/sign in again/i)).toBeTruthy());
    expect(mockClear).toHaveBeenCalled();
  });
});
