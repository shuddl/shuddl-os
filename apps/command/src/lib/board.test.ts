import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBoard, fetchShipmentEvents } from "./board.js";

// WP-10 Task 9 (REQ-073/080) — the board data seam. fetchBoard maps the server's {shipment_id, lat_e6, lon_e6,
// status} rows to the FleetItem[] the map consumes; fetchShipmentEvents maps the lens-scoped event tail to
// LensEvent[]. `fetch` is mocked per-test (no network). The truthful-map decisions (at_rest dot, no fabricated
// heading, exact geo) are asserted here so a regression that invents a bearing/kind fails loudly.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("fetchBoard (REQ-073/080)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps microdegree positions to decimal degrees and preserves the mapped status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          board: [
            { shipment_id: "shp-1", lat_e6: 41_000_000, lon_e6: -74_000_000, status: "healthy" },
            { shipment_id: "shp-2", lat_e6: 40_000_000, lon_e6: -75_000_000, status: "exception" },
          ],
        }),
      ),
    );

    const fleet = await fetchBoard();

    expect(fleet).toHaveLength(2);
    const one = fleet[0];
    expect(one?.lat).toBe(41);
    expect(one?.lng).toBe(-74);
    expect(one?.shipment_id).toBe("shp-1");
    expect(one?.id).toBe("shp-1");
    // TRUTHFUL MAP: a board mark is a last-known DOT with no invented heading.
    expect(one?.kind).toBe("at_rest");
    expect(one?.bearing).toBe(0);
    expect(one?.status).toBe("healthy");
    // The exception row carries the exception status → the map arms world-dim/pulse (demo #5).
    expect(fleet[1]?.status).toBe("exception");
  });

  it("returns an empty fleet for an empty board (no synthetic marks)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ board: [] })));
    expect(await fetchBoard()).toEqual([]);
  });

  it("rejects a malformed board body (Zod at the boundary) rather than rendering a half-fleet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ board: [{ shipment_id: "shp-1", lat_e6: 1, lon_e6: 2, status: "green" }] })),
    );
    await expect(fetchBoard()).rejects.toBeTruthy(); // unknown status → parse throw
  });
});

describe("fetchShipmentEvents (REQ-073/080)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps the lens-scoped event tail to LensEvent[] (kind + HH:MM), ignoring extra ledger fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          events: [
            { kind: "booking.created", ts: 1_720_000_000_000, hash: "abc", payload: { x: 1 } },
            { kind: "pod.signed", ts: 1_720_000_060_000, hash: "def" },
          ],
          next_cursor: null,
        }),
      ),
    );

    const tail = await fetchShipmentEvents("shp-1");

    expect(tail).toHaveLength(2);
    expect(tail[0]?.kind).toBe("booking.created");
    expect(tail[0]?.at).toMatch(/^\d{2}:\d{2}$/); // HH:MM, deterministic UTC
    expect(tail[1]?.kind).toBe("pod.signed");
  });
});
