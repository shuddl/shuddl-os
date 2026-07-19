import { describe, expect, it } from "vitest";
import { build214, DEFAULT_004010, dialectStatus } from "@shuddl/edi";
import { buildStatusView } from "../src/core/build-214.js";

// WP-12 Task 6 · REQ-200 — the 214 status-projection core. buildStatusView filters a ledger event list to the
// SHUDDL status kinds, maps each to its AT7 wire code THROUGH the single-source-of-truth dialect (DEFAULT_004010,
// per-partner overridable), and emits a byte-stable StatusView + a deterministic dedupe key. PURE — no I/O.
describe("buildStatusView — 214 status projection + dedupe key (REQ-200)", () => {
  const events = [
    // arrival at Portland, OR
    { id: "evt-arr-1", kind: "stop.arrived", ts: "2026-07-17T09:30", payload: { city: "PORTLAND", state: "OR" } },
    // a non-status event interleaved — must be filtered OUT
    { id: "evt-msg-1", kind: "message.sent", ts: "2026-07-17T10:00", payload: {} },
    // departure at Portland, OR (the NEWEST status event → owns the dedupe key)
    { id: "evt-dep-1", kind: "stop.departed", ts: "2026-07-17T10:15", payload: { city: "PORTLAND", state: "OR" } },
  ];

  const input = {
    shipmentRef: "SHP-42",
    partnerScac: "ACME",
    isaControl: "000000042",
    gsControl: "42",
    events,
  };

  it("maps each SHUDDL status kind → its AT7 code and drops non-status events", () => {
    const { view } = buildStatusView(input);
    expect(view.shipmentRef).toBe("SHP-42");
    expect(view.partnerScac).toBe("ACME");
    expect(view.isaControl).toBe("000000042");
    expect(view.gsControl).toBe("42");
    // Only the two status events survive; the message.sent is filtered out.
    expect(view.stops).toHaveLength(2);
    // AT7 codes come from DEFAULT_004010 via dialectStatus — never a duplicated map.
    expect(view.stops[0]).toEqual({
      statusCode: dialectStatus("arrived", DEFAULT_004010), // X3
      ts: "2026-07-17T09:30",
      city: "PORTLAND",
      state: "OR",
    });
    expect(view.stops[1]).toEqual({
      statusCode: dialectStatus("departed", DEFAULT_004010), // AF
      ts: "2026-07-17T10:15",
      city: "PORTLAND",
      state: "OR",
    });
    // The produced view serializes through the real @shuddl/edi build214 (byte-stable, no throw).
    expect(() => build214(view)).not.toThrow();
  });

  it("dedupeKey = edi214/<newest status event id> and is stable across re-runs", () => {
    const a = buildStatusView(input);
    const b = buildStatusView(input);
    expect(a.dedupeKey).toBe("edi214/evt-dep-1"); // newest by ts, the message.sent excluded
    expect(a.dedupeKey).toBe(b.dedupeKey); // deterministic
    expect(a.view).toEqual(b.view);
  });

  it("empty status list → empty stops and a stable empty-marker dedupe key", () => {
    const { view, dedupeKey } = buildStatusView({ ...input, events: [{ id: "evt-msg-1", kind: "message.sent", ts: "2026-07-17T10:00", payload: {} }] });
    expect(view.stops).toHaveLength(0);
    expect(dedupeKey).toBe("edi214/none");
  });
});
