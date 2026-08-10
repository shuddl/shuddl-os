// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { SignatureScreen } from "./SignatureScreen.js";

// §858 — REQ-064's GATE, PROVEN AT THE COMPONENT. Its sibling already was.
//
// `CameraScreen.test.tsx` proves the REQ-063 forced-photo guard at the capture UI. REQ-064's gate — "ADVANCE
// is dead until the glass holds ink", stated in SignatureScreen's own header — had NO component test. The only
// suite that composes it, `GatedFlow.test.tsx`, MOCKS it out (alongside CameraScreen and StopScreen) so the
// flow can be driven headlessly, which is right for a flow test and means the 155 lines below it were
// exercised by nothing. Two gates, same file, same GatedFlow, one of them proven.
//
// This is REQ-142's built half — "the e-signature CAPTURE mechanism (strokes → hashed bytes → pod.signed)" —
// and acceptance demo #1 opens on it: a signature at a door. The legal-validity notes are counsel's; the
// mechanism is code, and code is testable.
//
// WHY IT WENT UNTESTED, which is the part worth keeping: jsdom implements no 2D canvas context, so
// `getContext("2d")` returns null, every handler early-returns, and a naive render proves nothing while
// appearing to pass. The instrument is therefore a RECORDING fake context — and the suite asserts the fake
// was actually driven, because a stub that silently records nothing is indistinguishable from a component
// that does nothing.

type Call = [string, ...unknown[]];

/** A recording 2D context. jsdom has none; without this every pointer handler returns at its first line. */
function fakeContext(calls: Call[]): CanvasRenderingContext2D {
  const rec =
    (name: string) =>
    (...args: unknown[]): void => {
      calls.push([name, ...args]);
    };
  return {
    beginPath: rec("beginPath"),
    moveTo: rec("moveTo"),
    lineTo: rec("lineTo"),
    stroke: rec("stroke"),
    clearRect: rec("clearRect"),
    strokeStyle: "",
    lineWidth: 0,
    lineCap: "butt",
    lineJoin: "miter",
  } as unknown as CanvasRenderingContext2D;
}

const PROPS = {
  header: "STOP 4 · DELIVERY · 6/6",
  progress: 0.9,
  question: "Signature on delivery",
  caption: "CONSIGNEE SIGNS",
};

const SIGNED_PNG = "data:image/png;base64,SIGNEDGLASS";

let calls: Call[];

beforeEach(() => {
  calls = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    fakeContext(calls) as unknown as ReturnType<HTMLCanvasElement["getContext"]>,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(SIGNED_PNG);
  // jsdom does not implement pointer capture; `down()` calls it on every stroke.
  HTMLCanvasElement.prototype.setPointerCapture = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The glass. It is the only canvas on the screen. */
function glass(c: HTMLElement): HTMLCanvasElement {
  const el = c.querySelector("canvas");
  if (!el) throw new Error("no canvas rendered — the glass is the component");
  return el;
}

const advanceOf = (getByText: (t: string) => HTMLElement) =>
  getByText("Advance").closest("button") as HTMLButtonElement;

/** A real signature: press, drag, lift. `move` is what lays ink — a press alone draws nothing. */
function sign(canvas: HTMLCanvasElement): void {
  fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 10, clientY: 40 });
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 60, clientY: 30 });
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 110, clientY: 55 });
  fireEvent.pointerUp(canvas, { pointerId: 1 });
}

