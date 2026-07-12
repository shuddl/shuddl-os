import { defineConfig } from "vitest/config";

// Flow + storage are pure Node/IDB units — no DOM render here (the UI is proven by the live-render
// harness in tools/live, per the WP-03 honesty rule). fake-indexeddb/auto is imported per-test-file.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
