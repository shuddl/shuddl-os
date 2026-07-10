import { test, expect } from "@playwright/test";

// Advisory 1,000-entity frame-budget harness (REQ-079). It loads the Command board in ?perf mode
// (the deterministic `fleet1k()` — 1,000 entities across CONUS, one exception), lets the greige GL
// canvas render + run its glide/pulse loops, then samples `requestAnimationFrame` deltas IN the page
// and reports p50/p95. p95 ≤ ~16.6ms is the 60fps desktop budget (the DoD's perf line). This is
// REPORTED, not enforced (REQ-158) — a slow p95 only fails under `pnpm perf:map --strict`, never in
// `pnpm verify`. The whole harness self-skips (exit 0) when Playwright / a browser / tiles are absent.

const FRAME_BUDGET_MS = 16.6; // 60fps desktop
const SAMPLE_MS = 4000;

test("1,000 entities hold the 60fps desktop frame budget (advisory)", async ({ page }) => {
  await page.goto("/?perf=1");
  // MapLibre injects a <canvas> once the style loads — the operational canvas is up.
  await page.waitForSelector("canvas", { timeout: 30_000 });
  await page.waitForTimeout(1500); // let the first throttled setData ticks + the pulse settle

  const stats = await page.evaluate(async (durationMs: number) => {
    const deltas: number[] = [];
    await new Promise<void>((resolve) => {
      let last = performance.now();
      const start = last;
      const step = (now: number): void => {
        deltas.push(now - last);
        last = now;
        if (now - start < durationMs) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    deltas.sort((a, b) => a - b);
    const at = (p: number): number => deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * p))] ?? 0;
    return { frames: deltas.length, p50: at(0.5), p95: at(0.95) };
  }, SAMPLE_MS);

  console.log(
    `perf: 1K entities — frames=${stats.frames} p50=${stats.p50.toFixed(2)}ms ` +
      `p95=${stats.p95.toFixed(2)}ms (budget ${FRAME_BUDGET_MS}ms desktop / ${(1000 / FRAME_BUDGET_MS).toFixed(0)}fps)`,
  );
  // Soft: report the number and keep going; the guard turns a miss into an advisory note unless --strict.
  expect.soft(stats.p95, "p95 frame time should hold the 60fps desktop budget").toBeLessThanOrEqual(FRAME_BUDGET_MS);
});
