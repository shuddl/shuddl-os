import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

/** A fetch stub that routes by URL: the board read, the per-shipment event tail, else 404. Returns the mock
 *  so a test can inspect what the surface actually SENT (e.g. whether a bearer rode the first board read). */
function stubFetch(routes: { board?: unknown; events?: Record<string, unknown>; boardStatus?: number }): ReturnType<typeof vi.fn> {
  const mock = vi.fn().mockImplementation((url: string) => {
    if (url.endsWith("/v1/board")) return Promise.resolve(jsonResponse(routes.board ?? { board: [] }, routes.boardStatus ?? 200));
    const m = url.match(/\/v1\/shipments\/([^/]+)\/events/);
    if (m) {
      const id = decodeURIComponent(m[1] ?? "");
      return Promise.resolve(jsonResponse(routes.events?.[id] ?? { events: [], next_cursor: null }));
    }
    // The Task-12 board chrome fetches these on mount — serve benign empties so the map-home assertions are
    // isolated from the live KPI strip / queues (each has its own colocated suite).
    if (url.includes("/v1/kpis")) return Promise.resolve(jsonResponse({ kpis: [] }));
    if (url.includes("/v1/approvals")) return Promise.resolve(jsonResponse({ approvals: [] }));
    if (url.includes("/v1/exceptions")) return Promise.resolve(jsonResponse({ exceptions: [] }));
    if (url.includes("/v1/invoices")) return Promise.resolve(jsonResponse({ invoices: [] }));
    if (url.includes("/v1/dunning")) return Promise.resolve(jsonResponse({ drafts: [] }));
    return Promise.resolve(jsonResponse({ code: "NOT_FOUND", message: "NOT FOUND" }, 404));
  });
  vi.stubGlobal("fetch", mock);
  return mock;
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

// REQ-081 — the MAGIC-LINK ENTRY PATH. `adoptTokenFromUrl` was built and unit-tested in session.ts but no
// non-test file in this app ever called it, so `command.shuddl.tech/?token=…` silently ignored its token and
// the operator landed on a session-less board. The portal has always adopted it (its initialMode()); command
// now does the same thing, in the same place — a first-render adoption, BEFORE the board/KPI effects fire, so
// the very first server read carries the bearer. This is a wiring fix only: there is no login screen and no
// client-side verification — the server lens remains the only real gate (REQ-030).
function b64url(obj: unknown): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function makeJwt(claims: Record<string, unknown>): string {
  return `${b64url({ alg: "none", typ: "JWT" })}.${b64url(claims)}.sig`;
}
// A synthetic tenant-lens operator claim (REQ-167) — never a real tenant/user.
const OPS_CLAIMS = { sub: "u:ops-1", tenant: "t:synthetic", role: "ops", exp: Math.floor(Date.now() / 1000) + 3600 };

/** The headers the surface sent on its /v1/board read (the client passes a plain Record). */
function boardAuthHeader(mock: ReturnType<typeof vi.fn>): string | undefined {
  const call = mock.mock.calls.find((c) => String(c[0]).endsWith("/v1/board"));
  const init = call?.[1] as RequestInit | undefined;
  return ((init?.headers ?? {}) as Record<string, string>)["authorization"];
}

describe("command magic-link entry (REQ-081)", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/");
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("adopts a ?token= magic link, STRIPS it from the URL, and sends it as the bearer on the FIRST board read", async () => {
    const jwt = makeJwt(OPS_CLAIMS);
    window.history.replaceState(null, "", `/?token=${jwt}&x=1`);
    const fetchMock = stubFetch({ board: { board: [] } });

    render(<App />);

    await waitFor(() => expect(getToken()).toBe(jwt)); // the token was adopted, not ignored
    // The bearer must never linger in history or a copied/shared link.
    expect(window.location.search).not.toContain("token");
    expect(window.location.search).toContain("x=1"); // unrelated params survive
    // Adoption happened BEFORE the first server read — otherwise the operator's first board is a spurious 401.
    await waitFor(() => expect(boardAuthHeader(fetchMock)).toBe(`Bearer ${jwt}`));
  });

  it("a URL with NO token leaves the surface unauthenticated — no bearer sent, and the honest 401 banner shows", async () => {
    window.history.replaceState(null, "", "/");
    const fetchMock = stubFetch({ board: { code: "UNAUTHORIZED", message: "MISSING BEARER TOKEN", req_id: "r1" }, boardStatus: 401 });

    render(<App />);

    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("/v1/board"))).toBe(true));
    expect(getToken()).toBeNull(); // nothing is minted client-side — adoption is strictly opt-in via the URL
    expect(boardAuthHeader(fetchMock)).toBeUndefined();
    // The server's 401 is surfaced honestly rather than as a silently-empty board.
    expect(await screen.findByText(/SESSION EXPIRED/)).toBeTruthy();
  });
});

