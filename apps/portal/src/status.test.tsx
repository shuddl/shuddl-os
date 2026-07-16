import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

// The map is WebGL — stub it so jsdom never constructs a GL context (mirrors App.test).
vi.mock("@shuddl/map", () => ({
  MapCanvas: () => <div data-testid="map" />,
  DEMO_TILE_URL: "tile://demo",
  DEMO_GLYPHS_URL: "glyph://demo",
}));

vi.mock("./lib/api.js", async () => {
  const actual = await vi.importActual<typeof import("./lib/api.js")>("./lib/api.js");
  return { ...actual, get: vi.fn(), post: vi.fn() };
});
import { Status } from "./status.js";
import { ApiError, get } from "./lib/api.js";

const mockGet = get as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => mockGet.mockReset());
afterEach(() => cleanup());

// REQ-086 — the PUBLIC status page. NO session. It renders ONLY what /pub/status/:cap returns: the milestone
// state, the ALWAYS-coarse position, and NOTHING for eta (the server omits it — a number is never fabricated).

describe("Status public page (REQ-086)", () => {
  it("renders the milestone state and the COARSE position, and fabricates NO eta", async () => {
    // The server already coarsened the position (~11km); e6 → degrees at 1 decimal is city-level.
    mockGet.mockResolvedValue({
      state: "in_transit",
      out_for_delivery: false,
      position: { lat_e6: 39_700_000, lon_e6: -104_990_000 },
      // no eta field — the server omits it
    });
    render(<Status cap="CAP-OK" />);

    await screen.findByText(/in transit/i);
    const pos = await screen.findByTestId("status-position");
    expect(pos.textContent ?? "").toMatch(/39\.7/);
    expect(pos.textContent ?? "").toMatch(/-105\.0/); // -104.99 coarsens to -105.0
    expect(screen.getByText(/generalized to city/i)).toBeTruthy(); // the honest coarse caption
    expect(screen.queryByTestId("status-eta")).toBeNull(); // NEVER a fabricated eta
    expect(mockGet).toHaveBeenCalledWith("/pub/status/CAP-OK");
  });

  it("a 401 (bad/expired cap) renders a clean 'status unavailable' — no detail leak", async () => {
    mockGet.mockRejectedValueOnce(new ApiError("UNAUTHORIZED", 401, "STATUS UNAVAILABLE"));
    render(<Status cap="CAP-BAD" />);
    await screen.findByText(/status unavailable/i);
    expect(screen.queryByTestId("status-position")).toBeNull();
  });

  it("no cap at all renders 'status unavailable' and NEVER calls the API", () => {
    render(<Status cap={null} />);
    expect(screen.getByText(/status unavailable/i)).toBeTruthy();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("a position that is not yet reported still renders the state (no fabricated coordinates)", async () => {
    mockGet.mockResolvedValue({ state: "booked", out_for_delivery: false });
    render(<Status cap="CAP-OK" />);
    await screen.findByText(/booked/i);
    expect(screen.queryByTestId("status-position")).toBeNull();
  });
});
