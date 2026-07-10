import { defineConfig } from "vitest/config";

// jsdom because the MapCanvas render test mounts a React component and mocks MapLibre; the pure
// style/entity/generalize specs don't need the DOM but run fine under it. globals: true so
// @testing-library/react registers its afterEach DOM cleanup.
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  },
});