// WP-10 Task 12 (REQ-082/083/038/084) — the board chrome is now LIVE and router-wired: the KPI strip renders the
// real /v1/kpis numbers (no more hardcoded tiles), a tile CLICKS THROUGH to its kind-filtered drill, and the
// copilot is a route-driven overlay. `fetch` routes by URL; no network is ever hit.
describe("command board chrome — live + router-wired (REQ-082/083/038/084)", () => {
  beforeEach(() => {
    localStorage.clear();
    captured.fleet = null;
    captured.onSelect = null;
    // Force reduced motion so CountUp renders its final value immediately (deterministic KPI assertions).
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return false;
      },
    }));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function stubChrome(): void {
    const mock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/v1/board")) return Promise.resolve(jsonResponse({ board: [] }));
      if (url.includes("/v1/kpis")) {
        return Promise.resolve(
          jsonResponse({
            kpis: [{ key: "unbilled", label: "Unbilled PODs", value: 4, unit: "count", backing: { kinds: ["pod.signed", "invoice.issued"] } }],
          }),
        );
      }
      if (url.includes("/v1/events?kind=")) {
        return Promise.resolve(jsonResponse({ events: [{ id: "e1", kind: "pod.signed", ts: 1_720_000_000_000, shipment_id: "shp-7" }], next_cursor: null }));
      }
      if (url.includes("/v1/approvals")) return Promise.resolve(jsonResponse({ approvals: [] }));
      if (url.includes("/v1/exceptions")) return Promise.resolve(jsonResponse({ exceptions: [] }));
      if (url.includes("/v1/invoices")) return Promise.resolve(jsonResponse({ invoices: [] }));
      if (url.includes("/v1/parity")) {
        return Promise.resolve(
          jsonResponse({
            modules: [{ module: "invoicing", native_value: 90_000, legacy_value: 63_100, drift_bps: 4_263, within_gate: false, status: "DRIFT", backing_kinds: ["invoice.issued"] }],
          }),
        );
      }
      return Promise.resolve(jsonResponse({ code: "NOT_FOUND", message: "NOT FOUND" }, 404));
    });
    vi.stubGlobal("fetch", mock);
  }

  it("renders the real KPI number and a tile CLICKS THROUGH to its kind-filtered ledger drill", async () => {
    window.history.pushState(null, "", "/");
    stubChrome();
    render(<App />);

    // the strip shows the REAL /v1/kpis number (scoped to the KPI section — the money queue mirrors the same tile)
    const strip = await screen.findByLabelText("Board KPIs");
    expect(await within(strip).findByText("4")).toBeTruthy();

    // the tile CLICKS THROUGH to its kind-filtered drill
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Unbilled PODs — drill to ledger events" }));
    });

    // the drill overlay reads GET /v1/events?kind=<backing.kinds> and renders the backing event
    expect(await screen.findByText("pod.signed")).toBeTruthy();
    expect(screen.getByText("v_unbilled")).toBeTruthy();
    window.history.pushState(null, "", "/");
  });

  it("the /copilot route renders the copilot overlay (the ⌘K +copilot surface)", async () => {
    window.history.pushState(null, "", "/copilot");
    stubChrome();
    render(<App />);

    expect(await screen.findByText("ASK THE LEDGER")).toBeTruthy();
    window.history.pushState(null, "", "/");
  });

  it("the /parity route resolves to the v_parity shadow-parity dashboard (REQ-152/153), consuming GET /v1/parity", async () => {
    window.history.pushState(null, "", "/parity");
    stubChrome();
    render(<App />);

    // the canonical v_parity view mounts and renders the server-computed per-module parity (no client recompute)
    expect(await screen.findByText("SHADOW PARITY")).toBeTruthy();
    expect(await screen.findByRole("button", { name: /invoicing parity row/i })).toBeTruthy();
    window.history.pushState(null, "", "/");
  });
});
