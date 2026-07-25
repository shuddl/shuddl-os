import { defineConfig, devices } from "@playwright/test";

// The browser evidence surface (REQ-158 / REQ-285 / REQ-288). Three projects share one set of dev
// servers, and each gate selects exactly one of them via `--project`:
//
//   visual — the 5-canonical-screen screenshot diff, motion DISABLED, diffed against tests/visual/blessed/
//   e2e    — driver offline→reconnect durability and portal party isolation, in a real browser
//   a11y   — axe-core over the core flows; zero serious/critical findings is the budget
//
// V1 remediation Task 14: before this split, `pnpm test:a11y` pointed at a config whose testDir was
// ./tests/visual, so CI's "strict accessibility" step re-ran the screenshot tests and asserted nothing
// about accessibility. Selecting by project is what makes each gate name mean what it says.
const PORTS = { command: 4321, portal: 4322, driver: 4323 } as const;

export default defineConfig({
  snapshotPathTemplate: "tests/visual/blessed/{arg}{ext}",
  fullyParallel: false,
  retries: 0,
  // A gate must never pass because a test was quietly left focused or skipped in the tree.
  forbidOnly: true,
  reporter: [["line"]],
  timeout: 60_000,
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: "disabled" } },
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      // THE DETERMINISM CONTRACT for the blessed refs. A baseline is only worth having if the only
      // thing that can change it is our own code, so the capture is pinned on three axes:
      //   • motion      — reducedMotion + `animations: "disabled"`, so pulses and count-ups rest.
      //   • data        — every server read the screens make is fulfilled with a pinned payload, and
      //                   every rendered timestamp comes from a fixed stamp, never a clock.
      //   • third party — the spec ABORTS the public demo basemap (tiles + glyphs). It is a live fetch
      //                   of a moving `latest` build that owns ~3.6% of the 1440×900 frame, against the
      //                   2% maxDiffPixelRatio below: a stranger's tile deploy could otherwise fail
      //                   this gate with no change of ours. Blocking it is a capture decision only —
      //                   the production tile source is a separate, documented hold (REQ-075).
      // The tolerance stays at 2%: it absorbs GPU-level AA differences between machines, which is what
      // it is for, and it is no longer absorbing a third party's cartography.
      name: "visual",
      testDir: "./tests/visual",
      testMatch: /.*\.spec\.ts$/,
      use: { reducedMotion: "reduce" },
    },
    {
      name: "e2e",
      testDir: "./tests/e2e",
      testMatch: /(driver-offline-sync|portal-isolation)\.spec\.ts$/,
      use: { reducedMotion: "reduce" },
    },
    {
      name: "a11y",
      testDir: "./tests/e2e",
      testMatch: /accessibility\.spec\.ts$/,
      use: { reducedMotion: "reduce" },
    },
  ],
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
