import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { gatesFor } from "../release/run-gate.js";
import { repoRoot } from "./repo-root.js";

// §943 — A MODE-AWARE GATE THAT NEVER RECEIVES A MODE REPORTS PASS WHILE REFUSING.
//
// `parseMode` defaults to `local`. In `local` a mode-aware gate goes advisory: it prints its refusal, exits
// 0, and — critically — SUPPRESSES its structured sentinel:
//
//     if (mode !== "local") console.log(formatGateResult(result));   // backup.ts:517, preflight.ts:713,
//                                                                    // restore-verify.ts:377,408
//
// run-gate's `reconcileSentinel` is a genuine safety net for the OTHER direction — a sentinel may DEGRADE an
// exit-0 run but never upgrade a failing one, so `{"status":"BLOCKED"}` + exit 0 is recorded BLOCKED. It
// cannot help here, because a suppressed sentinel leaves NOTHING to reconcile and `synthesize()` reads the
// exit code alone. MEASURED AT §943: neither §938's `test:surfaces` case nor §939's design-audit case emitted
// a sentinel (0 and 0). **The net protects gates that speak; it cannot protect one that goes quiet.**
//
// So the invariant is: every mode-aware entrypoint must RECEIVE a mode from somewhere. Three legitimate
// sources, and the choice among them is real (§938):
//   1. `modeArg: true` in gatesFor()      — run-gate passes `--mode <profile>`; the normal case.
//   2. baked into the package script      — for a gate ALSO invoked directly, outside run-gate
//                                           (`test:surfaces`, run by LAUNCH-RUNBOOK.md:236).
//   3. an explicit `--mode` in a workflow — for a gate CI drives itself (`backup`, nightly.yml:61).
//
// MEASURED CLEAN when this landed: 10 entrypoints, 14 bindings, zero defaulting to local. That negative has a
// real POSITIVE CONTROL rather than an assertion — reverting §938's one-line fix (deleting the baked
// `--mode release`) makes this gate RED, and that defect existed in this repo four commits earlier.
//
// DIVISION OF LABOUR, asserted below so it cannot rot: this file is the DISCOVERY half — every mode-aware
// entrypoint is accounted for. `playwright-mode-parity.test.ts` (§938) owns EXCLUSIVITY for the playwright
// family (never both sources, never neither). Neither subsumes the other; both are needed.

const CI_WORKFLOWS = [".github/workflows/ci.yml", ".github/workflows/nightly.yml"];

/** Tool entrypoints that branch on `--mode`, discovered from source — never a hand-kept list. */
function modeAwareEntrypoints(root: string): string[] {
  const out = execFileSync("git", ["grep", "-l", "--", "parseMode", "tools/"], { cwd: root, encoding: "utf8" });
  return out
    .split("\n")
    .filter(Boolean)
    .filter((f) => !f.endsWith(".test.ts"))
    // The mode PLUMBING itself — it defines parseMode and consumes results; it is not a gate with a mode.
    .filter((f) => !f.includes("release/run-gate.ts") && !f.includes("release/evidence.ts"))
    .sort();
}

describe("§943: every mode-aware gate receives a mode from somewhere", () => {
  const root = repoRoot();
  const scripts = JSON.parse(readFileSync(`${root}/package.json`, "utf8")).scripts as Record<string, string>;
  // The gate specs come from `gatesFor()` itself, not from parsing run-gate's source — the authority rather
  // than a reading of it (§830). Only package.json and the workflows still need to be read as text.
  const ci = CI_WORKFLOWS.map((f) => readFileSync(`${root}/${f}`, "utf8")).join("\n");
  const entrypoints = modeAwareEntrypoints(root);

  it("finds mode-aware entrypoints at all (non-vacuity — an empty corpus proves nothing)", () => {
    // §"floor the input, not the output": bound what was READ. A renamed parseMode, a moved tools/ tree, or a
    // git-grep failure would otherwise empty this sweep and report a clean bill of health over nothing.
    expect(
      entrypoints.length,
      "no mode-aware entrypoints found — parseMode was renamed or the scan is broken, not the repo cleaned up",
    ).toBeGreaterThanOrEqual(8);
  });

  it("no mode-aware entrypoint silently defaults to `local`", () => {
    const gateSpecs = [...gatesFor("merge"), ...gatesFor("release")];
    const orphans: string[] = [];

    for (const file of entrypoints) {
      const bound = Object.entries(scripts).filter(([, cmd]) => cmd.includes(file));
      if (bound.length === 0) {
        // Reached by no package script at all: it cannot be run as a gate, so it cannot report a false PASS.
        continue;
      }
      for (const [name, cmd] of bound) {
        const baked = cmd.includes("--mode");
        const modeArg = gateSpecs.some((g) => g.kind === "cmd" && g.script === name && g.modeArg === true);
        const inCI = new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*--mode`).test(ci);
        if (!baked && !modeArg && !inCI) orphans.push(`${name} (${file})`);
      }
    }

    expect(
      orphans,
      "mode-aware gate script(s) that never receive a --mode, so parseMode defaults to `local`:\n  " +
        orphans.join("\n  ") +
        "\n\nIn `local` the gate goes ADVISORY: it prints its refusal, exits 0, and SUPPRESSES its " +
        "##SHUDDL-GATE## sentinel — so run-gate has nothing to reconcile and synthesizes PASS from the exit " +
        "code. §943 measured exactly this on two gates (0 sentinels each). Give it a mode from one of the " +
        "three legitimate sources: `modeArg: true` in gatesFor(), a baked `--mode` in the package script (for " +
        "a gate also invoked directly), or an explicit `--mode` in the workflow that drives it.",
    ).toEqual([]);
  });

  it("§938's exclusivity gate still exists (division of labour, not duplication)", () => {
    // This file allows BOTH sources; playwright-mode-parity forbids it for its family. If that file is
    // deleted, the "never both" half vanishes silently and this gate's permissiveness becomes a hole rather
    // than a deliberate split — the §"adding a gate can delete a gate" shape, one file over.
    const sibling = readFileSync(`${root}/tools/checks/playwright-mode-parity.test.ts`, "utf8");
    expect(
      sibling,
      "playwright-mode-parity.test.ts no longer enforces the XOR. This file only requires AT LEAST ONE mode " +
        "source, so 'never both' is now enforced nowhere.",
    ).toContain("BOTH sources supply a mode");
  });
});
