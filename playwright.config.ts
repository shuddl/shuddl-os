import { defineConfig, devices } from "@playwright/test";

// Advisory 5-canonical-screen screenshot diff (audit #6, REQ-158). Boots the three app dev servers on
// fixed ports and captures each real screen at a fixed 1440×900 viewport with motion DISABLED, diffing
// against tests/visual/blessed/. Never wired into `pnpm verify` — invoked via `pnpm test:visual`,
// which self-skips (exit 0) when Playwright / a browser / the tile host is unavailable. Held advisory
// until WP-10 exit; blocking thereafter (REQ-158).
const PORTS = { command: 4321, portal: 4322, driver: 4323 } as const;

export default defineConfig({
  testDir: "./tests/visual",
  testMatch: /.*\.spec\.ts$/,
  snapshotPathTemplate: "tests/visual/blessed/{arg}{ext}",
  fullyParallel: false,
  retries: 0,
  reporter: [["line"]],
  timeout: 60_000,
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: "disabled" } },
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  },
  webServer: [
    {
      command: `pnpm --filter @shuddl/command dev --port ${PORTS.command} --strictPort`,
      url: `http://localhost:${PORTS.command}`,
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: `pnpm --filter @shuddl/portal dev --port ${PORTS.portal} --strictPort`,
      url: `http://localhost:${PORTS.portal}`,
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: `pnpm --filter @shuddl/driver dev --port ${PORTS.driver} --strictPort`,
      url: `http://localhost:${PORTS.driver}`,
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});
