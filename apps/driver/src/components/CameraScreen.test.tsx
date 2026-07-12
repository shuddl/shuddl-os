// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { CameraScreen } from "./CameraScreen.js";

// The forced-photo guarantee proven at the CAPTURE UI (REQ-063), not just at the reducer: a real
// capture requires a LIVE camera; a denied camera is BLOCKED; a stub render shows the viewfinder but
// cannot produce a capturable frame. `frameDataUrl` is mocked to mirror real behavior — it yields a URL
// ONLY for a video with dimensions (a live frame) and null otherwise — because jsdom has no 2D canvas.
vi.mock("../lib/capture-bytes.js", () => ({
  frameDataUrl: (video: { videoWidth?: number } | null) =>
    video && (video.videoWidth ?? 0) > 0 ? "data:image/png;base64,LIVEFRAME" : null,
  bytesFromDataUrl: (s: string) => new TextEncoder().encode(s),
}));

const PROPS = {
  header: "STOP 1 · PICKUP · 3/6",
  progress: 0.4,
  question: "Photograph the freight",
  caption: "FRAME ALL PIECES",
};

function setGetUserMedia(impl: undefined | (() => Promise<MediaStream>)): void {
  if (impl === undefined) {
    Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
    return;
  }
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: impl },
    configurable: true,
  });
}

function fakeStream(): MediaStream {
  return { getTracks: () => [] } as unknown as MediaStream;
}

beforeEach(() => {
  // jsdom's HTMLMediaElement.play is unimplemented; make it resolve so the live path doesn't fall back.
  window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CameraScreen — a real capture REQUIRES a live camera (REQ-063)", () => {
  it("DENIED camera (no getUserMedia): BLOCKED — permission-required, ADVANCE disabled, no capture path", async () => {
    setGetUserMedia(undefined);
    const onCommit = vi.fn();
    const { getByText } = render(<CameraScreen {...PROPS} onCommit={onCommit} />);

    await waitFor(() => getByText("CAMERA PERMISSION REQUIRED"));
    const advance = getByText("Advance").closest("button");
    expect(advance).not.toBeNull();
    expect(advance?.disabled).toBe(true); // cannot advance without a live camera
    getByText("Enable camera"); // a re-request affordance is offered
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("STUB render (denied + stubViewfinder): shows the dark viewfinder + SHUTTER, but a tap makes NO capture", async () => {
    setGetUserMedia(undefined);
    const onCommit = vi.fn();
    const { getByText } = render(<CameraScreen {...PROPS} onCommit={onCommit} stubViewfinder />);

    await waitFor(() => getByText("CAMERA · DARK"));
    const shutter = getByText("Shutter").closest("button");
    const advance = getByText("Advance").closest("button");
    expect(advance?.disabled).toBe(true);

    // Tapping SHUTTER in the stub render must NOT fabricate a frame — ADVANCE stays disabled forever.
    fireEvent.click(shutter as HTMLButtonElement);
    fireEvent.click(shutter as HTMLButtonElement);
    expect(getByText("Advance").closest("button")?.disabled).toBe(true);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("LIVE camera: SHUTTER captures a frame → ADVANCE enables → commit yields the real bytes", async () => {
    // A live stream present, and a video element that reports real dimensions (a drawable frame).
    Object.defineProperty(window.HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => 1280 });
    Object.defineProperty(window.HTMLVideoElement.prototype, "videoHeight", { configurable: true, get: () => 720 });
    setGetUserMedia(() => Promise.resolve(fakeStream()));
    const onCommit = vi.fn();
    const { getByText } = render(<CameraScreen {...PROPS} onCommit={onCommit} />);

    // Once live, the label flips and ADVANCE is still disabled until a frame is taken.
    await waitFor(() => getByText("CAMERA · LIVE"));
    expect(getByText("Advance").closest("button")?.disabled).toBe(true);

    fireEvent.click(getByText("Shutter").closest("button") as HTMLButtonElement);

    await waitFor(() => getByText("FRAME CAPTURED"));
    const advance = getByText("Advance").closest("button") as HTMLButtonElement;
    expect(advance.disabled).toBe(false); // a real live frame enabled ADVANCE

    fireEvent.click(advance);
    expect(onCommit).toHaveBeenCalledTimes(1);
    const bytes = onCommit.mock.calls[0]?.[0] as Uint8Array;
    expect(ArrayBuffer.isView(bytes)).toBe(true); // realm-agnostic "is a typed array"
    expect(new TextDecoder().decode(bytes)).toContain("LIVEFRAME"); // the REAL live frame's bytes, committed
  });
});
