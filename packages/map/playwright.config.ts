import { defineConfig, devices } from "@playwright/test";

// Advisory perf harness config (REQ-079/158). Runs ONLY the 1K-entity frame-budget spec, driving the
// Command board in ?perf mode against a Desktop-Chrome profile with motion ON (so the glide + pulse
// loops actually load the GPU). Never wired into `pnpm verify` — invoked via `pnpm perf:map`, which
// self-skips when Playwright / its browsers / the tile host are unavailable.
export default defineConfig({
  testDir: "./perf",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  forbidOnly: false,
  retries: 0,
  reporter: [["line"]],
  timeout: 90_000,
  use: {
    baseURL: "http://localhost:4310",
    reducedMotion: "no-preference",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "pnpm --filter @shuddl/command dev --port 4310 --strictPort",
    url: "http://localhost:4310",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
