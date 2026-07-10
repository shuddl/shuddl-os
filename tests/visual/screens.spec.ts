import { test, expect, type Page } from "@playwright/test";

// The five canonical screens (WP-03 DoD "5 canonical screens match blessed refs"). Each is a REAL
// screen composed from @shuddl/design + @shuddl/map, deterministic (seeded fleet), captured at a fixed
// 1440×900 viewport with reduced-motion so count-ups/reveals rest at final state and trucks sit static
// — the capture is stable frame to frame. The FIRST run on a browser-capable machine writes the
// blessed refs under tests/visual/blessed/ (commit them); afterwards a mismatch writes a diff to
// test-results/ and is REPORTED, never fatal (REQ-158) — the `pnpm test:visual` guard keeps exit 0
// unless run with --strict. `expect.soft` captures all five even if an early one drifts.

const COMMAND = "http://localhost:4321";
const PORTAL = "http://localhost:4322";
const DRIVER = "http://localhost:4323";

const SCREENS: ReadonlyArray<{ name: string; url: string; ready: string }> = [
  { name: "command.png", url: `${COMMAND}/`, ready: "canvas" },
  { name: "portal.png", url: `${PORTAL}/?screen=portal`, ready: "canvas" },
  { name: "status.png", url: `${PORTAL}/?screen=status`, ready: "canvas" },
  { name: "driver.png", url: `${DRIVER}/`, ready: "text=Photograph" },
  { name: "evidence-email.png", url: `${PORTAL}/?screen=email`, ready: "text=DELIVERED" },
];

async function settle(page: Page): Promise<void> {
  // Let webfonts + the GL canvas paint. Under reduced-motion nothing keeps moving after this, so the
  // basemap tiles failing to load (offline) still yields a stable greige ground + entity layers.
  await page.waitForTimeout(3000);
}

for (const s of SCREENS) {
  test(`canonical screen — ${s.name}`, async ({ page }) => {
    await page.goto(s.url);
    await page.waitForSelector(s.ready, { timeout: 30_000 });
    await settle(page);
    await expect.soft(page).toHaveScreenshot(s.name);
  });
}
