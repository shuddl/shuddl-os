import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §979 — A STEP THAT PRODUCES AN INDEPENDENT VERDICT MUST NOT BE SKIPPABLE BY AN EARLIER FAILURE.
//
// GitHub runs a job's steps in order and skips every later step once one fails. MEASURED AT §962: on
// 2026-07-31 the `perf` step failed and the NEXT step — "merge evidence gate — the complete non-skippable
// surface", the one that runs all 26 gates — was SKIPPED. Three consecutive CI runs ended that way, the last
// being the commit production still serves. §978 then measured the rest: 14 steps, 4 guarded, 10 sequential,
// with all FOUR browser gates unguarded — so a `visual` failure would have erased a11y, e2e and perf too.
// Only the accident that `perf` is last kept that from happening.
//
// THE LINE, from §978: an INDEPENDENT VERDICT gets a guard; a GENUINE PREREQUISITE does not.
//   - guarded: the four `--mode merge` browser gates, `verify:merge`, `pnpm audit --prod`. Each answers a
//     separate question, and each is worth reporting even when a sibling has already failed.
//   - unguarded on purpose: `build every workspace`, `install Playwright browser`. Their failure makes the
//     later steps MEANINGLESS rather than merely unreported — a gate run against an unbuilt tree emits noise,
//     not a verdict.
//
// The browser gates settle their own case: step 39 is titled "an absent browser BLOCKS, never skips". A gate
// built to refuse rather than vanish must not be made to vanish by the workflow that runs it.
//
// TEXT SCAN BY DESIGN. No YAML parser is installable in this environment (§973 — `yaml`, `js-yaml`, `pyyaml`
// and `actionlint` all absent, `npm install` into a temp dir fails), so a gate needing one could not exist
// here. Sibling: `workflow-pinning.test.ts` (§974) owns the supply-chain half of the same file; this owns
// step ordering. Neither subsumes the other.

const CI = ".github/workflows/ci.yml";

/** Steps whose `run:` produces an independent gate verdict — the ones a skip would silently erase. */
const VERDICT_MARKERS = ["--mode merge", "verify:merge", "audit --prod"];

interface Step {
  line: number;
  name: string;
  run: string;
  guard: string | null;
}

function steps(src: string): Step[] {
  const lines = src.split("\n");
  const out: Step[] = [];
  let cur: Step | null = null;
  lines.forEach((l, i) => {
    const name = /^ {6}- name: (.+)$/.exec(l);
    if (name !== null) {
      if (cur !== null) out.push(cur);
      cur = { line: i + 1, name: name[1] as string, run: "", guard: null };
      return;
    }
    if (cur === null) return;
    const guard = /^ {8}if:\s*(.+?)(?:\s+#.*)?$/.exec(l);
    if (guard !== null && cur.guard === null) cur.guard = guard[1] as string;
    const run = /^ {8}run:\s*(.+)$/.exec(l);
    if (run !== null) cur.run += `${run[1] as string} `;
  });
  if (cur !== null) out.push(cur);
  return out;
}

describe("§979: a step that produces an independent verdict is not skippable", () => {
  const src = readFileSync(`${repoRoot()}/${CI}`, "utf8");
  const all = steps(src);
  const verdicts = all.filter((s) => VERDICT_MARKERS.some((m) => s.run.includes(m)));

  it("finds steps and verdict-producing steps at all (non-vacuity — §968's rule)", () => {
    // checked=0 is a question, never an answer: a restructured workflow or a changed indent would otherwise
    // certify this rule over an empty set.
    expect(all.length, `no steps parsed from ${CI} — the scan is broken, not the workflow`).toBeGreaterThanOrEqual(10);
    expect(
      verdicts.length,
      `no verdict-producing steps found in ${CI}. Either the gate invocations were renamed (update ` +
        "VERDICT_MARKERS deliberately) or the scan broke — both must fail here rather than pass over nothing.",
    ).toBeGreaterThanOrEqual(6);
  });

  it("every verdict-producing step carries `if: !cancelled()`", () => {
    const bare = verdicts.filter((s) => !(s.guard ?? "").includes("cancelled()") && !(s.guard ?? "").includes("always()"));
    expect(
      bare,
      "CI step(s) that produce an independent gate verdict but are SKIPPED when an earlier step fails:\n  " +
        bare.map((s) => `${CI}:${s.line}  ${s.name}`).join("\n  ") +
        "\n\n§962 measured the cost: a failed `perf` step skipped the 26-gate merge-evidence surface entirely, " +
        "in three consecutive runs, on the commit production serves. §978 measured the rest: all four browser " +
        'gates were skippable, and step 39 is titled "an absent browser BLOCKS, never skips" — being skipped ' +
        "is the one outcome its own title forbids.\n" +
        "Add `if: ${{ !cancelled() }}`. The job still goes red; the verdict stops vanishing.",
    ).toEqual([]);
  });

  it("genuine prerequisites stay unguarded (the rule has a boundary, and it is deliberate)", () => {
    // Guarding these would produce noise rather than verdicts: a browser gate run against an unbuilt tree, or
    // with no browser installed, fails for a reason that says nothing about the code. If someone "completes"
    // the pattern by guarding everything, this fails and points at why.
    for (const marker of ["build every workspace", "install Playwright browser"]) {
      const step = all.find((s) => s.name.includes(marker));
      expect(step, `${CI} no longer has a step named like "${marker}" — re-scope this assertion deliberately`).toBeDefined();
      expect(
        (step as Step).guard,
        `"${marker}" gained a guard. It is a PREREQUISITE, not a verdict: running the later gates after it ` +
          "fails produces noise, not information. §978's line is that an independent verdict gets a guard and " +
          "a genuine prerequisite does not — if that judgement is being revised, revise it here on purpose.",
      ).toBeNull();
    }
  });
});
