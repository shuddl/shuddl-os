import { describe, expect, it } from "vitest";
import { bytesFromDataUrl, frameDataUrl } from "./capture-bytes.js";

// REQ-063 — the capture leg must NEVER fabricate a frame. With no live video the forced photo cannot be
// satisfied by a content-free stub; `frameDataUrl` returns null and the caller keeps ADVANCE disabled.
// (The positive path needs a real 2D canvas — proven by the live-render harness + the CameraScreen test.)
describe("frameDataUrl — a capture requires a REAL live frame (no synthetic stub)", () => {
  it("returns null when there is no video element (denied camera / headless render)", () => {
    expect(frameDataUrl(null)).toBeNull();
  });

  it("returns null when the stream has no dimensions yet (not-yet-live)", () => {
    // A zero-dimension element is the "camera present but no frame" case — still no capturable frame.
    const fake = { videoWidth: 0, videoHeight: 0 } as unknown as HTMLVideoElement;
    expect(frameDataUrl(fake)).toBeNull();
    // The early return means `document` is never touched — proving no canvas/stub is ever created.
    expect(frameDataUrl({ videoWidth: 0, videoHeight: 200 } as unknown as HTMLVideoElement)).toBeNull();
    expect(frameDataUrl({ videoWidth: 200, videoHeight: 0 } as unknown as HTMLVideoElement)).toBeNull();
  });
});

describe("bytesFromDataUrl — self-consistent hashing bytes", () => {
  it("encodes the data URL to its UTF-8 bytes, deterministically", () => {
    const a = bytesFromDataUrl("data:image/png;base64,AAAA");
    const b = bytesFromDataUrl("data:image/png;base64,AAAA");
    expect(a).toBeInstanceOf(Uint8Array);
    expect(Array.from(a)).toEqual(Array.from(b)); // same string → same bytes → same hash
    expect(a.length).toBeGreaterThan(0);
  });
});
