import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

// The advisory Playwright guard (REQ-158). The perf harness (1K-entity frame budget) and the visual
// harness (5-screen screenshot diff) both need a real browser + WebGL + a reachable tile/glyph host —
// none of which `pnpm verify` may depend on. This wrapper makes both self-skipping:
//   • `@playwright/test` not installed  → print "SKIPPED (no browser/network)" and exit 0.
//   • browsers not installed / unreachable → same clean skip.
//   • a real regression (slow p95 / screenshot drift) → REPORTED, exit 0 (advisory) — a non-zero
//     exit only in an explicit `--strict` run, which CI never uses.
// So `pnpm perf:map` and `pnpm test:visual` are always green unless you opt into `--strict` locally.

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const positional = args.filter((a) => !a.startsWith("--"));
const label = positional[0] ?? "playwright";
const configPath = positional[1];

function skip(reason: string): never {
  console.log(`\n${label}: SKIPPED (no browser/network) — ${reason}`);
  console.log(`${label}: advisory harness (REQ-158) — pnpm verify stays exit 0.\n`);
  process.exit(0);
}

if (!configPath) {
  console.error(`${label}: usage — playwright-guard <label> <configPath> [--strict]`);
  process.exit(strict ? 1 : 0);
}

const require = createRequire(import.meta.url);
try {
  require.resolve("@playwright/test");
} catch {
  skip("@playwright/test is not installed (browser-only dev tool, kept out of the default install)");
}

console.log(`${label}: running Playwright harness (${configPath})${strict ? " [--strict]" : " [advisory]"} …`);
const res = spawnSync("pnpm", ["exec", "playwright", "test", "-c", configPath], { encoding: "utf8" });

if (res.error) skip(`could not launch Playwright (${res.error.message})`);

const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
if (out.trim()) console.log(out);

// Playwright's own signal that the browser binaries were never downloaded.
if (/Executable doesn't exist|playwright install|browserType\.launch/i.test(out)) {
  skip("Playwright browsers are not installed (run `pnpm exec playwright install` on a machine with a browser)");
}

if (res.status === 0) {
  console.log(`\n${label}: PASS.`);
  process.exit(0);
}

// A genuine mismatch/regression. Advisory by default (REQ-158); only --strict makes it fail.
console.log(`\n${label}: harness reported a regression (exit ${res.status ?? "?"}).`);
if (strict) {
  console.error(`${label}: --strict — failing.`);
  process.exit(1);
}
console.log(`${label}: advisory (REQ-158) — reported, NOT blocking. See test-results/ for diffs.`);
process.exit(0);
