import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { FleetCollection } from "@shuddl/map";
import { getToken, setToken } from "./session.js";

// WP-10 Task 9 (REQ-073/080 + demo #5) — the command map home now feeds the REAL lens-scoped board (GET /v1/board)
// into the map, so the exception marks reflect ACTUAL ledger state. These tests prove the DATA PATH end to end:
// a mocked board → useFleet → the collection the map renders. The map's own mechanics (world-dim/pulse off a
// statusStr==='exception' feature) are proven in packages/map MapCanvas.test — here MapCanvas is mocked to a
// capture so we assert the collection it is HANDED (the real WebGL render is the Playwright job). `fetch` is
// mocked per-test; no network is ever hit.

// Capture what the (mocked) MapCanvas receives — the collection to render + the click handler that opens the lens.
const captured: { fleet: FleetCollection | null; onSelect: ((shipmentId: string) => void) | null } = {
  fleet: null,
  onSelect: null,
};

vi.mock("@shuddl/map", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shuddl/map")>();
  return {
    ...actual,
    // Keep useFleet / LensPanel / fleet1k / DEMO_* real; replace only the WebGL canvas.
    MapCanvas: (props: { fleet: FleetCollection; onSelect: (shipmentId: string) => void }): null => {
      captured.fleet = props.fleet;
      captured.onSelect = props.onSelect;
      return null;
    },
  };
});

// Imported AFTER vi.mock so the mocked module is in place (vitest hoists vi.mock).
import { App } from "./App.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fetch stub that routes by URL: the board read, the per-shipment event tail, else 404. */
function stubFetch(routes: { board?: unknown; events?: Record<string, unknown>; boardStatus?: number }): void {
  const mock = vi.fn().mockImplementation((url: string) => {
    if (url.endsWith("/v1/board")) return Promise.resolve(jsonResponse(routes.board ?? { board: [] }, routes.boardStatus ?? 200));
    const m = url.match(/\/v1\/shipments\/([^/]+)\/events/);
    if (m) {
      const id = decodeURIComponent(m[1] ?? "");
      return Promise.resolve(jsonResponse(routes.events?.[id] ?? { events: [], next_cursor: null }));
    }
    return Promise.resolve(jsonResponse({ code: "NOT_FOUND", message: "NOT FOUND" }, 404));
  });
  vi.stubGlobal("fetch", mock);
}

describe("command map home — real board feed (REQ-073/080, demo #5)", () => {
  beforeEach(() => {
    localStorage.clear();
    captured.fleet = null;
    captured.onSelect = null;
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the real board fleet; an exception shipment carries the exception status (demo #5 data path)", async () => {
    stubFetch({
      board: {
        board: [
          { shipment_id: "shp-a", lat_e6: 41_000_000, lon_e6: -74_000_000, status: "healthy" },
          { shipment_id: "shp-x", lat_e6: 40_000_000, lon_e6: -75_000_000, status: "exception" },
        ],
      },
    });

    render(<App />);

    await waitFor(() => expect(captured.fleet?.features.length).toBe(2));
    const features = captured.fleet?.features ?? [];
    const exc = features.find((f) => f.properties.shipment_id === "shp-x");
    // The exception status rode the ledger → the fleet feature → statusStr==='exception', which is EXACTLY what
    // MapCanvas.hasVisibleException reads to arm the world-dim + the exception pulse (demo #5).
    expect(exc?.properties.statusStr).toBe("exception");
    // Exact ops geo passed straight through the command (tenant) lens — no coarsening (that is party-only).
    expect(exc?.geometry.coordinates).toEqual([-75, 40]);
    // At least one visible exception exists in the rendered collection — the demo-#5 trigger condition.
    expect(features.some((f) => f.properties.statusStr === "exception")).toBe(true);
  });

  it("a 401 clears the session (the re-auth path) and renders an honest empty map", async () => {
    setToken("header.payload.sig");
    stubFetch({ board: { code: "UNAUTHORIZED", message: "NO SESSION", req_id: "r1" }, boardStatus: 401 });

    render(<App />);

    // The rejected token is dropped — the shell must re-authenticate (Task 8 isAuthError path).
    await waitFor(() => expect(getToken()).toBeNull());
    // No synthetic marks fill the empty map.
    expect(captured.fleet?.features).toEqual([]);
    // And an honest re-auth note is shown.
    expect(await screen.findByText(/SESSION EXPIRED/)).toBeTruthy();
  });

  it("an empty board renders an honest empty map (no synthetic demoFleet marks)", async () => {
    stubFetch({ board: { board: [] } });

    render(<App />);

    await waitFor(() => expect(captured.fleet).not.toBeNull());
    expect(captured.fleet?.features).toEqual([]);
  });

  it("clicking a mark opens the lens with the shipment's real event tail (GET /v1/shipments/:id/events)", async () => {
    stubFetch({
      board: { board: [{ shipment_id: "shp-a", lat_e6: 41_000_000, lon_e6: -74_000_000, status: "healthy" }] },
      events: { "shp-a": { events: [{ kind: "pod.signed", ts: 1_720_000_000_000 }], next_cursor: null } },
    });

    render(<App />);

    await waitFor(() => expect(captured.onSelect).not.toBeNull());
    await act(async () => {
      captured.onSelect?.("shp-a");
    });

    // The lens panel renders the REAL ledger tail, not the old hardcoded PICKUP/IN TRANSIT stub.
    expect(await screen.findByText("pod.signed")).toBeTruthy();
    expect(screen.queryByText("IN TRANSIT")).toBeNull();
  });
});
