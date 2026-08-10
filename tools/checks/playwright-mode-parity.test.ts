import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §938 — EVERY PLAYWRIGHT GATE DRAWS ITS BLOCKING MODE FROM EXACTLY ONE SOURCE. NEVER BOTH, NEVER NEITHER.
//
// `playwright-guard.ts` defaults `parseMode` to `local`, where an all-skipped run resolves to **exit 0** and
// the structured sentinel is suppressed. So a browser gate that receives no `--mode` cannot fail for the one
// reason it exists: an empty or skipped suite.
//
// There are exactly two legitimate suppliers, and the split is not arbitrary:
//   - run-gate supplies it, for gates invoked THROUGH `pnpm gate` — these carry `modeArg: true` in
//     `gatesFor()` and correctly OMIT `--mode` from their package script (perf, visual, a11y, e2e).
//   - the SCRIPT bakes it in, for gates also invoked DIRECTLY — `test:surfaces` is run by
//     `LAUNCH-RUNBOOK.md:236` outside run-gate, where nothing would supply a mode at all.
//
// MEASURED AT §938 (audit C2's fix, re-verified one week after filing). Deleting ` --mode release` from
// `package.json`'s `test:surfaces`:
//   - `env -u PROD_SURFACE_BASE pnpm test:surfaces` → **exit 0**, while the harness itself printed
//     "surfaces: BLOCKED — every test was skipped (5 skipped) — a skip is not a pass".
//     The sentinel and the exit code DISAGREE, and CI believes the exit code.
//   - all six tools suites that read package.json (run-gate, dev-loop-parity, gate-wiring, runtime-contract,
//     cwd-parity, test-collection) stayed **GREEN — 45/45**.
// A §688 "passing corpus": no test's corpus contained the script's argv. `run-gate.test.ts:76` reads like
// coverage and is not — it pins that the release profile RUNS `test:surfaces`, never what that script IS.
//
// This gate COMPUTES the requirement from run-gate's roster rather than storing a second copy of the answer
// (§830) — because a stored duplicate of a maintained fact is the exact defect §937 found in the audit's own
// summary table.

const PKG = "package.json";
const RUN_GATE = "tools/release/run-gate.ts";

/** Package scripts that invoke the Playwright harness, with the raw command line. */
function playwrightScripts(root: string): Map<string, string> {
  const scripts = JSON.parse(readFileSync(`${root}/${PKG}`, "utf8")).scripts as Record<string, string>;
  return new Map(Object.entries(scripts).filter(([, cmd]) => cmd.includes("playwright-guard")));
}

/** Does `gatesFor()` declare this script as receiving `--mode <profile>` at invocation time? */
function runGateSuppliesMode(runGateSrc: string, script: string): { declared: boolean; modeArg: boolean } {
  const entry = new RegExp(`\\{[^{}]*script:\\s*"${script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^{}]*\\}`).exec(runGateSrc);
  return { declared: entry !== null, modeArg: entry !== null && entry[0].includes("modeArg: true") };
}

describe("§938: a browser gate's blocking mode has exactly one source", () => {
  const root = repoRoot();
  const runGateSrc = readFileSync(`${root}/${RUN_GATE}`, "utf8");
  const scripts = playwrightScripts(root);

  it("the corpus is real (a broken read finds no scripts and every assertion below passes over nothing)", () => {
    // §487/§554/§572 and the "floor the INPUT, not the output" rule: bound what was READ. A renamed harness
    // path or a restructured package.json must fail HERE, loudly, not by silently emptying the sweep.
    expect(
      scripts.size,
      `no playwright-guard scripts found in ${PKG} — the scan is broken, or the harness was renamed and this ` +
        "gate now enforces nothing",
    ).toBeGreaterThanOrEqual(4);
  });

  it.each([...playwrightScripts(repoRoot()).keys()])(
    "%s draws --mode from exactly one source (run-gate's modeArg XOR the script itself)",
    (name) => {
      const cmd = scripts.get(name) as string;
      const baked = cmd.includes("--mode");
      const { declared, modeArg } = runGateSuppliesMode(runGateSrc, name);

      expect(
        baked || modeArg,
        `NEITHER source supplies a blocking mode to "${name}".\n` +
          `  package.json: ${cmd}\n` +
          `  ${RUN_GATE}: ${declared ? (modeArg ? "modeArg: true" : "declared WITHOUT modeArg") : "not declared as a gate"}\n` +
          "playwright-guard's parseMode then defaults to `local`, where an all-skipped run EXITS 0 and the " +
          "sentinel is suppressed — the gate cannot fail for the reason it exists. This is audit C2 verbatim " +
          "(§938): the harness prints BLOCKED and the process returns 0, so logs and CI disagree.\n" +
          "Fix: add `modeArg: true` to its gatesFor() entry, or bake `--mode release` into the script if it " +
          "is also invoked directly (as LAUNCH-RUNBOOK.md:236 invokes test:surfaces).",
      ).toBe(true);

      expect(
        baked && modeArg,
        `BOTH sources supply a mode to "${name}" — the script bakes in \`--mode\` AND gatesFor() passes ` +
          "`--mode <profile>`. The last flag wins in argv order, so the script's baked value would be " +
          "silently overridden under one profile and not the other. Pick one supplier.",
      ).toBe(false);
    },
  );

  it("test:surfaces bakes its own mode, because the runbook invokes it outside run-gate", () => {
    // The reason this one is asymmetric, pinned so it is not "tidied" into consistency with the other four.
    // If someone routes it through run-gate instead, the XOR above catches the BOTH state — but this states
    // the WHY, which the XOR cannot: LAUNCH-RUNBOOK.md's documented field invocation has no run-gate in it.
    expect(scripts.get("test:surfaces"), "test:surfaces no longer bakes a blocking mode — audit C2 regressed").toContain("--mode release");
    const runbook = readFileSync(`${root}/docs/ops/LAUNCH-RUNBOOK.md`, "utf8");
    expect(
      runbook,
      "the runbook no longer invokes `pnpm test:surfaces` directly. If the field gate now runs only through " +
        "run-gate, the baked mode may be redundant — re-decide deliberately rather than leaving both.",
    ).toContain("pnpm test:surfaces");
  });
});
