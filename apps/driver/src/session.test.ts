import { afterEach, describe, expect, it, vi } from "vitest";
import { requestPersistentStorage } from "./session.js";

// REQ-016 — requesting persistent storage is best-effort and MUST never throw, whatever the browser
// offers. Eviction of IDB would reset the device_seq ceiling and risk a silent merge-drop; this only
// asks, and degrades cleanly when the API is absent or denied.
describe("requestPersistentStorage — guarded, best-effort (REQ-016)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("resolves false (never throws) when the Storage API is absent", async () => {
    vi.stubGlobal("navigator", {});
    await expect(requestPersistentStorage()).resolves.toBe(false);
  });

  it("resolves false when there is no navigator at all", async () => {
    vi.stubGlobal("navigator", undefined);
    await expect(requestPersistentStorage()).resolves.toBe(false);
  });

  it("returns the grant result when storage.persist() is available", async () => {
    vi.stubGlobal("navigator", { storage: { persist: () => Promise.resolve(true) } });
    await expect(requestPersistentStorage()).resolves.toBe(true);
  });

  it("swallows a throwing persist() rather than rejecting", async () => {
    vi.stubGlobal("navigator", {
      storage: {
        persist: () => {
          throw new Error("boom");
        },
      },
    });
    await expect(requestPersistentStorage()).resolves.toBe(false);
  });
});
