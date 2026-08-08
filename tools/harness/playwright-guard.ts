import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVIDENCE_EXIT, formatGateResult, parseMode, type GateMode, type GateResult, type GateStatus } from "../release/evidence.js";

// The Playwright gate harness (REQ-158 / REQ-288 / REQ-285).
//
// Locally the browser harnesses stay advisory: `@playwright/test` and its browsers are deliberately kept
// out of the default install, so `pnpm verify` must never depend on them. Under `--mode merge|release`
// that advisory posture inverts — an absent browser, an empty suite, an all-skipped suite, or an
// unprovable run become BLOCKED (exit 2) and a real regression becomes FAIL (exit 1). Nothing in this
// file may turn one of those into a green.
//
// V1 remediation Task 14: the guard reads Playwright's MACHINE-READABLE json stats rather than its human
// line output. Playwright exits 0 both for "42 passed" and for "0 tests ran" / "4 skipped", so the exit
// code alone cannot distinguish proof from silence. tools/release/evidence.ts states the governing law —
// a gate returns a structured result and never parses prose — and this is that law applied to the browser.

export type PlaywrightStats = { expected: number; unexpected: number; flaky: number; skipped: number };

export type RunOutcome =
  // The harness could not run at all: no @playwright/test, no browser binary, no launchable process.
  | { kind: "tooling-absent"; reason: string }
  // The harness ran. `stats` is null when Playwright produced no machine-readable report, which means the
  // run is UNPROVABLE — never the same thing as a clean run.
  | { kind: "ran"; exitCode: number | null; stats: PlaywrightStats | null };

const COUNTERS = ["expected", "unexpected", "flaky", "skipped"] as const;

/**
 * REQ-118 §609 — the per-gate corpus floor. MEASURED when this landed, each by running the gate on a clean
 * tree under `--mode merge`: visual 5, a11y 4, e2e 6, perf 1.
 *
 * MAY RISE FREELY, MAY NOT FALL without an edit here saying which proof was retired. `surfaces` is absent on
 * purpose — it is release-only, hits the public internet, and returns BLOCKED before any count exists; a floor
 * it can never reach would be noise. `gate-wiring.test.ts` asserts every OTHER guard label carries one, so a
 * new browser gate cannot be added without deciding its floor.
 */
export const MIN_ASSERTIONS: Readonly<Record<string, number>> = {
  visual: 5,
  a11y: 4,
  e2e: 6,
  perf: 1,
};

// Parse Playwright's json report. Returns null for anything that is not a report carrying all four
// numeric counters — a crashed reporter, a prose error, an empty file. Null is "unprovable", and the
// classifier treats it as such; it must never collapse to a zeroed (and therefore green-looking) record.
export function parseStats(raw: string): PlaywrightStats | null {
  if (raw.trim().length === 0) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof doc !== "object" || doc === null) return null;
  const stats = (doc as { stats?: unknown }).stats;
  if (typeof stats !== "object" || stats === null) return null;
  const out: Record<string, number> = {};
  for (const k of COUNTERS) {
    const v = (stats as Record<string, unknown>)[k];
    // A string "6" is a shape we do not recognise — refuse it rather than coerce it.
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
    out[k] = v;
  }
  return { expected: out["expected"] ?? 0, unexpected: out["unexpected"] ?? 0, flaky: out["flaky"] ?? 0, skipped: out["skipped"] ?? 0 };
}

