import { defineConfig } from "vitest/config";

// Command is a PURE browser client (like the portal), so jsdom is the DEFAULT env: every unit here — the
// fetch client, the session token in localStorage, the client-side JWT claim decode — needs DOM globals.
// This mirrors the portal's vitest discipline exactly (globals + the same colocated include). `fetch` is
// mocked per-test (vi.fn / vi.stubGlobal) — no test ever hits a real network.
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
