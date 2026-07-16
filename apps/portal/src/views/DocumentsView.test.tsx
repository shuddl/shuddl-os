import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// Mock the api client: get becomes a spy, ApiError stays the REAL class (isAuthError works,
// `instanceof ApiError` holds). apiBase stays real so the resolved bytes URL is deterministic.
vi.mock("../lib/api.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/api.js")>("../lib/api.js");
  return { ...actual, get: vi.fn(), post: vi.fn() };
});
import { DocumentsView } from "./DocumentsView.js";
import { ApiError, apiBase, get } from "../lib/api.js";

const mockGet = get as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => mockGet.mockReset());
afterEach(() => cleanup());

describe("DocumentsView (REQ-085)", () => {
  it("lists the shipment's lens-visible documents (whatever the server returns — the server is the gate)", async () => {
    mockGet.mockResolvedValue({
      documents: [
        { id: "doc-1", shipment_id: "SHP-1", party_id: "party-9", kind: "pod", visibility: "counterparty" },
        { id: "doc-2", shipment_id: "SHP-1", party_id: "party-9", kind: "bol", visibility: "public" },
      ],
    });
    render(<DocumentsView shipmentId="SHP-1" onAuthError={vi.fn()} />);

    await screen.findByText(/pod/i);
    expect(screen.getByText(/bol/i)).toBeTruthy();
    // the list read is lens-scoped to the shipment
    expect(mockGet).toHaveBeenCalledWith("/v1/shipments/SHP-1/documents");
    // there is a download affordance per doc
    expect(screen.getAllByRole("button", { name: /download/i }).length).toBe(2);
  });

  it("download resolves a signed URL then opens the /pub/documents bytes URL on the API origin", async () => {
    // The component calls the list read first (on mount), then the url read (on click) — mock them in order.
    mockGet
      .mockResolvedValueOnce({ documents: [{ id: "doc-1", shipment_id: "SHP-1", party_id: "party-9", kind: "pod", visibility: "counterparty" }] })
      .mockResolvedValueOnce({ url: "/pub/documents/CAP123", expires_in: 300 });
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    render(<DocumentsView shipmentId="SHP-1" onAuthError={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /download/i }));

    await waitFor(() => expect(openSpy).toHaveBeenCalled());
    expect(mockGet).toHaveBeenCalledWith("/v1/documents/doc-1/url");
    const opened = openSpy.mock.calls[0]?.[0] as string;
    expect(opened).toBe(`${apiBase()}/pub/documents/CAP123`);
    openSpy.mockRestore();
  });

  it("an empty list renders a clean empty state (no docs the party may see)", async () => {
    mockGet.mockResolvedValue({ documents: [] });
    render(<DocumentsView shipmentId="SHP-1" onAuthError={vi.fn()} />);
    expect((await screen.findByText(/no documents/i)).textContent).toBeTruthy();
  });

  it("a 401 from the list read drops the session (onAuthError)", async () => {
    const onAuthError = vi.fn();
    mockGet.mockRejectedValueOnce(new ApiError("UNAUTHORIZED", 401, "NO SESSION"));
    render(<DocumentsView shipmentId="SHP-1" onAuthError={onAuthError} />);
    await waitFor(() => expect(onAuthError).toHaveBeenCalledTimes(1));
  });
});
