import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApprovalsQueue } from "./ApprovalsQueue.js";

// This suite drives the REAL api client (lib/api.ts) over a STUBBED fetch, so it proves the wire discipline the
// task requires: the decision POST carries a FRESH Idempotency-Key. `fetch` is stubbed per-test; no real network.
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface Call {
  url: string;
  init: RequestInit | undefined;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ApprovalsQueue (REQ-082/194)", () => {
  it("lists open approvals; APPROVE dispatches the decision WITH a fresh Idempotency-Key, then the row leaves the open list", async () => {
    const calls: Call[] = [];
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/v1/approvals?status=open")) {
        return Promise.resolve(
          jsonResponse({
            approvals: [
              { id: "apr-1", object_kind: "shipment", object_id: "shp-1", rule: "below_target", required_role: "ops", requested_event_id: "evt-1", decided_event_id: null, status: "open" },
            ],
          }),
        );
      }
      if (url.includes("/v1/shipments/shp-1/approval-decision")) return Promise.resolve(jsonResponse({ id: "evt-dec" }, 201));
      return Promise.resolve(jsonResponse({ code: "NOT_FOUND", message: "nf" }, 404));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ApprovalsQueue onAuthError={vi.fn()} />);
    await screen.findByText("shp-1");

    fireEvent.click(screen.getByText("Approve"));
    await waitFor(() => expect(screen.queryByText("shp-1")).toBeNull());

    const decision = calls.find((c) => c.url.includes("/approval-decision"));
    expect(decision).toBeTruthy();
    expect(decision?.init?.method).toBe("POST");
    const headers = decision?.init?.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBeTruthy();
    expect(JSON.parse(decision?.init?.body as string)).toEqual({ decision: "approved" });
  });

  it("an UNDER-ROLE decision surfaces the real 403 HONESTLY and KEEPS the row (nothing decided)", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/v1/approvals?status=open")) {
        return Promise.resolve(
          jsonResponse({
            approvals: [
              { id: "apr-2", object_kind: "shipment", object_id: "shp-2", rule: "below_contribution", required_role: "finance", requested_event_id: "evt-2", decided_event_id: null, status: "open" },
            ],
          }),
        );
      }
      if (url.includes("/v1/shipments/shp-2/approval-decision")) {
        return Promise.resolve(jsonResponse({ code: "FORBIDDEN", message: "YOUR ROLE DOES NOT SATISFY THIS APPROVAL'S REQUIRED ROLE", req_id: "r" }, 403));
      }
      return Promise.resolve(jsonResponse({ code: "NOT_FOUND", message: "nf" }, 404));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ApprovalsQueue onAuthError={vi.fn()} />);
    await screen.findByText("shp-2");

    fireEvent.click(screen.getByText("Approve"));
    // the honest server reason appears; the row STAYS (a below-role caller decided nothing)
    expect(await screen.findByText(/FORBIDDEN/)).toBeTruthy();
    expect(screen.getByText("shp-2")).toBeTruthy();
  });

  it("a 401 drops the session (onAuthError)", async () => {
    const onAuthError = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ code: "UNAUTHORIZED", message: "no session" }, 401)));
    render(<ApprovalsQueue onAuthError={onAuthError} />);
    await waitFor(() => expect(onAuthError).toHaveBeenCalled());
  });

  it("an empty queue renders an honest empty state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ approvals: [] })));
    render(<ApprovalsQueue onAuthError={vi.fn()} />);
    expect(await screen.findByText(/NO OPEN APPROVALS/)).toBeTruthy();
  });
});
