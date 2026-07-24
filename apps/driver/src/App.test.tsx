// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App.js";
import type { ManifestClient, ManifestResult } from "./api/client.js";
import type { AuthSession } from "./auth/session.js";

// Task 10 (REQ-030/025/013) — the driver App reads ONLY the authenticated server manifest. It NEVER
// falls back to demo/fixture data: every state is explicit (loading | ready | empty | stale |
// unauthenticated | unavailable), a 401 CLEARS the client session + data, and the production bundle
// contains no DAY_SHEET / fictional consignee fixture. These tests inject the manifest client + auth
// session so the honest-by-construction states are provable without a live network.

afterEach(() => cleanup());

// A fixed manifest with one REVEALED stop. Uses a synthetic shipment id, never a fixture consignee name.
const READY_MANIFEST = {
  server_ts: 1_700_000_000_000,
  tenant: "tenant-a",
  driver_id: "u-driver",
  stops: [{ shipment_id: "dm-x1", seq: 0, kind: "pickup" as const, status: "pending" as const, revealed: true, geo: { lat_e6: 45_523_100, lon_e6: -122_676_500 } }],
};

function fakeSession(token: string | null): AuthSession & { clear: ReturnType<typeof vi.fn> } {
  let current = token;
  return {
    getToken: () => current,
    setToken: (t: string) => {
      current = t;
    },
    clear: vi.fn(() => {
      current = null;
    }),
  };
}

function fakeClient(result: ManifestResult | Promise<ManifestResult>): ManifestClient {
  return { fetchManifest: () => Promise.resolve(result) };
}

describe("driver App — honest server-driven states, never a demo fallback (REQ-030/025)", () => {
  it("shows an explicit LOADING state before the manifest resolves", async () => {
    let resolveResult: (r: ManifestResult) => void = () => {};
    const pending = new Promise<ManifestResult>((res) => {
      resolveResult = res;
    });
    render(<App client={fakeClient(pending)} session={fakeSession("tok")} />);
    expect(screen.getByText(/loading today's stops/i)).toBeTruthy();
    resolveResult({ kind: "ok", manifest: READY_MANIFEST });
    await waitFor(() => expect(screen.getByText(/dm-x1/)).toBeTruthy());
  });

  it("READY: renders the day sheet from the manifest — and no fictional fixture name", async () => {
    render(<App client={fakeClient({ kind: "ok", manifest: READY_MANIFEST })} session={fakeSession("tok")} />);
    await waitFor(() => expect(screen.getByText(/dm-x1/)).toBeTruthy());
    // The FICTIONAL DAY_SHEET consignees must never render — the fixture read path is gone.
    expect(screen.queryByText(/Rivergate Dry Goods/)).toBeNull();
    expect(screen.queryByText(/Eastbank Grocery DC/)).toBeNull();
  });

  it("EMPTY: an assigned-nothing driver sees an explicit empty state, never a demo day sheet", async () => {
    const empty = { ...READY_MANIFEST, stops: [] };
    render(<App client={fakeClient({ kind: "ok", manifest: empty })} session={fakeSession("tok")} />);
    await waitFor(() => expect(screen.getByText(/no stops/i)).toBeTruthy());
    expect(screen.queryByText(/Rivergate Dry Goods/)).toBeNull();
  });

  it("UNAUTHENTICATED: no token → explicit sign-in state, no data, no fixtures", async () => {
    render(<App client={fakeClient({ kind: "ok", manifest: READY_MANIFEST })} session={fakeSession(null)} />);
    await waitFor(() => expect(screen.getByText(/session isn't active/i)).toBeTruthy());
    expect(screen.queryByText(/dm-x1/)).toBeNull();
    expect(screen.queryByText(/Rivergate Dry Goods/)).toBeNull();
  });

  it("a 401 CLEARS the client session and shows the unauthenticated state (no stale data survives)", async () => {
    const session = fakeSession("tok");
    render(<App client={fakeClient({ kind: "unauthenticated" })} session={session} />);
    await waitFor(() => expect(screen.getByText(/session isn't active/i)).toBeTruthy());
    expect(session.clear).toHaveBeenCalled();
    expect(session.getToken()).toBeNull();
    expect(screen.queryByText(/dm-x1/)).toBeNull();
  });

  it("UNAVAILABLE: a server error with no cached manifest shows an explicit unavailable state, never fixtures", async () => {
    render(<App client={fakeClient({ kind: "unavailable", reason: "network" })} session={fakeSession("tok")} />);
    await waitFor(() => expect(screen.getByText(/can.?t load/i)).toBeTruthy());
    expect(screen.queryByText(/Rivergate Dry Goods/)).toBeNull();
    expect(screen.queryByText(/dm-x1/)).toBeNull();
  });
});

describe("production bundle contains no demo / DAY_SHEET fixture (REQ-030)", () => {
  it("the built client bundle has none of the fictional fixture consignees, nor DAY_SHEET", () => {
    const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    // Build the real production client and scan the emitted assets — the true bundle guarantee.
    execFileSync("pnpm", ["build"], { cwd: appDir, stdio: "pipe" });
    const assetsDir = join(appDir, "dist", "assets");
    const bundle = readdirSync(assetsDir)
      .filter((f) => f.endsWith(".js"))
      .map((f) => readFileSync(join(assetsDir, f), "utf8"))
      .join("\n");
    for (const fixture of ["Rivergate Dry Goods", "Eastbank Grocery DC", "Cascade Hardware Co", "Trillium Outfitters", "DAY_SHEET"]) {
      expect(bundle.includes(fixture)).toBe(false);
    }
  }, 120_000);
});
