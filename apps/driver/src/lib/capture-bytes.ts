// Turn on-glass / on-camera pixels into the evidence bytes the capture leg hashes (REQ-063/064).
// Real hardware (camera frames, GPS) can't run in a headless render, so these degrade to a
// deterministic stub frame — the UI renders and the capture path stays exercised either way.
// Canvas paint is one of the sanctioned uses of the JS `TOKENS` constants (CSS vars can't reach it).
import { TOKENS } from "@shuddl/design";

/** A PNG data URL of the current video frame, or a dark stub frame if no live stream is available. */
export function frameDataUrl(video: HTMLVideoElement | null): string {
  const w = video?.videoWidth ?? 0;
  const h = video?.videoHeight ?? 0;
  const canvas = document.createElement("canvas");
  canvas.width = w > 0 ? w : 1280;
  canvas.height = h > 0 ? h : 720;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    if (video && w > 0 && h > 0) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    } else {
      // Stub frame (no camera in the render): a dark field with a mono timestamp so each is unique.
      ctx.fillStyle = TOKENS.inkDark;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = TOKENS.field;
      ctx.font = "24px monospace";
      ctx.fillText(`STUB FRAME ${Date.now()}`, 40, 60);
    }
  }
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