describe("§858: SignatureScreen — ADVANCE is dead until the glass holds ink (REQ-064)", () => {
  it("blank glass: ADVANCE disabled, the prompt asks for a signature, nothing commits", () => {
    const onCommit = vi.fn();
    const { getByText } = render(<SignatureScreen {...PROPS} onCommit={onCommit} />);

    expect(advanceOf(getByText).disabled).toBe(true);
    getByText("SIGN ABOVE THE LINE");
    fireEvent.click(advanceOf(getByText));
    expect(onCommit, "a disabled ADVANCE must not commit an empty signature").not.toHaveBeenCalled();
  });

  it("a TAP is not a signature — press+lift with no drag leaves ADVANCE dead", () => {
    // The distinction the component draws deliberately: `hasInk` is set in `move`, never in `down`. A
    // fingertip brushing the glass in a truck cab must not satisfy a POD gate. Without this test the
    // guard could move to `down` and every other assertion here would still pass.
    const onCommit = vi.fn();
    const { container, getByText } = render(<SignatureScreen {...PROPS} onCommit={onCommit} />);

    fireEvent.pointerDown(glass(container), { pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(glass(container), { pointerId: 1 });

    expect(advanceOf(getByText).disabled).toBe(true);
    getByText("SIGN ABOVE THE LINE");
    expect(calls.some((c) => c[0] === "stroke"), "a tap must lay no ink").toBe(false);
  });

  it("a drag with no press lays no ink (a palm sliding across the glass)", () => {
    const { container, getByText } = render(<SignatureScreen {...PROPS} onCommit={vi.fn()} />);

    fireEvent.pointerMove(glass(container), { pointerId: 1, clientX: 60, clientY: 30 });

    expect(advanceOf(getByText).disabled).toBe(true);
    expect(calls.some((c) => c[0] === "stroke")).toBe(false);
  });

  it("SIGNING: strokes reach the canvas, the label flips, ADVANCE opens, commit yields the glass bytes", () => {
    const onCommit = vi.fn();
    const { container, getByText } = render(<SignatureScreen {...PROPS} onCommit={onCommit} />);

    sign(glass(container));

    // Non-vacuity: the fake context was actually driven. A stub recording nothing looks exactly like a
    // component doing nothing, and every negative assertion above would pass against either.
    expect(calls.filter((c) => c[0] === "lineTo").length, "each move must extend the path").toBe(2);
    expect(calls.filter((c) => c[0] === "stroke").length).toBe(2);
    expect(calls[0]?.[0], "a stroke opens its own path").toBe("beginPath");

    getByText("SIGNATURE CAPTURED");
    const advance = advanceOf(getByText);
    expect(advance.disabled, "ink on the glass opens the gate").toBe(false);

    fireEvent.click(advance);
    expect(onCommit).toHaveBeenCalledTimes(1);
    const bytes = onCommit.mock.calls[0]?.[0] as Uint8Array;
    expect(ArrayBuffer.isView(bytes), "commit hands over bytes, not a data URL").toBe(true);
    // The bytes are the GLASS's, decoded from its data URL — the payload that becomes the pod.signed hash.
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("CLEAR RE-ARMS THE GATE: wiped glass disables ADVANCE again and cannot commit", () => {
    // The gate's most reversible edge, and the one a refactor breaks silently. If `clear()` wiped the
    // pixels but left `hasInk` true, ADVANCE would stay live and the driver would commit a BLANK signature
    // as a POD — evidence for a delivery nobody signed for.
    const onCommit = vi.fn();
    const { container, getByText } = render(<SignatureScreen {...PROPS} onCommit={onCommit} />);

    sign(glass(container));
    expect(advanceOf(getByText).disabled).toBe(false);

    fireEvent.click(getByText("Clear signature"));

    expect(calls.some((c) => c[0] === "clearRect"), "the pixels must actually be wiped").toBe(true);
    expect(advanceOf(getByText).disabled, "a wiped glass must re-close the gate").toBe(true);
    getByText("SIGN ABOVE THE LINE");
    fireEvent.click(advanceOf(getByText));
    expect(onCommit, "a cleared signature must never commit").not.toHaveBeenCalled();
  });

  it("re-signing after CLEAR commits the NEW signature (the gate reopens, it does not latch shut)", () => {
    const onCommit = vi.fn();
    const { container, getByText } = render(<SignatureScreen {...PROPS} onCommit={onCommit} />);

    sign(glass(container));
    fireEvent.click(getByText("Clear signature"));
    sign(glass(container));

    expect(advanceOf(getByText).disabled).toBe(false);
    fireEvent.click(advanceOf(getByText));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
