// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { StopScreen } from "./StopScreen.js";
import type { FlowStep } from "../flow/stop-flow.js";

// §860 — THE COUNT GATE, WHICH EXISTS BECAUSE OF A REAL DEFECT AND WAS PINNED BY NOTHING.
//
// StopScreen's own prop doc records what it is for: "2026-08-01: a hardcoded 6 used to be recorded on every
// pickup". The fix was to make the driver's real answer the gate — the button stays dead until the field
// holds a positive integer, so the recorded fact is what was counted, never a constant.
//
// A guard that replaced a shipped defect is the single worst thing to leave untested: the defect it prevents
// has already happened once, which is proof the mistake is reachable. §858 and §859 each named this component
// as uncovered and neither covered it — twice deferred is how this kind of debt survives.
//
// The third of the three children `GatedFlow.test.tsx` mocks (with CameraScreen §-063 and SignatureScreen
// §858). This closes that set.

const STEP: FlowStep = {
  id: "count" as FlowStep["id"],
  requires: [],
  forcedPhoto: false,
  terminal: false,
  question: "How many pieces?",
  action: "Confirm count",
  caption: "COUNT EVERY PIECE",
};

const terminal = (): FlowStep => ({ ...STEP, terminal: true, question: "Depart", action: "Depart stop" });

const PROPS = { header: "STOP 1 · PICKUP · 2/6", progress: 0.3 };

const button = (getByText: (t: string) => HTMLElement, label: string) =>
  getByText(label).closest("button") as HTMLButtonElement;

afterEach(cleanup);

describe("§860: StopScreen — the counted number is the driver's, never a constant (REQ-062)", () => {
  it("a step with NO count field advances freely — the gate is the count's, not every step's", () => {
    // Non-vacuity for every disabled-assertion below: proves the button is not simply always dead.
    const onComplete = vi.fn();
    const { getByText } = render(<StopScreen {...PROPS} step={STEP} onComplete={onComplete} />);

    expect(button(getByText, "Confirm count").disabled).toBe(false);
    fireEvent.click(button(getByText, "Confirm count"));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("EMPTY count: the gate is shut — this is the hardcoded-6 defect, refused", () => {
    const onComplete = vi.fn();
    const { getByText } = render(
      <StopScreen {...PROPS} step={STEP} onComplete={onComplete} count={{ value: undefined, onChange: vi.fn() }} />,
    );

    expect(button(getByText, "Confirm count").disabled, "no count, no advance").toBe(true);
    fireEvent.click(button(getByText, "Confirm count"));
    expect(onComplete, "a disabled gate must record nothing").not.toHaveBeenCalled();
  });

  it("a REAL count opens the gate and is handed up as a number", () => {
    const onChange = vi.fn();
    const onComplete = vi.fn();
    const { getByLabelText, getByText, rerender } = render(
      <StopScreen {...PROPS} step={STEP} onComplete={onComplete} count={{ value: undefined, onChange }} />,
    );

    fireEvent.change(getByLabelText("PIECE COUNT"), { target: { value: "14" } });
    expect(onChange).toHaveBeenCalledWith(14);

    // The parent owns the value; re-render with what the driver counted.
    rerender(<StopScreen {...PROPS} step={STEP} onComplete={onComplete} count={{ value: 14, onChange }} />);
    expect(button(getByText, "Confirm count").disabled).toBe(false);
    fireEvent.click(button(getByText, "Confirm count"));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("ZERO and NEGATIVE are not counts — the field reports undefined and the gate stays shut", () => {
    // A pickup of zero pieces is not a pickup. Accepting it would put a falsifiable number on the ledger.
    const onChange = vi.fn();
    const { getByLabelText, getByText } = render(
      <StopScreen {...PROPS} step={STEP} onComplete={vi.fn()} count={{ value: undefined, onChange }} />,
    );

    fireEvent.change(getByLabelText("PIECE COUNT"), { target: { value: "0" } });
    expect(onChange).toHaveBeenLastCalledWith(undefined);

    fireEvent.change(getByLabelText("PIECE COUNT"), { target: { value: "-3" } });
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    expect(button(getByText, "Confirm count").disabled).toBe(true);
  });

  it("non-numeric input yields undefined, never NaN — nothing unrenderable reaches the parent", () => {
    // `Number.parseInt("abc")` is NaN. Handing NaN up would make `value={NaN}` and defeat the integer
    // check by way of a number that is not one.
    const onChange = vi.fn();
    const { getByLabelText } = render(
      <StopScreen {...PROPS} step={STEP} onComplete={vi.fn()} count={{ value: undefined, onChange }} />,
    );

    fireEvent.change(getByLabelText("PIECE COUNT"), { target: { value: "abc" } });
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    expect(onChange.mock.calls.every(([n]) => n === undefined || Number.isInteger(n))).toBe(true);
  });

  it.each([
    ["a fraction", 2.5],
    ["zero", 0],
    ["a negative", -2],
    ["NaN", Number.NaN],
  ])("the gate refuses %s supplied by the PARENT, not just typed into the field", (_label, value) => {
    // `countMissing` re-checks rather than trusting its own input path, and this pins BOTH halves of that
    // re-check. MEASURED (§860): with only the fraction case, deleting `count.value <= 0` from the gate was
    // SILENT — the input handler's `n > 0` means today's single writer can never produce a zero, so the
    // branch was construction-forbidden and untested. `count` is a public prop, though, and the component
    // already re-validates integrality for exactly that reason; pinning one half of a two-part boundary
    // check and not the other is the inconsistency, not the extra assertion.
    const { getByText } = render(
      <StopScreen {...PROPS} step={STEP} onComplete={vi.fn()} count={{ value, onChange: vi.fn() }} />,
    );
    expect(button(getByText, "Confirm count").disabled).toBe(true);
  });

  it("a TERMINAL step reads as a gated transition, not as another gate", () => {
    const { getByText } = render(<StopScreen {...PROPS} step={terminal()} onComplete={vi.fn()} />);
    getByText("TRANSITION · GATED");
    expect(button(getByText, "Depart stop").disabled).toBe(false);
  });

  it("a non-terminal step reads as a required gate and states the offline truth", () => {
    const { getByText } = render(<StopScreen {...PROPS} step={STEP} onComplete={vi.fn()} />);
    getByText("GATE · REQUIRED");
    getByText("How many pieces?");
    getByText("OFFLINE — CAPTURING LOCALLY");
  });
});
