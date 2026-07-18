import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../lib/api.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/api.js")>("../lib/api.js");
  return { ...actual, get: vi.fn(), post: vi.fn() };
});
import { CopilotPanel } from "./CopilotPanel.js";
import { post } from "../lib/api.js";

const mockPost = post as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => mockPost.mockReset());
afterEach(() => cleanup());

function ask(question: string): void {
  fireEvent.change(screen.getByPlaceholderText("ASK A QUESTION"), { target: { value: question } });
  fireEvent.click(screen.getByText("Ask"));
}

describe("CopilotPanel (REQ-038)", () => {
  it("renders the answer text + its event CITATIONS; a citation clicks through to its shipment's lens", async () => {
    mockPost.mockResolvedValue({
      text: "POD signed at the door.",
      citations: [{ event_id: "e1", kind: "pod.signed", shipment_id: "shp-3" }],
      abstained: false,
    });
    const onOpenShipment = vi.fn();
    render(<CopilotPanel onOpenShipment={onOpenShipment} onClose={vi.fn()} />);

    ask("did shp-3 deliver?");

    expect(await screen.findByText("POD signed at the door.")).toBeTruthy();
    // the citation chip renders the cited event + shipment and deep-links
    const chip = await screen.findByText(/pod\.signed · shp-3/);
    fireEvent.click(chip);
    expect(onOpenShipment).toHaveBeenCalledWith("shp-3");
    expect(mockPost).toHaveBeenCalledWith("/v1/copilot/ask", { question: "did shp-3 deliver?" });
  });

  it("an ABSTENTION is shown HONESTLY (never a fabricated answer, zero citations)", async () => {
    mockPost.mockResolvedValue({ text: "I can't answer that from the ledger.", citations: [], abstained: true });
    render(<CopilotPanel onOpenShipment={vi.fn()} onClose={vi.fn()} />);

    ask("what will next quarter's revenue be?");

    expect(await screen.findByText("I can't answer that from the ledger.")).toBeTruthy();
    expect(screen.queryByText(/CITATIONS/)).toBeNull();
  });

  it("a copilot fault surfaces honestly (no fabricated answer)", async () => {
    const { ApiError } = await vi.importActual<typeof import("../lib/api.js")>("../lib/api.js");
    mockPost.mockRejectedValueOnce(new ApiError("INTERNAL", 503, "COPILOT UNAVAILABLE"));
    render(<CopilotPanel onOpenShipment={vi.fn()} onClose={vi.fn()} />);

    ask("anything");
    expect(await screen.findByText(/COPILOT UNAVAILABLE/)).toBeTruthy();
  });
});
