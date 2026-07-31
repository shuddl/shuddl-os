import { defineConfig, devices } from "@playwright/test";

// THE DEPLOYED-SURFACE GATE — a FIELD gate, in the same class as staging-smoke.
//
// Separate from playwright.config.ts on purpose. That config starts three Vite dev servers for every
// project it runs; this one drives the surfaces that are actually on the internet, so a local dev server
// is not merely wasteful here, it is the wrong subject. A test that can pass against localhost proves
// nothing about a deploy.
//
// It self-skips unless PROD_SURFACE_BASE names the zone, so it never runs in the merge profile and never
// fails a laptop that is offline. Nothing here writes: every request is a GET made without a session, and
// the entire point is to observe what a stranger sees.
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /prod-surface\.spec\.ts$/,
  fullyParallel: false,
  retries: 1, // one retry absorbs a cold edge cache; a real failure fails twice
  forbidOnly: true,
  reporter: [["line"]],
  timeout: 60_000,
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  },
});