// THE disposition. Precedence: tooling absent → unprovable → nothing discovered → nothing executed →
// real failure → pass. `blocking` (merge/release) turns every non-pass into a non-zero exit; `strict`
// does the same locally EXCEPT for absent tooling, which no local run can be blamed for.
export function classifyRun(label: string, mode: GateMode, strict: boolean, outcome: RunOutcome): { result: GateResult; exitCode: number } {
  const blocking = mode === "merge" || mode === "release";

  const blocked = (detail: string, environmental: boolean): { result: GateResult; exitCode: number } => ({
    result: { gate: label, status: "BLOCKED" as GateStatus, executed: false, assertions: 0, detail },
    exitCode: blocking ? EVIDENCE_EXIT.PREREQ_BLOCKED : environmental || !strict ? EVIDENCE_EXIT.OK : EVIDENCE_EXIT.ASSERTIONS_FAILED,
  });

  const failed = (detail: string, executed: boolean, assertions: number): { result: GateResult; exitCode: number } => ({
    result: { gate: label, status: "FAIL" as GateStatus, executed, assertions, detail },
    exitCode: blocking || strict ? EVIDENCE_EXIT.ASSERTIONS_FAILED : EVIDENCE_EXIT.OK,
  });

  if (outcome.kind === "tooling-absent") {
    // Locally this is the deliberate advisory skip (PENDING, exit 0) — you cannot run a browser you do
    // not have, and --strict does not change that. Under merge/release it is a hard BLOCK.
    if (blocking) return blocked(outcome.reason, true);
    return { result: { gate: label, status: "PENDING", executed: false, assertions: 0, detail: outcome.reason }, exitCode: EVIDENCE_EXIT.OK };
  }

  const { exitCode, stats } = outcome;

  if (stats === null) {
    // No machine-readable report. If the process also failed, that is a genuine failure; if it "succeeded"
    // we have no proof it ran anything, which under merge/release is exactly as non-promotable.
    if (exitCode !== 0) return failed(`playwright exited ${exitCode ?? "null"} and wrote no machine-readable report`, true, 1);
    return blocked("playwright produced no machine-readable report — execution is unprovable", true);
  }

  const executedCount = stats.expected + stats.unexpected + stats.flaky;
  const total = executedCount + stats.skipped;

  if (total === 0) return blocked("no tests were discovered — a suite that found nothing proves nothing", false);
  if (executedCount === 0) return blocked(`every test was skipped (${stats.skipped} skipped) — a skip is not a pass`, false);
  if (stats.unexpected > 0) return failed(`${stats.unexpected} failing of ${executedCount} executed`, true, executedCount);

  // §609 — THE CORPUS RATCHET. The two guards above floor the suite at ZERO: they catch "nothing ran" and
  // "everything skipped", and nothing else. A suite that SHRANK still passes, and that is not hypothetical —
  // renaming `portal-isolation.spec.ts` out of the e2e project's testMatch produced `e2e: PASS — 3 passed`
  // at exit 0 under --mode merge, silently retiring the browser-level proof of tenant isolation (REQ-025,
  // CLAUDE.md rule 8) while the gate reported green.
  //
  // A zero-floor only protects a suite that has exactly ONE source of tests, where losing it discovers
  // nothing. Every multi-file (or multi-case) suite is unprotected — e2e has two spec files, visual five
  // screens in one parameterized spec.
  //
  // A FLOOR, not an exact count, and for the same reason bundle-ratchet uses one: the number MAY RISE freely
  // as tests are added, and MAY NOT FALL without someone editing this file and saying why. An exact count
  // would make every new test a two-file change and would be routinely bumped without thought.
  const floor = MIN_ASSERTIONS[label];
  if (floor !== undefined && executedCount < floor) {
    return failed(
      `only ${executedCount} test(s) ran, below this suite's floor of ${floor}. The suite SHRANK — a spec file ` +
        `renamed out of its project's testMatch, a case deleted, or a describe block dropped. Nothing failed, ` +
        `which is exactly why this needs saying: the coverage left silently. Restore it, or lower the floor in ` +
        `tools/harness/playwright-guard.ts and say which proof was retired and why.`,
      true,
      executedCount,
    );
  }

  return {
    result: {
      gate: label,
      status: "PASS",
      executed: true,
      assertions: stats.expected + stats.flaky,
      detail: `${stats.expected} passed${stats.flaky > 0 ? `, ${stats.flaky} flaky` : ""}${stats.skipped > 0 ? `, ${stats.skipped} skipped` : ""}`,
    },
    exitCode: EVIDENCE_EXIT.OK,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────────

// Playwright's own signals that the browser binaries were never downloaded / cannot launch.
const NO_BROWSER = /Executable doesn't exist|playwright install|browserType\.launch|Host system is missing dependencies/i;

export type ParsedArgs = { label: string; configPath: string | undefined; project: string | undefined; strict: boolean };

// Scan positionally, consuming each flag's value as we pass it. A set-membership filter cannot do this:
// the gate label and its --project value are frequently the SAME word (`a11y`, `--project a11y`), and
// stripping "every token that equals a flag value" would eat the label too.
export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let project: string | undefined;
  let strict = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined || a === "--") continue; // `--` is pnpm's own separator
    if (a === "--strict") {
      strict = true;
      continue;
    }
    if (a === "--project") {
      project = argv[i + 1];
      i += 1;
      continue;
    }
    if (a === "--mode") {
      i += 1; // consumed by parseMode
      continue;
    }
    if (a.startsWith("--")) continue;
    positional.push(a);
  }
  return { label: positional[0] ?? "playwright", configPath: positional[1], project, strict };
}

