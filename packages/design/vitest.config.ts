import { defineConfig } from "vitest/config";

// jsdom for the primitives (they render real DOM). Vitest's transformer handles the React 19
// automatic JSX runtime by default. globals: true so @testing-library/react registers its
// afterEach DOM cleanup.
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    // §728 — `.test.ts` too. This read `test/**/*.test.tsx` only, so a plain-TypeScript test in this
    // package was silently NOT COLLECTED: a planted file asserting `expect(1).toBe(2)` left
    // `vitest run` at "Test Files 2 passed (2)". Every sibling package that narrows the default
    // admits both extensions; this one did not, and nothing said so.
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
