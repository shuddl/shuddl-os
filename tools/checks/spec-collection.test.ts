import { describe, expect, it } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { basename } from "node:path";
import { repoRoot } from "./repo-root.js";
import { DEMOS } from "../acceptance/demos.js";

// REQ-158/285/288 §727 — AN ALWAYS-FAILING BROWSER SPEC CAN MERGE GREEN, BECAUSE NOTHING COLLECTS IT.
//
// The e2e project does not select its tests by directory. It selects them by an explicit two-file allowlist:
//
//     { name: "e2e", testDir: "./tests/e2e", testMatch: /(driver-offline-sync|portal-isolation)\.spec\.ts$/ }
//
// So a spec added to `tests/e2e/` is not "not yet passing" — it is NOT RUN, and there is no report in which
// its absence appears. MEASURED, by planting `tests/e2e/zz-orphan.spec.ts` containing `expect(1).toBe(2)`:
//
//     playwright --list --project=e2e   →  "Total: 6 tests in 2 files"   (unchanged; the orphan is invisible)
//     test:tools                        →  "3 failed | 985 passed (988)" (IDENTICAL to the baseline)
//
// The exit code proved nothing on its own — `test:tools` was ALREADY red on an unrelated uncommitted register
// row, so only comparing the failure COUNTS showed that nothing had reacted (§"attribute the RED").
//
// This is not hypothetical drift. Two of the five acceptance demos name a new browser spec as "the documented
// next in-repo increment" (`tools/acceptance/demos.ts`, demos 3 and 5), and `Demo.browser` — the field that
// would record it — is read by NOTHING today: declared once, set to `null` five times, consumed nowhere.
// The next author writes the spec, drops it in `tests/e2e/`, sees the e2e gate PASS, and is entitled to
// believe the demo is covered. The allowlist is a REASONABLE design (it is what splits the a11y project from
// the e2e project on one directory — see the config's own V1-remediation note); what is missing is anything
// that notices a file no project claims.
//
// THE GATE ASKS PLAYWRIGHT, IT DOES NOT RE-IMPLEMENT IT. Re-deriving `testDir` × `testMatch` in a regex here
// would be a second copy of a rule that already exists, and this repo has been bitten by exactly that
// (`share-lint-matchers-with-parity-tests`). `--list --reporter=json` is the authoritative answer to "what
// would run", straight from the tool that decides it.

