import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { KpiStrip } from "./KpiStrip.js";
import type { KpiTile } from "./registry.js";

// Force reduced motion so CountUp renders its FINAL value immediately (deterministic assertions, no tween race).
beforeEach(() => {
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

const TILES: KpiTile[] = [
  { key: "unbilled", label: "Unbilled PODs", value: 3, unit: "count", backing: { kinds: ["pod.signed", "invoice.issued"] } },
  { key: "otd", label: "On-Time Delivery", value: 9800, unit: "bps", backing: { kinds: ["pod.signed"] } },
  { key: "dwell", label: "Avg Dwell", value: "UNKNOWN", unit: "min", backing: { kinds: ["stop.arrived", "stop.departed"] } },
  { key: "lane_pnl", label: "Lane P&L", value: 250000, unit: "cents", backing: { kinds: ["invoice.issued", "settlement.executed"] } },
  { key: "dso", label: "DSO (open AR age)", value: 38, unit: "days", backing: { kinds: ["invoice.issued", "payment.received"] } },
  { key: "or", label: "Cost/Rev (quoted basis)", value: 9400, unit: "bps", backing: { kinds: ["quote.priced", "invoice.issued"] } },
];

describe("KpiStrip (REQ-083)", () => {
  it("renders the REAL numbers (integer-cents money, whole percent, days)", () => {
    render(<KpiStrip kpis={TILES} loading={false} error={null} onTile={vi.fn()} />);
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("98%")).toBeTruthy();
    expect(screen.getByText("$2,500.00")).toBeTruthy();
    expect(screen.getByText("38D")).toBeTruthy();
    expect(screen.getByText("94%")).toBeTruthy();
  });

  it("an UNKNOWN tile shows an honest em-dash + NO DATA, NEVER a fabricated 0 or 100%", () => {
    render(<KpiStrip kpis={TILES} loading={false} error={null} onTile={vi.fn()} />);
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText(/NO DATA/)).toBeTruthy();
    // dwell (UNKNOWN) never fabricates a number
    expect(screen.queryByText("0M")).toBeNull();
    expect(screen.queryByText("100%")).toBeNull();
  });

  it("a tile CLICKS THROUGH to its drill by key (every KPI clicks through to its ledger events)", () => {
    const onTile = vi.fn();
    render(<KpiStrip kpis={TILES} loading={false} error={null} onTile={onTile} />);
    fireEvent.click(screen.getByText("$2,500.00"));
    expect(onTile).toHaveBeenCalledWith("lane_pnl");
  });

  it("§1689 an errored strip shows the error and NO tiles — a stale KPI is worse than none", () => {
    // The KPI layer is "always on" (genesis/01 §3) and every tile is a number an operator acts on, so the
    // failure mode that matters is rendering the LAST-KNOWN tiles beside a fresh error, or rendering tiles
    // built from a failed read. The component's own header states the discipline it applies one level down —
    // "an honest em-dash, NEVER a fabricated 0 or 100%" — and this is the same rule for the whole strip.
    //
    // Measured before writing: making `error !== null` unreachable left command 104/104 GREEN, so nothing
    // held this arm. `error` is a PROP here, which is why its absence from the suite was a pure omission
    // rather than a harness difficulty.
    render(<KpiStrip kpis={TILES} loading={false} error="KPI READ FAILED" onTile={vi.fn()} />);

    expect(screen.getByText("KPI READ FAILED")).toBeTruthy();
    for (const t of TILES) {
      expect(screen.queryByLabelText(`${t.label} — drill to ledger events`), `no ${t.label} tile beside an error`).toBeNull();
    }
  });
});
