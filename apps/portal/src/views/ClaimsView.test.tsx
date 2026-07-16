import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../lib/api.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/api.js")>("../lib/api.js");
  return { ...actual, get: vi.fn(), post: vi.fn() };
});
import { ClaimsView } from "./ClaimsView.js";
import { ApiError, get, post } from "../lib/api.js";

const mockGet = get as unknown as ReturnType<typeof vi.fn>;
const mockPost = post as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
});
afterEach(() => cleanup());

// A custody chain arriving ascending by seq under the party lens. Includes an untyped exception.raised and a
// NON-chain event (quote.priced) that must be filtered out.
const CHAIN = {
  events: [
    { id: "e1", kind: "custody.transferred", seq: 3, ts: 1, payload: { from_party: "p-a", to_party: "p-b" } },
    { id: "e2", kind: "quote.priced", seq: 4, ts: 2, payload: { sell: 148000 } },
    { id: "e3", kind: "exception.raised", seq: 5, ts: 3, payload: { code: "DAMAGE", note: "corner crushed" } },
    { id: "e4", kind: "pod.signed", seq: 6, ts: 4, payload: { signer_name: "R. Doe" } },
    { id: "e5", kind: "delivery.evidenced", seq: 7, ts: 5, payload: {} },
  ],
};

describe("ClaimsView (REQ-085)", () => {
  it("renders the custody CHAIN in order and filters out non-chain events", async () => {
    mockGet.mockResolvedValue(CHAIN);
    render(<ClaimsView shipmentId="SHP-1" onAuthError={vi.fn()} />);

    await screen.findByText(/custody transferred/i);
    expect(screen.getByText(/exception/i)).toBeTruthy();
    expect(screen.getByText(/pod signed|proof of delivery/i)).toBeTruthy();
    expect(screen.getByText(/delivery evidenced|delivered/i)).toBeTruthy();
    // a non-chain event is not shown
    expect(screen.queryByText(/quote/i)).toBeNull();
    // read the shipment's lens feed
    expect(mockGet).toHaveBeenCalledWith(expect.stringContaining("/v1/shipments/SHP-1/events"));
  });

  it("parses an exception.raised payload DEFENSIVELY (untyped JsonObject) without assuming fields", async () => {
    // A shape with NO recognizable field — must render a generic label and NEVER throw.
    mockGet.mockResolvedValue({
      events: [{ id: "e1", kind: "exception.raised", seq: 1, ts: 1, payload: { unexpected: { nested: [1, 2] } } }],
    });
    render(<ClaimsView shipmentId="SHP-1" onAuthError={vi.fn()} />);
    expect((await screen.findByText(/exception/i)).textContent).toBeTruthy();
  });

  it("File a claim posts to /v1/shipments/:id/claim and shows the filed claim on the timeline", async () => {
    mockGet.mockResolvedValue({ events: [] });
    mockPost.mockResolvedValue({
      id: "e-claim",
      kind: "message.received",
      seq: 20,
      ts: 99,
      payload: { channel: "portal", intent: "claim", body: "Two pallets arrived crushed." },
    });
    render(<ClaimsView shipmentId="SHP-1" onAuthError={vi.fn()} />);

    fireEvent.change(await screen.findByPlaceholderText(/describe/i), {
      target: { value: "Two pallets arrived crushed." },
    });
    fireEvent.click(screen.getByRole("button", { name: /file claim/i }));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith("/v1/shipments/SHP-1/claim", { description: "Two pallets arrived crushed." }),
    );
    expect((await screen.findByText(/claim filed/i)).textContent).toBeTruthy();
  });

  it("a 401 from the chain read drops the session (onAuthError)", async () => {
    const onAuthError = vi.fn();
    mockGet.mockRejectedValueOnce(new ApiError("UNAUTHORIZED", 401, "NO SESSION"));
    render(<ClaimsView shipmentId="SHP-1" onAuthError={onAuthError} />);
    await waitFor(() => expect(onAuthError).toHaveBeenCalledTimes(1));
  });
});
