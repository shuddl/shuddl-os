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
    launchOptions: {
      // SwiftShader's compositor Commit floor (~360-520ms at first paint) makes the 100ms long-task
      // budget unreachable regardless of code quality. Ask for the real GPU; the spec verifies whether
      // it was granted and refuses to assert the budget against a software rasterizer.
      //
      // §1721 — `PERF_FORCE_SOFTWARE=1` asks for the OPPOSITE, so a developer on a GPU can reproduce CI's
      // rendering condition without editing this file. It exists because the CI perf failure was diagnosed
      // three times against a machine that could not reproduce it: the whole difference between the two
      // verdicts is which rasterizer answered, and that was not switchable. Nothing reads this variable in
      // CI (the runner is already software), so setting it there is a no-op rather than a footgun; and the
      // spec decides what to assert from the renderer it actually GOT, never from this flag.
      args:
        process.env.PERF_FORCE_SOFTWARE === "1"
          ? ["--use-gl=swiftshader", "--disable-gpu"]
          : ["--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--enable-features=Vulkan"],
    },
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
