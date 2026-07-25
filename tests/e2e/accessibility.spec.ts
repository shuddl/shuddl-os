import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// V1 remediation Task 14 (REQ-158 / REQ-285) — THE ACCESSIBILITY BUDGET.
//
// Until now `pnpm test:a11y` pointed at a config whose testDir was ./tests/visual, so CI's "strict
// accessibility (merge mode)" step re-ran the five screenshot tests and asserted nothing at all about
// accessibility. This spec is the first real assertion of REQ-285 on the three surfaces.
//
// THE BUDGET: zero serious and zero critical axe findings on every core flow. Moderate/minor findings
// are reported (they are the WCAG 2.2 AA backlog) but do not block, so the gate is honest about what it
// enforces today rather than either fabricating a clean bill or blocking on cosmetics.
//
// Contrast is deliberately NOT re-litigated here: the greige/coral contrast law is owned by
// tools/design/audit.ts, whose `--signal-deep` value is tuned by its own contrast test (genesis/07). Two
// tools asserting the same rule with different thresholds would just fight, so axe's color-contrast rule
// is disabled and the design audit stays the single authority.
const SURFACES = {
  command: "http://localhost:4321/",
  portal: "http://localhost:4322/",
  driver: "http://localhost:4323/",
} as const;

// WCAG 2.2 AA is the standard the design system commits to (REQ-285).
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const BLOCKING: readonly string[] = ["serious", "critical"];

type Violation = { id: string; impact?: string | null | undefined; nodes: unknown[]; help: string };

async function audit(page: Page, url: string): Promise<Violation[]> {
  await page.goto(url);
  // Every surface must have actually PAINTED before we sample: an unmounted <div id="root"> has no
  // findings and would be a vacuous pass. Rendered text is the mount signal — `waitForSelector` is the
  // wrong instrument here because these surfaces size themselves from a full-height flex chain, so the
  // root legitimately reports as not-visible for a moment.
  await page.waitForFunction(() => (document.body.innerText ?? "").trim().length > 0, undefined, { timeout: 30_000 });
  const results = await new AxeBuilder({ page }).withTags(TAGS).disableRules(["color-contrast"]).analyze();
  return results.violations as unknown as Violation[];
}

function report(surface: string, violations: Violation[]): { blocking: Violation[]; summary: string } {
  const blocking = violations.filter((v) => BLOCKING.includes(String(v.impact)));
  const lines = violations.map((v) => `    ${String(v.impact).padEnd(8)} ${v.id} (${v.nodes.length}) — ${v.help}`);
  return { blocking, summary: `a11y[${surface}]: ${violations.length} finding(s), ${blocking.length} blocking\n${lines.join("\n")}` };
}

for (const [surface, url] of Object.entries(SURFACES)) {
  test(`${surface} has no serious or critical accessibility violations`, async ({ page }) => {
    const violations = await audit(page, url);
    const { blocking, summary } = report(surface, violations);
    console.log(summary);
    expect(blocking.map((v) => `${v.id}: ${v.help}`), `${surface} — serious/critical findings must be zero`).toEqual([]);
  });
}

test("the driver day sheet is reachable and operable by keyboard alone", async ({ page }) => {
  // The driver surface is one-question-one-button by design (REQ-062); a stop row is a real <button>, so
  // it must be focusable and activatable without a pointer. This is the WCAG 2.1.1 claim for the surface
  // a driver uses in a cab with gloves on — and, in a browser, the only way to prove it.
  await page.addInitScript(() => window.localStorage.setItem("shuddl.driver.session.token", "e2e.a11y.token"));
  await page.route("**/v1/driver/manifest", (route) =>
    route.fulfill({
      json: {
        server_ts: 1_784_000_000_000,
        tenant: "tenant-a",
        driver_id: "u-driver",
        stops: [{ shipment_id: "SHP-A11Y-1", seq: 0, kind: "pickup", status: "pending", revealed: true, geo: { lat_e6: 45_515_000, lon_e6: -122_678_000 } }],
      },
    }),
  );
  await page.goto(SURFACES.driver);
  await expect(page.getByText("Day sheet")).toBeVisible();

  const row = page.getByRole("button").first();
  await row.focus();
  await expect(row).toBeFocused();

  const violations = await audit(page, SURFACES.driver);
  const { blocking } = report("driver/day-sheet", violations);
  expect(blocking.map((v) => v.id), "the authenticated day sheet must also be clean").toEqual([]);
});
