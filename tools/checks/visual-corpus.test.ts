import { describe, expect, it } from "vitest";
import { globSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { repoRoot } from "./repo-root.js";

// REQ-118/REQ-158 §608 — THE VISUAL GATE MUST TEST EVERY BLESSED SCREEN, NOT MERELY SOME.
//
// §607 found the acceptance gate certifying a demo whose test file did not exist. This is the SAME
// registry/filesystem divergence in the OPPOSITE direction: a blessed reference that exists while the
// registry no longer names it.
//
// MEASURED (§608): removing one entry from `SCREENS` in tests/visual/screens.spec.ts and running the gate
// under `--mode merge` produced
//
//     visual: PASS — 4 passed.
//     ##SHUDDL-GATE## {"gate":"visual","status":"PASS","executed":true,"assertions":4}
//
// exit 0. One of the five canonical screens stopped being verified, `blessed/status.png` stayed committed
// and unread, and the gate called it a pass.
//
// WHY THE GUARD CANNOT LIVE IN playwright-guard.ts: its disposition ladder already refuses the vacuous
// cases — `total === 0` is BLOCKED ("a suite that found nothing proves nothing") and `executedCount === 0`
// is BLOCKED ("a skip is not a pass"). But that guard is GENERIC across visual/a11y/e2e/perf, so it has no
// business knowing that *visual* owes exactly five screens. Its floor is necessarily at zero; the expected
// corpus is a property of this suite. §572's rule — a scanner's floor must bound the CORPUS IT READ, not
// the hits it found — is satisfied here, not there.
//
// A STATIC SCAN rather than an import, matching the convention of rater-purity/authority-coverage/
// append-chokepoint. `screens.spec.ts` calls `test()` at module scope, so importing it into vitest to read
// `SCREENS` would register playwright tests inside a vitest run.

const SPEC = "tests/visual/screens.spec.ts";
const BLESSED = "tests/visual/blessed";

/** The `name:` fields of the SCREENS array literal — the screens the playwright suite actually iterates. */
function registeredScreens(root: string): string[] {
  const src = readFileSync(`${root}/${SPEC}`, "utf8");
  const start = src.indexOf("const SCREENS: readonly Screen[] = [");
  if (start < 0) return []; // the non-vacuity test below turns this into a failure, not a silent pass
  // Bounded to the array literal: `];` at column 0 closes it, and no nested member sits at that indent.
  const end = src.indexOf("\n];", start);
  const body = src.slice(start, end < 0 ? undefined : end);
  return [...body.matchAll(/name:\s*"([^"]+\.png)"/g)].map((m) => m[1]!).sort();
}

/** The committed reference images. */
function blessedRefs(root: string): string[] {
  return globSync(`${BLESSED}/*.png`, { cwd: root }).map((p) => basename(p)).sort();
}

describe("REQ-158 §608: the visual suite covers every blessed screen", () => {
  const root = repoRoot();

  it("parses the SCREENS registry and finds the blessed refs (non-vacuity)", () => {
    // A renamed array, a restructured spec or a moved directory would compare [] to [] and pass — the class
    // this repo met in ten gates (§487/§554/§572/§584/§586/§590/§592/§593/§598/§607).
    expect(
      registeredScreens(root).length,
      "the SCREENS array did not parse — the spec moved or was restructured, which is not the same as the " +
        "screens being gone. Fix this scan before trusting the parity test below",
    ).toBeGreaterThanOrEqual(5);
    expect(blessedRefs(root).length, "no blessed reference images found — the directory moved").toBeGreaterThanOrEqual(5);
  });

  it("every blessed reference is named by SCREENS, and every SCREENS entry has a reference", () => {
    // BOTH directions, because each is a distinct failure:
    //  · a blessed ref no registry entry names → that screen is NO LONGER VERIFIED and the gate still passes
    //    (§608, measured: "PASS — 4 passed" with one entry deleted);
    //  · a registry entry with no blessed ref → playwright fails it on the first run, so this direction is
    //    already covered — it is asserted anyway so a future `--update-snapshots` habit cannot quietly add
    //    a screen whose reference nobody reviewed.
    expect(
      registeredScreens(root),
      "the visual registry and the blessed reference images have diverged. A blessed image that SCREENS no " +
        "longer names is a canonical screen that stopped being tested while the gate kept reporting PASS — " +
        "the browser gate's floor is at zero executed, never at the expected count, and it cannot be " +
        "otherwise because it is shared with a11y/e2e/perf",
    ).toEqual(blessedRefs(root));
  });

  it("the five canonical screens of WP-03's DoD are all present", () => {
    // Pinned by IDENTITY, not by count. CLAUDE.md's design CI names "5 blessed screenshots" and WP-03's DoD
    // reads "5 canonical screens match blessed refs"; a count alone would let one be swapped for another.
    expect(blessedRefs(root)).toEqual(["command.png", "driver.png", "evidence-email.png", "portal.png", "status.png"]);
  });
});