function runPlaywright(configPath: string, project: string | undefined): RunOutcome {
  const require = createRequire(import.meta.url);
  try {
    require.resolve("@playwright/test");
  } catch {
    return { kind: "tooling-absent", reason: "@playwright/test is not installed (browser-only dev tool, kept out of the default install)" };
  }

  const dir = mkdtempSync(join(tmpdir(), "shuddl-pw-"));
  const jsonPath = join(dir, "report.json");
  try {
    const args = ["exec", "playwright", "test", "-c", configPath];
    if (project) args.push("--project", project);
    args.push("--reporter=line,json");
    const res = spawnSync("pnpm", args, {
      encoding: "utf8",
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: jsonPath },
    });

    if (res.error) return { kind: "tooling-absent", reason: `could not launch Playwright (${res.error.message})` };

    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    if (out.trim()) console.log(out);
    if (NO_BROWSER.test(out)) {
      return { kind: "tooling-absent", reason: "Playwright browsers are not installed (run `pnpm exec playwright install --with-deps chromium`)" };
    }

    let raw = "";
    try {
      raw = readFileSync(jsonPath, "utf8");
    } catch {
      raw = out; // some configurations stream the json report to stdout instead
    }
    return { kind: "ran", exitCode: res.status, stats: parseStats(raw) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const mode = parseMode(argv);
  const { label, configPath, project, strict } = parseArgs(argv);

  if (!configPath) {
    console.error(`${label}: usage — playwright-guard <label> <configPath> [--project <name>] [--mode merge|release] [--strict]`);
    process.exit(EVIDENCE_EXIT.MALFORMED);
  }

  console.log(`${label}: running Playwright harness (${configPath}${project ? ` --project ${project}` : ""}) [mode=${mode}${strict ? " --strict" : ""}] …`);
  const classified = classifyRun(label, mode, strict, runPlaywright(configPath, project));
  const { exitCode } = classified;
  const result = stampFieldProvenance(classified.result, process.env["PROD_SURFACE_BASE"]);

  const human =
    result.status === "PASS"
      ? `\n${label}: PASS — ${result.detail}.`
      : result.status === "PENDING"
        ? `\n${label}: SKIPPED (advisory, REQ-158) — ${result.detail}\n${label}: pnpm verify stays exit 0.`
        : `\n${label}: ${result.status} — ${result.detail}`;
  console.log(human);
  if (mode !== "local") console.log(formatGateResult(result));
  if (result.status === "BLOCKED") {
    console.error(`${label}: a merge/release gate does not green on an absent browser, an empty suite, or a skipped one.`);
  }
  process.exit(exitCode);
}

// 2026-08-01 review: a field gate's PASS must carry WHAT it proved — the surfaces record row previously
// held only Playwright counters, so a prod-derived PASS was indistinguishable from any other zone's (the
// same defect class stateProvenance closed for the preflight). The zone is not a secret; stamp it into the
// persisted detail for the surfaces label. Pure + exported for its unit test.
export function stampFieldProvenance(result: GateResult, zone: string | undefined): GateResult {
  if (result.gate !== "surfaces" || zone === undefined || zone.length === 0) return result;
  return { ...result, detail: `${result.detail} — against ${zone}` };
}

// Only run as a CLI — the pure classifier above is imported directly by the negative-control tests.
if (process.argv[1] !== undefined && /playwright-guard\.ts$/.test(process.argv[1])) main();
