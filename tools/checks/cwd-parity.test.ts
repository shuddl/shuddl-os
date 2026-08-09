import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// REQ-118 §559 — A GATE'S VERDICT MUST NOT DEPEND ON THE CALLER'S DIRECTORY.
//
// This session fixed **sixteen** scripts for CWD-dependence one at a time: design-audit's five paths (§554),
// three parity gates' ten literals (§558), then seven more found by sweeping. Fixing instances without the
// mechanism is how §489 arrived at instance #5 of a different convention defect, and sixteen is well past the
// point where the next one is a matter of time.
//
// The defect is invisible in normal use because every gate is invoked from the repo root through `pnpm`. It
// surfaces in three ways, in increasing order of harm:
//   1. an ENOENT crash — loud, and protection only by accident (§489: a graceful config default converts it
//      to a clean),
//   2. a floor firing — correct, fail-closed, and what the well-built gates do,
//   3. **a pass over nothing** — `design-audit` printed `clean` and `invoice-parity` printed
//      `penny for penny (harness live)`, both at exit 0, having read zero files.
//
// The invariant this pins: a gate must reach the SAME verdict from anywhere, or fail closed.
//
// **It does not, by itself, exclude (3)** — measured, not assumed. Un-rooting `design-audit`'s corpus scan
// AND removing its floor makes it print `clean` at exit 0 from BOTH directories, and this file passes. Exit
// codes agree; the gate read nothing. Vacuity is the FLOORS' job (§487/§554/§558), one per gate, and
// divergence is this file's job. Neither covers the other, and the pair is what makes a green mean something:
// the floor proves the corpus was real, and this proves the corpus does not change with the caller.
//
// The gate list is DERIVED from package.json rather than kept here, so a new `check:*` script is covered on
// the day it is added — the §541 shape, where a hand-kept enumeration of a set the project already defines is
// itself the thing that rots.

interface Gate {
  name: string;
  script: string;
}

