import { defineConfig, devices } from "@playwright/test";

// The 1K-entity perf harness (REQ-079/158). Drives the Command board in ?perf mode against a
// Desktop-Chrome profile with motion ON, so the glide + pulse loops actually load the GPU. Invoked via
// `pnpm perf:map`, which self-skips locally when Playwright / its browsers are unavailable and BLOCKS
// under --mode merge|release.
//
// Task 14: this serves a PRODUCTION BUILD, not `vite dev`. A budget measured against unbundled ESM with
// source maps is measuring the dev server, not what ships.
//
// Measuring both settled the question of where the long tasks come from, and the answer was not the one
// expected: the production bundle blocks the main thread just as long as the dev server does (~580ms in
// the operating window with 1,000 entities). So the long-task budget below is NOT met by current code —
// it is a real, reproducible REQ-079 defect that this gate exists to surface, not a harness artifact.
// The budget stays at the DoD number; loosening it to reach green would be the exact fabrication this
// whole task was written to stop.
export default defineConfig({
  testDir: "./perf",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  // A gate must never shrink because a `.only` was left in the tree (Task 14).
  forbidOnly: true,
  retries: 0,
  reporter: [["line"]],
  timeout: 90_000,
  use: {
    baseURL: "http://localhost:4310",
    reducedMotion: "no-preference",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command:
      "pnpm --filter @shuddl/command exec vite build && pnpm --filter @shuddl/command exec vite preview --port 4310 --strictPort",
    url: "http://localhost:4310",
    // Never reuse: a stale dev server on this port would silently turn the measurement back into a
    // dev-server measurement, which is the exact mistake this config exists to prevent.
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
