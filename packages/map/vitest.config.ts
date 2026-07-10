import { defineConfig } from "vitest/config";

// jsdom because the MapCanvas render test mounts a React component and mocks MapLibre; the pure
// style/entity/generalize specs don't need the DOM but run fine under it. globals: true so
// @testing-library/react registers its afterEach DOM cleanup.
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    // perf/*.test.ts is the pure fleet-1k fixture (deterministic, no browser). perf/*.spec.ts is the
    // Playwright harness (advisory, run via `pnpm perf:map`) and is deliberately NOT matched here so
    // it never enters the unit run / `pnpm verify`.
    include: ["test/**/*.test.ts", "test/**/*.test.tsx", "perf/**/*.test.ts"],
  },
});
