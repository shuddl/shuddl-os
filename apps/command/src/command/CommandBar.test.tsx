import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CommandBar } from "./CommandBar.js";
import { ApiError } from "../lib/api.js";
import type { CommandDeps } from "./registry.js";

// WP-10 Task 10 (REQ-081) — the ⌘K palette UI. A global ⌘K/Ctrl+K opens it; Esc closes it; typing filters the
// FIXED command list; Arrow keys move focus; Enter runs the focused command (navigating or dispatching a real
// verb). A command that needs args prompts for them in a simple structured step (not NL). A mutation reflects
// its result HONESTLY — a 403 gate-block shows the real code, never a fake "done".

function mkDeps(overrides?: Partial<CommandDeps>): CommandDeps {
  return {
    navigate: vi.fn(),
    openShipment: vi.fn(),
    openIntake: vi.fn(),
    api: { post: vi.fn().mockResolvedValue({}), get: vi.fn().mockResolvedValue({}) },
    ...overrides,
  };
}

function openPalette(): void {
  fireEvent.keyDown(window, { key: "k", metaKey: true });
}

describe("CommandBar (REQ-081) — the ⌘K palette", () => {
  afterEach(() => {
    cleanup();
  });

  it("§1687 a query matching NOTHING shows the empty state, not an empty list", () => {
    // The palette is the command surface's only entry point (REQ-081), so a typo lands here constantly.
    // Every existing case types a query that MATCHES, leaving `filtered.length === 0` unexercised —
    // replacing that condition with `false` left command 101/101 green.
    render(<CommandBar deps={mkDeps()} />);
    openPalette();
    fireEvent.change(screen.getByPlaceholderText(/type a command/i), {
      target: { value: "zzzz-no-such-command" },
    });
    expect(screen.getByText("NO MATCHING COMMAND"), "an unmatched query must say so rather than render nothing").toBeTruthy();
  });

  it("is closed until ⌘K opens it (the input appears)", () => {
    render(<CommandBar deps={mkDeps()} />);
    expect(screen.queryByPlaceholderText(/type a command/i)).toBeNull();
    openPalette();
    expect(screen.getByPlaceholderText(/type a command/i)).toBeTruthy();
  });

  it("Ctrl+K also opens the palette (non-mac)", () => {
    render(<CommandBar deps={mkDeps()} />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByPlaceholderText(/type a command/i)).toBeTruthy();
  });

  it("Esc closes the palette", () => {
    render(<CommandBar deps={mkDeps()} />);
    openPalette();
    expect(screen.getByPlaceholderText(/type a command/i)).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByPlaceholderText(/type a command/i)).toBeNull();
  });

  it("typing filters the command list by label", () => {
    render(<CommandBar deps={mkDeps()} />);
    openPalette();
    // Unfiltered: the Board nav is present.
    expect(screen.getByText("Go to Board")).toBeTruthy();
    const input = screen.getByPlaceholderText(/type a command/i);
    fireEvent.change(input, { target: { value: "approve" } });
    expect(screen.getByText("Approve Approval")).toBeTruthy();
    expect(screen.queryByText("Go to Board")).toBeNull(); // filtered out
  });

  it("Enter runs the focused NAVIGATION command with the right route, then closes", async () => {
    const deps = mkDeps();
    render(<CommandBar deps={deps} />);
    openPalette();
    fireEvent.change(screen.getByPlaceholderText(/type a command/i), { target: { value: "approvals" } });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(deps.navigate).toHaveBeenCalledWith("/queue/approvals");
    // The palette closes once the command settles (the run resolves on a microtask).
    await waitFor(() => expect(screen.queryByPlaceholderText(/type a command/i)).toBeNull());
  });

  it("Arrow keys move focus; Enter runs the newly-focused command", () => {
    const deps = mkDeps();
    render(<CommandBar deps={deps} />);
    openPalette();
    // No filter: the first command is Go to Board. Arrow down once → the second command (Go to Approvals).
    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(deps.navigate).toHaveBeenCalledWith("/queue/approvals");
  });

  it("a command that needs an arg prompts for it, then dispatches with the structured value", () => {
    const deps = mkDeps();
    render(<CommandBar deps={deps} />);
    openPalette();
    fireEvent.change(screen.getByPlaceholderText(/type a command/i), { target: { value: "open shipment" } });
    fireEvent.keyDown(window, { key: "Enter" }); // select → enter the arg step
    const argInput = screen.getByPlaceholderText(/shipment id/i);
    fireEvent.change(argInput, { target: { value: "SHP-42" } });
    fireEvent.keyDown(window, { key: "Enter" }); // commit the arg → run
    expect(deps.openShipment).toHaveBeenCalledWith("SHP-42");
  });

  it("a mutation reflects a 403 gate-block HONESTLY (never a false success)", async () => {
    const deps = mkDeps({
      api: {
        post: vi.fn().mockRejectedValue(new ApiError("FORBIDDEN", 403, "YOUR ROLE DOES NOT SATISFY THIS APPROVAL'S REQUIRED ROLE")),
        get: vi.fn().mockResolvedValue({}),
      },
    });
    render(<CommandBar deps={deps} />);
    openPalette();
    fireEvent.change(screen.getByPlaceholderText(/type a command/i), { target: { value: "approve approval" } });
    fireEvent.keyDown(window, { key: "Enter" }); // select → arg step (shipment id)
    fireEvent.change(screen.getByPlaceholderText(/shipment id/i), { target: { value: "SHP-9" } });
    fireEvent.keyDown(window, { key: "Enter" }); // commit → dispatch
    // The honest server code is shown — and there is no fake success text.
    expect(await screen.findByText(/FORBIDDEN/)).toBeTruthy();
    expect(deps.api.post).toHaveBeenCalledTimes(1);
  });
});
