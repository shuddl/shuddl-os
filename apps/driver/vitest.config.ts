import { defineConfig } from "vitest/config";

// Flow + storage are pure Node/IDB units — no DOM render here (the UI is proven by the live-render
// harness in tools/live, per the WP-03 honesty rule). fake-indexeddb/auto is imported per-test-file.
// The DEFAULT env is node; a capture-UI test that must render the camera opts into jsdom per-file with
// `// @vitest-environment jsdom` (the forced-photo live-guard is proven at the component, REQ-063).
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
