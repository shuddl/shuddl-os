import { afterEach, describe, expect, it, vi } from "vitest";
import { apiBase } from "./base.js";
import { createManifestClient } from "./client.js";

// The driver PWA ships as Workers Static Assets with `not_found_handling = "single-page-application"`, so an
// UNMATCHED same-origin path answers 200 + the HTML shell instead of 404. A same-origin API base therefore
// turns a missing VITE_API_BASE into a SILENT failure: `GET /v1/driver/manifest` resolves 200-with-HTML, the
// service worker cache-firsts it under the API path, and the driver's phone keeps serving the shell for the
// manifest across redeploys until someone clears the cache by hand. So the base must FAIL LOUDLY when unset —
// the same discipline the command/portal clients already keep: a SYNTHETIC `.example` host (RFC 2606, can
// never resolve, never a real customer domain — REQ-167) that produces an honest `unavailable` state.

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("driver apiBase — a missing VITE_API_BASE must never resolve to same-origin (REQ-030/167)", () => {
  it("defaults to an ABSOLUTE synthetic base — never the empty string / same-origin", () => {
    expect(apiBase()).not.toBe("");
    expect(apiBase()).toMatch(/^https:\/\//); // absolute: a relative base would ride the app's own origin
    expect(apiBase()).toMatch(/\.example$/); // reserved TLD — unreachable by construction, and never real
    expect(apiBase().endsWith("/")).toBe(false);
  });

  it("uses VITE_API_BASE when the build supplies one, with any trailing slash stripped", () => {
    vi.stubEnv("VITE_API_BASE", "https://api.stub.example/");
    expect(apiBase()).toBe("https://api.stub.example");
  });

  it("an UNCONFIGURED build issues NO same-origin /v1/* request — the manifest read is absolute", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const client = createManifestClient({
      baseUrl: apiBase(),
      getToken: () => "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.fetchManifest();

    const url = String(fetchImpl.mock.calls[0]?.[0]);
    // The exact failure this guards: a bare "/v1/driver/manifest" would hit the SPA fallback (200 + HTML).
    expect(url.startsWith("/")).toBe(false);
    expect(url).toBe("https://api.shuddl.example/v1/driver/manifest");
  });
});