/** Every `check:*` / `audit:*` script that runs a TypeScript tool — read from package.json, never listed here. */
function derivedGates(root: string): Gate[] {
  const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8")) as { scripts: Record<string, string> };
  return Object.entries(pkg.scripts)
    .filter(([name, cmd]) => /^(check|audit):/.test(name) && /^tsx tools\//.test(cmd))
    .map(([name, cmd]) => ({ name, script: cmd.replace(/^tsx /, "") }));
}

/**
 * §744 — INPUT A GATE NEEDS IN ORDER TO RUN AT ALL.
 *
 * A gate that SKIPS for want of an input returns the same result from every directory, so this parity check
 * sees no drift and reports it clean — while its actual scan path may be thoroughly CWD-dependent. That is not
 * hypothetical: `check:identity` skips without a denylist, and §731 found by hand that its read path resolved
 * against `process.cwd()` while its listing was repo-rooted. Run from `tools/checks/` WITH a denylist it
 * emitted `PASS · executed: true · assertions: 0` — a positive verdict over a scan of nothing, in the gate
 * enforcing "no identity in ANY repo artifact". This file existed at the time (§559) and could not see it,
 * because both runs said "no denylist available".
 *
 * The generalisation is worth more than the instance: **a blocked gate is invisible to the meta-gates that
 * watch gates.** So supply the minimum input that makes the real path execute. The term below is chosen to
 * appear nowhere in the tree, so a healthy run is CLEAN at both directories; §731's zero-files floor is what
 * turns a broken read path into a non-zero exit rather than another silent agreement.
 */
//
// THE TERM IS ASSEMBLED AT RUNTIME, and that is not stylistic. `check:identity` scans every tracked file's
// CONTENT for each denylist term — including this one. A literal probe term written here IS in the tree, so
// the scan finds it and reports a leak in this very file: measured, exit 1 from BOTH directories, which is
// "parity" achieved by failing everywhere for the wrong reason. Splitting it means the whole string never
// appears in any file, so a healthy run is genuinely clean.
const PROBE_TERM = ["ZZ", "CWDPARITY", "PROBE", "ABSENT"].join("-");

interface RunInput {
  readonly env: Readonly<Record<string, string>>;
  /**
   * Evidence the input TOOK EFFECT, asserted positively below.
   *
   * §745 measured why this is required: removing the entry below made `check:identity` skip again, and the
   * "did it execute?" detector stayed silent — that gate's skip path prints prose, not a `##SHUDDL-GATE##`
   * line, so "no structured verdict" was read as "it ran". A negative detector cannot see a skip it does not
   * recognise; a POSITIVE assertion that the gate got past its own precondition can.
   */
  readonly skipMarker: RegExp;
}

const RUN_ENV: Readonly<Record<string, RunInput>> = {
  "check:identity": { env: { IDENTITY_DENYLIST: PROBE_TERM }, skipMarker: /no denylist available/i },
};

/** Exit code AND stdout of a gate run with an explicit cwd. */
function runFrom(root: string, script: string, cwd: string, env: Readonly<Record<string, string>> = {}): { code: number; out: string } {
  // BOTH STREAMS. A gate's skip notice often goes to console.warn/error — `check:identity` prints "no denylist
  // available" on STDERR — and `execFileSync` returns stdout only, so a stdout-only capture cannot see the very
  // markers this file reasons about. Measured: the §745 probe stayed silent until stderr was included.
  const r = spawnSync("node", ["--import", "tsx", `${root}/${script}`], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

/**
 * §745 — DID THE GATE ACTUALLY RUN? Two skips agree perfectly.
 *
 * §744 fixed the instance (`check:identity` skipped without a denylist, so both directories printed the same
 * "no denylist" line and the parity assertion passed over a gate that never executed). The CLASS is that a
 * comparison of two non-executions is vacuous, and this file reported it as coverage — the same
 * `assertions: 0 beside status: PASS` shape this audit has met in four tools.
 *
 * The gates that cannot run without a private fixture say so in machine-readable form: a `##SHUDDL-GATE##`
 * line carrying `"executed": false`. So non-execution is DETECTED here rather than assumed, and the set of
 * gates in that state is asserted against a declared roster — a NEW gate that starts skipping is loud instead
 * of silently uncovered.
 */
function executed(out: string): boolean {
  const m = /##SHUDDL-GATE##\s*(\{.*\})/.exec(out);
  if (m === null) return true; // no structured verdict — assume it ran; the parity comparison is meaningful
  try {
    return (JSON.parse(m[1]!) as { executed?: unknown }).executed !== false;
  } catch {
    return true; // unparseable verdict is not evidence of a skip
  }
}

/**
 * Gates whose real path cannot execute in this repo, WITH the reason. Each is BLOCKED on an engagement-workspace
 * fixture (`fixtures/manifest.json` marks them pending, sha256 null) — owner-held, not a defect here. Their
 * parity result is vacuous until the fixture lands, and this roster is what makes that visible rather than
 * counted as passing.
 */
const NOT_EXECUTED_WITHOUT_INPUT: readonly string[] = [
  "check:fixtures", // the nine vendored fixtures themselves
  "check:rater-parity", // fixtures/rater/*, fixtures/tariff
  "check:invoice-parity", // fixtures/invoice-replay, fixtures/tariff
  "check:concierge-parity", // fixtures/concierge/parse-50, fixtures/tariff
];

// `check:invariants` is the ONE deliberate exception, and it is exempted from parity but NOT from scrutiny.
// Its `main()` runs ~15 bare CWD-relative globs, and that is load-bearing: its own end-to-end tests spawn the
// CLI inside temp repos (`withTempRepo`) to build a corpus and prove the §487 floor fires. Rooting it — by
// defaulting the scan to repoRoot() or by chdir — breaks that harness, which was measured, not assumed: both
// attempts turned its three CLI tests red. So it is asserted to fail CLOSED off-root instead, which is the
// safe direction and keeps the property watched rather than waived.
const FAIL_CLOSED_BY_DESIGN = new Set(["check:invariants"]);

describe("REQ-118 §559: no gate's verdict depends on the caller's directory", () => {
  const root = repoRoot();
  const gates = derivedGates(root);

  it("derives a real gate list from package.json (non-vacuity)", () => {
    // A renamed script prefix or a changed command shape would yield an empty list, and every assertion
    // below would pass over it — the §487/§554 class this very file exists to prevent.
    expect(gates.length, "no check:*/audit:* tool scripts found — the derivation is stale, not the repo").toBeGreaterThan(15);
    expect(gates.map((g) => g.name)).toContain("audit:design");
  });

  it("every gate reaches the same verdict from a subdirectory, or fails closed", () => {
    const subdir = `${root}/tools/checks`;
    const offenders: string[] = [];
    const skipped: string[] = [];
    const inert: string[] = [];
    for (const { name, script } of gates) {
      const input = RUN_ENV[name];
      const atRoot = runFrom(root, script, root, input?.env ?? {});
      const offRoot = runFrom(root, script, subdir, input?.env ?? {});
      // A RUN_ENV entry exists precisely so this gate's REAL path runs. If it still printed its skip marker,
      // the input stopped working and the parity comparison below is vacuous for it — the §744 defect exactly.
      if (input !== undefined && input.skipMarker.test(atRoot.out)) inert.push(`${name} (still printing its skip marker despite RUN_ENV)`);
      // §745 — a gate that did not EXECUTE agrees with itself for free. Record it as uncovered rather than
      // letting an equal pair of skips read as a verified property.
      if (!executed(atRoot.out)) skipped.push(name);
      if (atRoot.code === offRoot.code) continue;
      if (FAIL_CLOSED_BY_DESIGN.has(name) && offRoot.code !== 0) continue; // documented above; still not allowed to PASS
      offenders.push(
        `${name}: root=${atRoot.code} subdir=${offRoot.code}` +
          (offRoot.code === 0 ? "  ← PASSES off-root having read a different (or empty) corpus" : ""),
      );
    }
    expect(
      offenders,
      `gate verdict(s) that depend on the caller's directory — resolve inputs through repoRoot() ` +
        `(tools/checks/repo-root.ts), never process.cwd():\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);

    expect(
      inert,
      "a RUN_ENV entry no longer makes its gate execute, so this file is comparing two skips for it and " +
        "reporting them as parity — the §744 defect. Fix the input, or move the gate to " +
        "NOT_EXECUTED_WITHOUT_INPUT with the reason:\n  " + inert.join("\n  "),
    ).toEqual([]);

    // §745 — WHAT THIS CHECK DID NOT COVER, stated rather than implied. A gate whose real path never ran was
    // not tested for CWD-dependence at all; §744 is what that costs (a mechanism built to end the class missed
    // the very next instance, because two skips agree). The roster is asserted BOTH ways: a new skipping gate
    // must be declared, and a gate that starts executing must be removed from the roster so the exemption
    // cannot outlive its reason.
    expect(
      skipped.sort(),
      "the set of gates that did NOT execute has changed. If a gate now skips, its parity result is vacuous — " +
        "declare it in NOT_EXECUTED_WITHOUT_INPUT with the input it lacks, or give it a RUN_ENV entry so its " +
        "real path runs. If a gate started executing, drop it from that roster: an exemption that outlives its " +
        "reason is the thing this file exists to prevent",
    ).toEqual([...NOT_EXECUTED_WITHOUT_INPUT].sort());
  }, 120_000);
});
