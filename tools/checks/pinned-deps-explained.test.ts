import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §1058 — A NON-CARET RANGE IS A DECISION, AND A DECISION WITH NO WRITTEN REASON IS DEBT.
//
// §1057's rule: a pin that is correct, load-bearing and undocumented is debt even while everything is green.
// Its cost is not a failure today — it is that the next person pays the discovery cost again, from a broken
// build rather than from a note. Correctness and legibility are separate properties, and CI tests only one.
//
// `^x.y.z` is npm's DEFAULT — it carries no intent. An exact version or a `~` is something somebody chose,
// usually to stop a specific breakage, and the reason lives only in the head of whoever chose it.
//
// §1059 CORRECTION — the original text here said *"JSON cannot carry a comment, so there is nowhere in a
// manifest to write it down."* **That mechanism is false, and this repo disproves it**: a `"//"` KEY is legal
// JSON and is already used in five tracked files (`packages/map/tsconfig.json`, both `greige-style.json`s, two
// fixtures). Tools ignore unknown keys, so a manifest CAN hold prose.
//
// The gate is still the right home, but for a different and better reason: a `"//"` note is documentation CI
// cannot check, so it drifts the moment a pin moves and nothing notices. Keying the reasons to the LIVE
// manifests is what makes the two unable to disagree. Getting the mechanism wrong while reaching the right
// answer is the §"state the mechanism, not the outcome" defect — a comment saying WHY a property holds can be
// falsified by the code even when the property is true.
//
// MEASURED AT §1058 across all tracked manifests: **163 dependency declarations, 3 non-caret pins**, and two
// of the three had no written reason anywhere in the repo (`git grep` over docs/ and tools/ found the packages
// mentioned but never the CHOICE explained). The third — `chai: "5.3.3"` in `pnpm-workspace.yaml` — is the
// standard this gate holds the others to: three lines saying exactly which export fails under which runtime.
// That one needs no entry here because YAML let its author write the reason where the pin lives.
//
// WHY A GATE RATHER THAN A DOC: a doc describing the pins drifts the moment a pin changes, and nothing
// notices — the failure mode §945 and §988 produced. Keying the reasons to the LIVE manifests means adding a
// pin without a reason fails, removing a pin leaves a stale entry that fails, and the two can never disagree.

/** `name = range` for every dependency declaration that is NOT npm's `^` default. */
export function nonCaretPins(root: string): Map<string, string[]> {
  const files = execFileSync("git", ["ls-files", "package.json", "*/package.json", "*/*/package.json"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter((f) => f !== "");
  const out = new Map<string, string[]>();
  for (const f of files) {
    const json = JSON.parse(readFileSync(`${root}/${f}`, "utf8")) as Record<string, Record<string, string> | undefined>;
    for (const section of ["dependencies", "devDependencies", "peerDependencies"] as const) {
      for (const [name, range] of Object.entries(json[section] ?? {})) {
        // `workspace:` is pnpm's internal linkage, not a version decision.
        if (range.startsWith("^") || range.startsWith("workspace:")) continue;
        const key = `${name} = ${range}`;
        out.set(key, [...(out.get(key) ?? []), f]);
      }
    }
  }
  return out;
}

/**
 * Every deliberate pin, and WHY. Keyed `name = range`, so bumping the pinned version forces the author back
 * here to confirm the reason still holds — a stale reason is worse than none, because it reads as current.
 */
const REASONS: Readonly<Record<string, string>> = {
  "vitest = ~3.2.4":
    "TILDE (patch-only) because `@cloudflare/vitest-pool-workers@^0.9.14` requires vitest 3.x. Lifting this to " +
    "^4 breaks all six workerd suites — 2,018 of the 2,421 tests measured at §1054. It is also why " +
    "`pnpm-workspace.yaml` overrides `chai: 5.3.3`. The workspace therefore runs TWO vitest majors (3.2.7 here, " +
    "4.1.10 everywhere else); that split is filed as a standing checklist row (§1057) and unblocks only when " +
    "the pool moves off 0.9.x — the same upgrade L427's fix waits on (§1056).",
  "@playwright/test = 1.61.1":
    "EXACT because this repo compares 5 BLESSED SCREENSHOTS with `toHaveScreenshot` at a 2% " +
    "`maxDiffPixelRatio` (playwright.config.ts). Browser font rasterization changes between chromium builds, " +
    "and CI installs the browser matching whatever version resolves (`playwright install --with-deps chromium`), " +
    "so a floating range silently re-bases every visual comparison. The pin is not about correctness of the " +
    "API — it is about the BINARY being reproducible. Bumping it means re-blessing the screenshots deliberately.",
  "@axe-core/playwright = 4.12.1":
    "EXACT because it is peer-coupled to `@playwright/test`: it runs inside the same browser context and takes " +
    "the Page object as its input. Floating it independently of a pinned playwright is how a peer mismatch " +
    "reaches CI. Move the two together or not at all.",
};

describe("§1058: every deliberate dependency pin carries a written reason", () => {
  const root = repoRoot();
  const pins = nonCaretPins(root);

  it("finds the manifests and a real declaration corpus (non-vacuity — §968's rule)", () => {
    // A broken glob or a moved manifest would yield zero pins, and "no undocumented pins" over an empty set is
    // the false clean this repo has spent forty phases on. Floor the INPUT, not the finding.
    const files = execFileSync("git", ["ls-files", "package.json", "*/package.json", "*/*/package.json"], {
      cwd: root,
      encoding: "utf8",
    }).split("\n").filter((f) => f !== "");
    expect(files.length, "no package.json files found — the glob is broken, not the workspace").toBeGreaterThanOrEqual(10);
    expect(pins.size, "no non-caret pins found at all — either the parse broke or every pin was removed; if the latter, delete this gate deliberately").toBeGreaterThanOrEqual(1);
  });

  it("no pin is undocumented", () => {
    const undocumented = [...pins.entries()]
      .filter(([key]) => REASONS[key] === undefined)
      .map(([key, files]) => `${key}   (in ${files.length}: ${files.join(", ")})`);
    expect(
      undocumented,
      "dependency pin(s) that are NOT npm's `^` default and carry no written reason:\n  " +
        undocumented.join("\n  ") +
        "\n\nAn exact or `~` range is a DECISION — somebody chose it, usually to stop a specific breakage, and " +
        "JSON cannot hold the comment that says which. Add an entry to REASONS in this file naming what breaks " +
        "without the pin and what must be re-verified when it moves. The standard to match is " +
        "`pnpm-workspace.yaml`'s `chai: \"5.3.3\"`, whose three lines name the exact failing export and runtime.",
    ).toEqual([]);
  });

  it("no reason outlives its pin", () => {
    // The mirror direction, and the one that rots silently: a pin is bumped or dropped, the justification stays,
    // and the next reader trusts a sentence about a version that is no longer installed.
    const stale = Object.keys(REASONS).filter((key) => !pins.has(key));
    expect(
      stale,
      "REASONS entr(ies) naming a pin that no longer exists at that version:\n  " +
        stale.join("\n  ") +
        "\n\nThe key is `name = range`, so a version bump lands here by design — re-confirm the reason still " +
        "holds at the new version and update the key, or delete the entry if the pin is gone.",
    ).toEqual([]);
  });
});
