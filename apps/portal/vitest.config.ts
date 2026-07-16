import { defineConfig } from "vitest/config";

// The portal is a PURE browser client (unlike the driver, which also has node-side flow/storage units,
// so it defaults to node and opts into jsdom per-file). Every unit here — the fetch client, the session
// token in localStorage, the client-side JWT claim decode — needs DOM globals, so jsdom is the DEFAULT
// env. Otherwise this mirrors the driver's vitest discipline: globals + the same colocated include.
// `fetch` is mocked per-test (vi.fn / vi.stubGlobal) — no test ever hits a real network.
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
