import { describe, expect, it } from "vitest";
import { build214, DEFAULT_004010, dialectStatus } from "@shuddl/edi";
import { buildStatusView } from "../src/core/build-214.js";

// WP-12 Task 6 · REQ-200 — the 214 status-projection core. buildStatusView filters a ledger event list to the
// SHUDDL status kinds, maps each to its AT7 wire code THROUGH the single-source-of-truth dialect (DEFAULT_004010,
// per-partner overridable), and emits a byte-stable StatusView + a deterministic dedupe key. PURE — no I/O.
// The event `ts` is the canonical integer epoch-ms (events.ts SafeInt); the wire date/time is derived from it.
describe("buildStatusView — 214 status projection + dedupe key (REQ-200)", () => {
  const tsArrived = Date.UTC(2026, 6, 17, 9, 30); // 2026-07-17T09:30:00.000Z
  const tsMsg = Date.UTC(2026, 6, 17, 10, 0);
  const tsDeparted = Date.UTC(2026, 6, 17, 10, 15);

  const events = [
    { id: "evt-arr-1", kind: "stop.arrived", ts: tsArrived, payload: { city: "PORTLAND", state: "OR" } },
    // a non-status event interleaved — must be filtered OUT
    { id: "evt-msg-1", kind: "message.sent", ts: tsMsg, payload: {} },
    // departure (the NEWEST status event by numeric ts → owns the dedupe key)
    { id: "evt-dep-1", kind: "stop.departed", ts: tsDeparted, payload: { city: "PORTLAND", state: "OR" } },
  ];

  const input = { shipmentRef: "SHP-42", partnerScac: "ACME", isaControl: "000000042", gsControl: "42", events };

  it("maps each SHUDDL status kind → its AT7 code and drops non-status events", () => {
    const { view } = buildStatusView(input);
    expect(view.shipmentRef).toBe("SHP-42");
    expect(view.partnerScac).toBe("ACME");
    expect(view.stops).toHaveLength(2);
    // AT7 codes come from DEFAULT_004010 via dialectStatus — never a duplicated map. The wire ts is the UTC ISO
    // rendering of the integer epoch-ms row ts.
    expect(view.stops[0]).toEqual({
      statusCode: dialectStatus("arrived", DEFAULT_004010), // X3
      ts: new Date(tsArrived).toISOString(),
      city: "PORTLAND",
      state: "OR",
    });
    expect(view.stops[1]).toEqual({
      statusCode: dialectStatus("departed", DEFAULT_004010), // AF
      ts: new Date(tsDeparted).toISOString(),
      city: "PORTLAND",
      state: "OR",
    });
    expect(() => build214(view)).not.toThrow(); // serializes through the real @shuddl/edi build214
  });

  it("dedupeKey = edi214/<newest status event id> and is stable across re-runs", () => {
    const a = buildStatusView(input);
    const b = buildStatusView(input);
    expect(a.dedupeKey).toBe("edi214/evt-dep-1");
    expect(a.dedupeKey).toBe(b.dedupeKey);
    expect(a.view).toEqual(b.view);
  });

  it("picks the newest by NUMERIC ts, not lexicographic string order", () => {
    // 9 vs 100: string compare would rank "9" > "100" (wrong); numeric ranks 100 newest (right).
    const { dedupeKey } = buildStatusView({
      ...input,
      events: [
        { id: "evt-late", kind: "stop.departed", ts: 100, payload: {} },
        { id: "evt-early", kind: "stop.arrived", ts: 9, payload: {} },
      ],
    });
    expect(dedupeKey).toBe("edi214/evt-late");
  });

  it("empty status list → empty stops and a stable empty-marker dedupe key", () => {
    const { view, dedupeKey } = buildStatusView({ ...input, events: [{ id: "evt-msg-1", kind: "message.sent", ts: tsMsg, payload: {} }] });
    expect(view.stops).toHaveLength(0);
    expect(dedupeKey).toBe("edi214/none");
  });
});
