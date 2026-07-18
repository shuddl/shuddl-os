import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../lib/api.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/api.js")>("../lib/api.js");
  return { ...actual, get: vi.fn(), post: vi.fn() };
});
import { KpiDrill } from "./KpiDrill.js";
import { get } from "../lib/api.js";

const mockGet = get as unknown as ReturnType<typeof vi.fn>;

const KPIS = {
  kpis: [
    { key: "unbilled", label: "Unbilled PODs", value: 2, unit: "count", backing: { kinds: ["pod.signed", "invoice.issued"] } },
    { key: "dso", label: "DSO (open AR age)", value: 38, unit: "days", backing: { kinds: ["invoice.issued", "payment.received"] } },
  ],
};

// A defensive router: matches by path prefix; a stray/late async call (test-teardown timing) resolves benign,
// never throws. The assertions below pin the EXACT calls that matter.
function route(events: unknown[]): (path?: string) => Promise<unknown> {
  return (path?: string) => {
    if (typeof path === "string" && path.startsWith("/v1/kpis")) return Promise.resolve(KPIS);
    if (typeof path === "string" && path.startsWith("/v1/events")) return Promise.resolve({ events, next_cursor: null });
    return Promise.resolve({ kpis: [], events: [], next_cursor: null });
  };
}

beforeEach(() => mockGet.mockReset());
afterEach(() => cleanup());

describe("KpiDrill (REQ-083/084)", () => {
  it("resolves the tile's backing kinds and reads GET /v1/events?kind=<kinds> (every KPI clicks through to its ledger events)", async () => {
    mockGet.mockImplementation(route([{ id: "e1", kind: "pod.signed", ts: 1_720_000_000_000, shipment_id: "shp-7" }]));

    const onOpenShipment = vi.fn();
    render(<KpiDrill metric="unbilled" onSelectMetric={vi.fn()} onOpenShipment={onOpenShipment} onClose={vi.fn()} onAuthError={vi.fn()} />);

    // it deep-links to the EXACT backing events via the Task-1 kind filter
    await screen.findByText("pod.signed");
    expect(mockGet).toHaveBeenCalledWith("/v1/events?kind=pod.signed%2Cinvoice.issued");
    // and the canonical detail view is named (v_unbilled), not a fabricated 13th view
    expect(screen.getByText("v_unbilled")).toBeTruthy();

    // a backing event clicks through to its shipment's lens
    fireEvent.click(screen.getByText("pod.signed"));
    expect(onOpenShipment).toHaveBeenCalledWith("shp-7");
  });

  it("the drill INDEX (no metric) lists the KPIs to pick and does NOT fetch events", async () => {
    mockGet.mockImplementation(route([]));
    const onSelectMetric = vi.fn();
    render(<KpiDrill metric={null} onSelectMetric={onSelectMetric} onOpenShipment={vi.fn()} onClose={vi.fn()} onAuthError={vi.fn()} />);

    fireEvent.click(await screen.findByText("DSO (open AR age)"));
    expect(onSelectMetric).toHaveBeenCalledWith("dso");
    // the index drills nothing — no kind-filtered events read happens
    expect(mockGet.mock.calls.some((c) => typeof c[0] === "string" && (c[0] as string).startsWith("/v1/events"))).toBe(false);
  });
});
