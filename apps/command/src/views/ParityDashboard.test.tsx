import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("../lib/api.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/api.js")>("../lib/api.js");
  return { ...actual, get: vi.fn(), post: vi.fn() };
});
import { ParityDashboard } from "./ParityDashboard.js";
import { get } from "../lib/api.js";

const mockGet = get as unknown as ReturnType<typeof vi.fn>;

// WP-15 Task 7 (REQ-152/153) — the Command v_parity shadow-parity dashboard. It CONSUMES GET /v1/parity (the
// Task-6 server compute — never a client recompute) and drills a module to its backing events: the NATIVE side
// via GET /v1/events?kind=<backing_kinds>, the LEGACY side via the SAME with &includeShadow=true (the Task-4b
// legacy-shadow opt-in). The honesty law: a status:'UNKNOWN' module renders an explicit UNKNOWN, never a
// fabricated green match.
const PARITY = {
  modules: [
    // a clean MATCH (both sides present, within gate)
    { module: "rating", native_value: 100_000, legacy_value: 100_000, drift_bps: 0, within_gate: true, status: "MATCH", backing_kinds: ["quote.priced"] },
    // a DRIFT (both sides present, beyond gate) — the operator must SEE this diverging
    { module: "invoicing", native_value: 90_000, legacy_value: 63_100, drift_bps: 4_263, within_gate: false, status: "DRIFT", backing_kinds: ["invoice.issued"] },
    // an UNKNOWN (a side missing) — NOT proven, must never read as a pass
    { module: "settlement", native_value: "UNKNOWN", legacy_value: "UNKNOWN", drift_bps: "UNKNOWN", within_gate: false, status: "UNKNOWN", backing_kinds: ["settlement.executed", "split.computed"] },
  ],
};

// A defensive router: the parity read, then the native (default) + legacy (includeShadow) event reads. A stray
// late call resolves benign. The assertions below pin the EXACT calls that matter.
function route(nativeEvents: unknown[], legacyEvents: unknown[]): (path?: string) => Promise<unknown> {
  return (path?: string) => {
    if (typeof path === "string" && path.startsWith("/v1/parity")) return Promise.resolve(PARITY);
    if (typeof path === "string" && path.includes("includeShadow=true")) return Promise.resolve({ events: legacyEvents, next_cursor: null });
    if (typeof path === "string" && path.startsWith("/v1/events")) return Promise.resolve({ events: nativeEvents, next_cursor: null });
    return Promise.resolve({ modules: [], events: [], next_cursor: null });
  };
}

beforeEach(() => mockGet.mockReset());
afterEach(() => cleanup());

describe("ParityDashboard (REQ-152/153)", () => {
  it("renders a per-module parity row from GET /v1/parity (module, native, legacy, drift, status) — no client recompute", async () => {
    mockGet.mockImplementation(route([], []));
    render(<ParityDashboard onOpenShipment={vi.fn()} onClose={vi.fn()} onAuthError={vi.fn()} />);

    // it names the canonical view slug, and consumes the server compute verbatim
    await screen.findByText("v_parity");
    expect(mockGet).toHaveBeenCalledWith("/v1/parity");

    // one row per overlay module, with each module's native/legacy/drift/status surfaced
    const rating = screen.getByRole("button", { name: /rating parity row/i });
    expect(within(rating).getByText("MATCH")).toBeTruthy();
    expect(within(rating).getByText(/NATIVE\s+100000/)).toBeTruthy();
    expect(within(rating).getByText(/LEGACY\s+100000/)).toBeTruthy();
    expect(within(rating).getByText(/DRIFT\s+0\s+BPS/)).toBeTruthy();

    const invoicing = screen.getByRole("button", { name: /invoicing parity row/i });
    expect(within(invoicing).getByText(/DRIFT\s+4263\s+BPS/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /settlement parity row/i })).toBeTruthy();
  });

  it("UNKNOWN honesty: an UNKNOWN module renders an explicit UNKNOWN no-data state — NEVER a fabricated match or passing indicator", async () => {
    mockGet.mockImplementation(route([], []));
    render(<ParityDashboard onOpenShipment={vi.fn()} onClose={vi.fn()} onAuthError={vi.fn()} />);

    const row = within(await screen.findByRole("button", { name: /settlement parity row/i }));
    // the status reads the literal UNKNOWN
    expect(row.getByText("UNKNOWN")).toBeTruthy();
    // both sides are an explicit no-data — NOT a fabricated 0 or number
    expect(row.getByText(/NATIVE\s+UNKNOWN/)).toBeTruthy();
    expect(row.getByText(/LEGACY\s+UNKNOWN/)).toBeTruthy();
    expect(row.getByText(/DRIFT\s+UNKNOWN/)).toBeTruthy();
    // the anti-false-green proof: an unproven module NEVER shows a MATCH / a green check / a 100% parity
    expect(row.queryByText("MATCH")).toBeNull();
    expect(row.queryByText(/100\s*%/)).toBeNull();
    expect(row.queryByText("✓")).toBeNull();
  });

  it("a DRIFT module is VISUALLY distinct from a MATCH module (the operator sees which modules diverge)", async () => {
    mockGet.mockImplementation(route([], []));
    render(<ParityDashboard onOpenShipment={vi.fn()} onClose={vi.fn()} onAuthError={vi.fn()} />);

    const driftRow = within(await screen.findByRole("button", { name: /invoicing parity row/i }));
    const matchRow = within(screen.getByRole("button", { name: /rating parity row/i }));
    const drift = driftRow.getByText("DRIFT");
    const match = matchRow.getByText("MATCH");

    // the two statuses are painted with DIFFERENT design tokens — DRIFT speaks in the loud --signal (the alarm),
    // MATCH stays quiet in the muted --signal-55. Same token ⇒ indistinguishable ⇒ this test fails.
    expect(drift.style.color).not.toBe(match.style.color);
    expect(drift.style.color).toBe("var(--signal)");
    expect(match.style.color).toBe("var(--signal-55)");
  });

  it("a module row DRILLS: the NATIVE side reads /v1/events?kind=..., the LEGACY side the SAME with &includeShadow=true", async () => {
    const nativeEvents = [{ id: "n1", kind: "invoice.issued", ts: 1_720_000_000_000, shipment_id: "shp-native", source: "native" }];
    // the includeShadow response returns BOTH native and legacy rows; the dashboard shows the legacy mirror facts.
    const legacyEvents = [
      { id: "n1", kind: "invoice.issued", ts: 1_720_000_000_000, shipment_id: "shp-native", source: "native" },
      { id: "l1", kind: "invoice.issued", ts: 1_720_000_500_000, shipment_id: "shp-legacy", source: "legacy" },
    ];
    mockGet.mockImplementation(route(nativeEvents, legacyEvents));
    const onOpenShipment = vi.fn();
    render(<ParityDashboard onOpenShipment={onOpenShipment} onClose={vi.fn()} onAuthError={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: /invoicing parity row/i }));

    // both backing reads fired with the module's backing kinds — native (default) + legacy (includeShadow opt-in)
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith("/v1/events?kind=invoice.issued"));
    expect(mockGet).toHaveBeenCalledWith("/v1/events?kind=invoice.issued&includeShadow=true");

    // the NATIVE fact and the LEGACY mirror fact are both shown, and a fact clicks through to its shipment lens
    expect(await screen.findByText(/shp-legacy/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /open shp-native/i }));
    expect(onOpenShipment).toHaveBeenCalledWith("shp-native");
  });
});
