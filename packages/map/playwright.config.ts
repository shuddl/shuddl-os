import { defineConfig, devices } from "@playwright/test";

// The 1K-entity perf harness (REQ-079/158). Drives the Command board in ?perf mode against a
// Desktop-Chrome profile with motion ON, so the glide + pulse loops actually load the GPU. Invoked via
// `pnpm perf:map`, which self-skips locally when Playwright / its browsers are unavailable and BLOCKS
// under --mode merge|release.
//
// Task 14 served a production build here to rule out `vite dev` as the source of the long tasks. That
// comparison was INVALID: both runs painted through the harness's software rasterizer, so it compared two
// SwiftShader runs and concluded the code was at fault. Traced properly (Task 1 of the 2026-07-25 plan),
// the worst 560ms task is 527ms of compositor `Commit` at first paint — a map with ZERO entities still
// blocks 358ms, and the identical build on a real GPU produces zero long tasks at 87fps. The long-task
// budget is therefore unreachable on SwiftShader at any code quality; see `use.launchOptions` below.
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