/** Every playwright config — derived, because "is this a playwright config" is a property of the CODE (§699). */
function configs(root: string): string[] {
  return execSync('git ls-files "*playwright*.config.ts"', { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
}

/** Every browser spec. `*.spec.ts` is this repo's playwright suffix; vitest owns `*.test.ts` (§711 pinned this). */
function specs(root: string): string[] {
  return execSync('git ls-files "*.spec.ts"', { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
}

/**
 * The files playwright would actually collect for one config.
 *
 * Returned paths are relative to each config's own root, so the root config yields `tests/e2e/x.spec.ts`
 * while the map and prod configs yield a bare `perf.spec.ts`. Comparing BASENAMES is what makes the three
 * commensurable — and the duplicate-basename floor below is what keeps that comparison honest.
 *
 * FAIL-CLOSED, and deliberately by throwing rather than returning []: an empty set would still red here
 * (every spec would look orphaned), but it would red with the WRONG diagnosis. The message must say
 * "playwright could not enumerate" and not "your specs are orphaned" (§"when a gate looks wrong, suspect the
 * measurement").
 */
function collectedBasenames(root: string, config: string): Set<string> {
  let raw: string;
  try {
    raw = execFileSync("pnpm", ["exec", "playwright", "test", "--list", "--reporter=json", "-c", config], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    throw new Error(`playwright could not enumerate ${config} — this gate cannot see what would run, so its silence would mean nothing: ${String(err)}`);
  }
  const parsed = JSON.parse(raw) as { suites?: { file?: string }[] };
  const files = (parsed.suites ?? []).map((s) => s.file).filter((f): f is string => typeof f === "string");
  return new Set(files.map((f) => basename(f)));
}

describe("REQ-158/285/288 §727: every browser spec is claimed by a playwright project", () => {
  const root = repoRoot();
  const cfgs = configs(root);
  const allSpecs = specs(root);

  it("finds the configs and the spec corpus (non-vacuity — an empty scan must not read as clean)", () => {
    // Both sides of the comparison need a floor. Without them a renamed suffix makes the superset assertion
    // below trivially true — {} ⊇ {} — which is the failure mode this repo has met in ten gates (§487…§607).
    expect(cfgs.length, "no playwright configs found — the scan is broken, not the tree").toBeGreaterThanOrEqual(3);
    expect(allSpecs.length, "no *.spec.ts files found — the scan is broken, not the tree").toBeGreaterThanOrEqual(6);
  });

  it("no two specs share a basename (the precondition that makes cross-config comparison sound)", () => {
    // The map and prod configs report bare basenames, so basename is the only common key. If two specs ever
    // share one, a collected `perf.spec.ts` would vouch for an uncollected `perf.spec.ts` elsewhere — the
    // comparison would silently start lying instead of failing. Stated as its own assertion so that the day
    // it happens, the failure names the CAUSE rather than pointing at an innocent spec.
    const names = allSpecs.map((s) => basename(s));
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes, `two browser specs share a basename, which breaks how this gate matches collected files to the corpus. Rename one, or teach collectedBasenames() to resolve full paths per config root:\n  ${dupes.join("\n  ")}`).toEqual([]);
  });

  it.each(configs(repoRoot()))("%s collects at least one spec (a config that runs nothing is a dead gate)", (config) => {
    // Per-config, not just in aggregate: the union could stay complete while one config silently stopped
    // matching anything, and that config's gate would report PASS over zero tests.
    expect(
      collectedBasenames(root, config).size,
      `${config} collects NO spec files. Whatever gate selects this config now runs nothing and still exits 0`,
    ).toBeGreaterThanOrEqual(1);
  });

  it("the acceptance registry's `browser` field is not a no-op (dormant today — all five are null)", () => {
    // §679's shape. `Demo.browser` is declared once, set to `null` five times, and read by NOTHING — so the
    // day demo 3 or demo 5's "documented next in-repo increment" lands and someone writes
    // `browser: "tests/e2e/gated-stop.spec.ts"`, that string is decoration. The orphan assertion below covers
    // the file once it EXISTS; this covers the field pointing somewhere that does not exist at all.
    const named = DEMOS.filter((d) => d.browser !== null);
    for (const d of named) {
      expect(
        allSpecs,
        `demo ${d.n} names a browser spec (${String(d.browser)}) that is not in the tracked spec corpus. The ` +
          "field is read by nothing, so an unpaired path here is a claim of coverage with no test behind it",
      ).toContain(d.browser);
    }
    // The assumption this assertion rests on (§721): if the field is deleted, this check silently guards
    // nothing. Make that loud rather than green.
    expect(
      DEMOS.every((d) => "browser" in d),
      "`Demo.browser` no longer exists. Either the browser specs were wired in properly — in which case delete " +
        "this assertion and say so — or the field was dropped and this gate now guards nothing",
    ).toBe(true);
  });

  it("every spec file would actually RUN under some config", () => {
    const collected = new Set<string>();
    for (const c of cfgs) for (const b of collectedBasenames(root, c)) collected.add(b);
    const orphans = allSpecs.filter((s) => !collected.has(basename(s)));
    expect(
      orphans,
      "a browser spec exists that NO playwright project collects. It is not failing — it is not running, and " +
        "no report shows its absence: a spec asserting `expect(1).toBe(2)` merges green (measured). Either add " +
        "it to a project's `testMatch` (the e2e project is an explicit allowlist, so a new file needs an edit " +
        "there), or delete the file:\n  " +
        orphans.join("\n  "),
    ).toEqual([]);
  });
});
