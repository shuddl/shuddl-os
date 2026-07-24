import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
// V1 remediation Task 3 (REQ-288): under --mode merge|release an absent browser/tooling is a
// non-promotable BLOCKED and a real regression is a FAIL — never the advisory green it stays locally.
import { parseMode, formatGateResult, EVIDENCE_EXIT, type GateStatus } from "../release/evidence.js";

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
const mode = parseMode(args);
const blocking = mode === "merge" || mode === "release";
// The `--mode` value itself is a bare positional after the flag is stripped; drop it too so it is never
// mistaken for the label/config.
const modeValue = (() => {
  const i = args.indexOf("--mode");
  return i >= 0 ? args[i + 1] : undefined;
})();
const positional = args.filter((a) => !a.startsWith("--") && a !== modeValue);
const label = positional[0] ?? "playwright";
const configPath = positional[1];

function emit(status: GateStatus, executed: boolean, assertions: number, detail: string): void {
  if (mode !== "local") console.log(formatGateResult({ gate: label, status, executed, assertions, detail }));
}

function skip(reason: string): never {
  if (blocking) {
    console.error(`\n${label}: BLOCKED under --mode ${mode} — ${reason}. A merge/release gate does not green on an absent browser/tooling.`);
    emit("BLOCKED", false, 0, reason);
    process.exit(EVIDENCE_EXIT.PREREQ_BLOCKED);
  }
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
  emit("PASS", true, 1, "playwright harness green");
  process.exit(0);
}

// A genuine mismatch/regression. Advisory by default (REQ-158); merge/release (or --strict) makes it fail.
console.log(`\n${label}: harness reported a regression (exit ${res.status ?? "?"}).`);
if (blocking) {
  console.error(`${label}: --mode ${mode} — failing on the regression (a merge/release gate is not advisory).`);
  emit("FAIL", true, 1, `regression (exit ${res.status ?? "?"})`);
  process.exit(1);
}
if (strict) {
  console.error(`${label}: --strict — failing.`);
  process.exit(1);
}
console.log(`${label}: advisory (REQ-158) — reported, NOT blocking. See test-results/ for diffs.`);
process.exit(0);
