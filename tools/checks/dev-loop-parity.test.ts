import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { gatesFor } from "../release/run-gate.js";
import { repoRoot } from "./repo-root.js";

// §838 — THE DEV LOOP AND THE MERGE ROSTER MUST NOT DRIFT APART.
//
// §837 found `check:chokepoint` in `verify:merge` and in neither `verify:dev` nor `verify:docs` — REQ-030's
// single-writer law, reachable only by the command §836 had just established nobody was running. It found it
// by comparing two lists BY HAND, and said so: a measurement with an expiry, not a standing guarantee.
//
// COMPARED BY SCRIPT, NOT BY NAME. `gatesFor("merge")` is exported and every spec carries the exact pnpm
// script it runs, so this reads the authority instead of parsing prose (§830: read one side, COMPUTE the
// other). Name matching would be wrong, not merely fragile — the two lists disagree on names BY DESIGN:
//
//     merge gate            script
//     identity-leak         check:identity
//     concierge-parse       check:concierge-parity
//     append-chokepoint     check:chokepoint
//
// Three false mismatches on day one is how a gate gets relaxed until it means nothing.
//
// ONLY ONE DIRECTION IS A DEFECT, and conflating them would make this unusable:
//   · a DEV step that is not a merge gate  → the inner loop enforces something the shippable verdict does
//     not, so a developer's green is stricter than the merge gate's and the gap is invisible at merge time.
//   · a MERGE gate absent from the dev chain → normal. A fast loop may skip the browser and build gates, and
//     three more live in `verify:docs`. Each absence is recorded below with its reason; an unaccounted one
//     fails.

/** The pnpm scripts `verify:dev` actually runs, in order. */
function devChainScripts(root: string): string[] {
  const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8")) as { scripts: Record<string, string> };
  return pkg.scripts["verify:dev"]!
    .split("&&")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("pnpm "))
    .map((s) => s.replace(/^pnpm\s+/, ""));
}

/**
 * Merge gates deliberately outside the dev chain, each with the reason it is not there. A reason that stops
 * being true is a row to delete, not a line to keep — which is why they are grouped by WHY rather than listed.
 */
const ACCOUNTED_ABSENCES: Record<string, string> = {
  // Names MEASURED from `gatesFor("merge")`, not guessed — the first draft of this roster wrote `perf` (the
  // gate name) where the script is `perf:map`, and listed `test:surfaces`, which is release-profile only and
  // not a merge gate at all. Both were caught by the two assertions below on the very first run, which is a
  // fair advertisement for the §672 half: a roster of reasons rots exactly like any other list.
  "check:citations": "covered by `verify:docs`, which a session runs.",
  "check:tables": "covered by `verify:docs`.",
  "check:section-refs": "covered by `verify:docs`.",
  "check:bundles": "requires a production build of all three surfaces — too slow for an inner loop.",
  "test:acceptance": "drives the five acceptance demos end to end; minutes, not seconds.",
  "perf:map": "browser/perf gate — needs a built surface and a running server.",
  "test:visual": "browser gate — same.",
  "test:a11y": "browser gate — same.",
  "test:e2e": "browser gate — same.",
};

describe("§838: verify:dev and the merge roster do not drift apart", () => {
  const root = repoRoot();
  const dev = devChainScripts(root);
  const merge = gatesFor("merge");
  const mergeScripts = new Set(
    merge.flatMap((g) => ("script" in g && typeof g.script === "string" ? [g.script] : [])),
  );

  it("both lists parsed (non-vacuity — two empty sets agree about nothing)", () => {
    // The failure mode §819 named: a parity test compares sets, and a set of zero always matches a set of
    // zero. Floors chosen well under the measured values (17 dev steps, 26 merge gates at §838).
    expect(dev.length, "verify:dev did not parse into pnpm steps — the script shape changed").toBeGreaterThanOrEqual(12);
    expect(mergeScripts.size, "gatesFor('merge') yielded no scripts — the spec shape changed").toBeGreaterThanOrEqual(15);
    expect(dev, "the dev chain no longer runs the test suite — that is not a parse problem").toContain("test");
  });

  it("no dev step is absent from the merge roster (the loop must not be stricter than the verdict)", () => {
    const devOnly = dev.filter((s) => !mergeScripts.has(s));
    expect(
      devOnly,
      "a gate runs in `verify:dev` but NOT in `verify:merge`. The inner loop is then stricter than the " +
        "shippable verdict: a developer sees it fail, fixes it, and nothing at merge time would have caught " +
        "the same defect. Add it to `gatesFor()` in tools/release/run-gate.ts, or take it out of the chain:\n  " +
        devOnly.join("\n  "),
    ).toEqual([]);
  });

  it("every merge gate absent from the dev chain is ACCOUNTED FOR with a reason", () => {
    const inChain = new Set(dev);
    const unaccounted = [...mergeScripts].filter((s) => !inChain.has(s) && !(s in ACCOUNTED_ABSENCES));
    expect(
      unaccounted,
      "a merge gate runs in neither `verify:dev` nor an accounted home. §837 found exactly this for " +
        "`check:chokepoint` — REQ-030's single-writer law, reachable only by a command nobody was running, " +
        "and (per its own note in run-gate.ts) the ONLY detector of a direct insert with a fresh id, because " +
        "the append-only triggers fire on collisions and there is none. Either add it to `verify:dev`, or " +
        "record here why it is deliberately out (cost, or a second home such as `verify:docs`):\n  " +
        unaccounted.join("\n  "),
    ).toEqual([]);
  });

  it("no ACCOUNTED_ABSENCES row outlives its subject (§672)", () => {
    // A reason for a gate that no longer exists, or that has since joined the chain, is a stale claim someone
    // will trust. Both conditions are failures.
    const inChain = new Set(dev);
    for (const [script, why] of Object.entries(ACCOUNTED_ABSENCES)) {
      expect(
        mergeScripts.has(script),
        `${script} is recorded as a deliberate absence but is no longer a merge gate at all — delete the row ("${why.slice(0, 48)}…")`,
      ).toBe(true);
      expect(
        inChain.has(script),
        `${script} is recorded as deliberately ABSENT from verify:dev, but the chain now runs it — delete the row`,
      ).toBe(false);
    }
  });
});
