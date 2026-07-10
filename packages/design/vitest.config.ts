import { defineConfig } from "vitest/config";

// jsdom for the primitives (they render real DOM). Vitest's transformer handles the React 19
// automatic JSX runtime by default. globals: true so @testing-library/react registers its
// afterEach DOM cleanup.
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["test/**/*.test.tsx"],
  },
});
