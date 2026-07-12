// Turn on-glass / on-camera pixels into the evidence bytes the capture leg hashes (REQ-063/064).
// A CAPTURE REQUIRES A REAL LIVE FRAME: with no live video (a headless render, a denied permission)
// `frameDataUrl` returns null — it NEVER fabricates a frame. This is what makes the forced photo
// UNTYPASSABLE (REQ-063): a driver who denies the camera cannot manufacture a content-free frame that
// satisfies the gate. The dark viewfinder the screenshot harness shows is a purely VISUAL stub (the ink
// ground itself); it is not routed through here and cannot become a capturable frame.

/**
 * A PNG data URL of the current live video frame, or `null` when there is no real frame to capture
 * (no video element, or the stream has no dimensions yet). Callers must treat null as "no capture" —
 * ADVANCE must stay disabled. The early return means no synthetic frame is ever produced.
 */
export function frameDataUrl(video: HTMLVideoElement | null): string | null {
  const w = video?.videoWidth ?? 0;
  const h = video?.videoHeight ?? 0;
  if (!video || w <= 0 || h <= 0) return null; // no live frame → no capture (REQ-063)
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null; // no 2D context → cannot read the frame; refuse rather than fabricate
  ctx.drawImage(video, 0, 0, w, h);
  return canvas.toDataURL("image/png");
}

/**
 * Encode a data URL to the raw bytes the evidence hash is taken over. This is SELF-CONSISTENT for
 * hashing (the same string always yields the same hash), which is all WP-05's hash-at-capture needs.
 *
 * DEFER (Task 9 / real R2 upload owns this): these are the UTF-8 bytes of the data-URL STRING, not the
 * decoded PNG bytes. When the deferred upload actually stores the image in R2, swap to the decoded
 * binary (strip the `data:...;base64,` prefix and base64-decode) so the stored object is a real PNG —
 * and hash those same decoded bytes so the payload hash still matches what R2 holds.
 */
export function bytesFromDataUrl(dataUrl: string): Uint8Array {
  return new TextEncoder().encode(dataUrl);
}
