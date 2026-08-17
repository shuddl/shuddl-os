import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEMOS, spineByPackage, spineFileCount } from "./demos.js";
import { missingSpineFiles, packageDirs } from "./run.js";
import { repoRoot } from "../checks/repo-root.js";
import { stripComments } from "../checks/strip-comments.js";

// REQ-119 (audit §68) — the acceptance manifest and this module must name the SAME spine.
//
// `demos.ts` calls itself "the single source of truth shared by the runner (run.ts) and the manifest
// (docs/wp/acceptance-demos.md), so the two can never drift." Half of that was true: `run.ts` imports this
// module, so the RUNNER cannot drift. The MANIFEST is hand-written markdown — it cites `demos.ts` but does
// not derive from it, so "can never drift" described an intention, not a mechanism. Adding a demo or moving
// a spine file would have left the manifest stale with nothing failing.
//
// These make the claim true. The manifest stays prose (it carries the filmed-half narrative, which is the
// point of it and is not derivable), but the FACTS it shares with this module — which spine files, how many,
// which demos — are now checked rather than asserted.

const MANIFEST_PATH = "docs/wp/acceptance-demos.md";
const manifest = (): string => readFileSync(MANIFEST_PATH, "utf8");

describe("REQ-119: the acceptance manifest cannot drift from the demo spine", () => {
  it("every spine file in demos.ts is named in the manifest", () => {
    const md = manifest();
    for (const demo of DEMOS) {
      for (const { pkg, file } of demo.spine) {
        expect(md, `${MANIFEST_PATH} must name demo ${demo.n}'s spine file ${file} (${pkg})`).toContain(file);
      }
    }
  });

  it("the manifest names NO spine file this module does not declare", () => {
    // The reverse direction. Without it, a spine file deleted from demos.ts would linger in the manifest,
    // which reads as coverage that no longer runs — the failure direction that overstates.
    const declared = new Set(DEMOS.flatMap((d) => d.spine.map((s) => s.file)));
    const named = new Set(manifest().match(/(?:test|src)\/[A-Za-z0-9._/-]+\.(?:test|spec)\.tsx?/g) ?? []);
    for (const file of named) {
      expect(declared.has(file), `${MANIFEST_PATH} names ${file}, which demos.ts does not declare as a spine file`).toBe(true);
    }
  });

  it("every demo is represented in the manifest by number and title", () => {
    const md = manifest();
    for (const demo of DEMOS) {
      expect(md, `manifest must cover demo ${demo.n}`).toMatch(new RegExp(`[Dd]emo\\s*${demo.n}\\b`));
    }
  });

  it("all five doc-00 demos are declared, each with at least one spine test and a stated filmed delta", () => {
    expect(DEMOS.map((d) => d.n)).toEqual([1, 2, 3, 4, 5]);
    for (const d of DEMOS) {
      expect(d.spine.length, `demo ${d.n} has no spine test`).toBeGreaterThan(0);
      // The filmed delta is what keeps a green spine from being read as a finished demo. A blank one would
      // silently promote "the code path exists" to "the demo is done".
      expect(d.filmed.length, `demo ${d.n} must state what the FILM must additionally show`).toBeGreaterThan(60);
    }
  });

  it("spineFileCount() matches the distinct files actually declared", () => {
    const distinct = new Set(DEMOS.flatMap((d) => d.spine.map((s) => `${s.pkg}::${s.file}`)));
    expect(spineFileCount()).toBe(distinct.size);
    expect([...spineByPackage().keys()].sort()).toEqual(["@shuddl/api", "@shuddl/driver", "@shuddl/map", "@shuddl/mcp"]);
  });
});

// REQ-119 §607 — the spine registry must name files that EXIST.
//
// §606 probed the acceptance gate by pointing demo 1's spine at a non-existent file. It reported
// `ACCEPTANCE SPINE: GREEN — all 7 spine FILES pass` at exit 0. The runner's comment had claimed immunity
// ("vitest exits non-zero on 'no test files found'"), which holds only when NO filter in the package
// matches: `@shuddl/api` carries four of the seven, so three siblings kept the exit at 0 while demo 1's
// proof silently stopped running.
//
// `missingSpineFiles()` in run.ts now fails the gate. This test is the cheaper signal — a renamed spine
// file is caught by `pnpm test` rather than only by the acceptance gate, and it is the test that fails if
// someone deletes the runtime check (§531: a guard whose removal is silent will eventually be removed).
describe("REQ-119 §607: every registered spine file exists", () => {
  it("resolves all 7 spine files to real paths on disk", () => {
    expect(
      missingSpineFiles(repoRoot()),
      "a spine file named in demos.ts does not exist. The demo it proves is UNTESTED and the acceptance " +
        "gate cannot see it — a vitest filter matching nothing is silent when a sibling filter matches",
    ).toEqual([]);
  });

  it("§1003: resolution is anchored to the REPO, not to the shell's directory", () => {
    // The default was `process.cwd()`, so `pnpm test:acceptance` run from any subdirectory reported the
    // acceptance spine as broken — 0 missing from the root, 4 from `packages/ledger`. Fail-CLOSED, which is
    // why it survived the sweep that anchored sixteen other gates: it cried wolf instead of passing vacuously.
    //
    // The tell was in THIS file: the assertion above passes `repoRoot()` explicitly, working around the
    // default rather than fixing it. That argument is now redundant and deliberately kept, so the parameter
    // stays exercised while the no-argument call below pins the default.
    const here = process.cwd();
    try {
      process.chdir(`${repoRoot()}/tools/checks`);
      expect(
        missingSpineFiles(),
        "missingSpineFiles() resolved against the SHELL's directory rather than the repo. Restore the " +
          "`repoRoot()` default in run.ts — a gate that means the repo must never ask where you are standing.",
      ).toEqual([]);
      expect(packageDirs().size, "packageDirs() resolved no workspace packages from a subdirectory").toBeGreaterThanOrEqual(10);
    } finally {
      process.chdir(here);
    }
  });

  it("counts what the registry declares (non-vacuity)", () => {
    // If spineByPackage() ever returned nothing, missingSpineFiles() would return [] and the test above
    // would pass over an empty spine — the exact vacuity class this section exists to close.
    expect(spineFileCount(), "the spine registry is empty — the scan is broken, not the tree").toBe(7);
  });
});

// §889 — A RENAMED SPINE TEST WAS CAUGHT; A GUTTED ONE WAS NOT.
//
// §888 mutation-proved that renaming a spine file fails the runner ("the demo they prove is UNTESTED"), and
// closed by naming what that leaves open: the registry proves a file EXISTS and RUNS, never that it still
// asserts what it did. A spine test emptied to `expect(true).toBe(true)` keeps its name, keeps its path, and
// keeps the acceptance gate green.
//
// §827 built this pattern for the isolation suite: per-file floors, the suite derived from their keys, and the
// aggregate derived by summing (§823 — two numbers that must agree should be ONE). The SHAPE transfers here.
// The METRIC does not, and that difference is the whole reason this block is worth its lines:
//
//   §827 floors on CASE count. `heartbeat.test.ts` is ONE `it()` carrying FORTY-EIGHT assertions — demo #1's
//   entire causal chain (gated stop → pod.signed → queue → Biller → invoice + evidence email) in a single
//   case. A case-count floor reads 1, and still reads 1 after the body is deleted. Copying the precedent
//   faithfully would have shipped a gate blind to the demo that matters most.
//
// So: assertions per file. Floors sit at ~80% of the 2026-08-09 measurement, so ordinary churn does not trip
// them — which means this catches GUTTING, not EROSION (48 → 40 passes). It also cannot see a HOLLOWED
// assertion: `toBeDefined()` counts the same as a penny-exact invoice comparison. Counting is the cheap half.
const ASSERTION_FLOOR: Readonly<Record<string, number>> = {
  // Keyed "<pkg> <pkg-relative file>", exactly as the registry names them — resolved to disk through the
  // runner's OWN packageDirs(), so this cannot drift from how the acceptance gate locates the same files.
  "@shuddl/api test/heartbeat.test.ts": 40, // measured 48 — demo #1, one case, the whole chain
  "@shuddl/api test/signup-to-quote.e2e.test.ts": 10, // measured 13
  "@shuddl/driver src/flow/stop-flow.test.ts": 30, // measured 36
  "@shuddl/api test/airplane-soak.test.ts": 24, // measured 29
  "@shuddl/mcp test/quote-book.test.ts": 30, // measured 37
  "@shuddl/api test/command-heartbeat.test.ts": 33, // measured 40
  "@shuddl/map test/MapCanvas.test.tsx": 28, // measured 34
};

/** Aggregate DERIVED from the per-file floors — never written twice (§823). */
const MIN_ASSERTIONS = Object.values(ASSERTION_FLOOR).reduce((a, b) => a + b, 0);

/**
 * `expect(` OCCURRENCES in the source — a static count, not vitest's assertion tally (§902).
 *
 * It counts call sites, so one `expect` inside a loop counts once however many times it runs, and an
 * `it.each` block's assertions count once per source line rather than per row. §890 measured this corpus'
 * assertion STRENGTH with a naive forward-scan and mis-classified property accesses inside the argument
 * (`expect(res.json.id)`) as matchers; §891 re-measured with a balanced-paren scanner. Counting call sites is
 * the robust half — what each assertion is worth, no count answers.
 *
 * The floors below are therefore in `expect(` call sites. Compare them to this function, never to a run count.
 */
/**
 * §1277 — count `expect(` sites that are ACTUALLY LIVE, i.e. not inside a comment.
 *
 * The previous counter matched raw text, so a COMMENTED-OUT assertion still counted. That is not hypothetical:
 * measured by commenting out 15 of `heartbeat.test.ts`'s 48 assertions — the file still ran, those 15 no longer
 * executed, and this gate stayed GREEN. That is verbatim the state its own failure message exists to prevent
 * ("the file exists and runs, while the demo it proves no longer proves it"). DELETING the same 15 fired
 * correctly; commenting out is the far more common way a test is weakened, because it is what someone does to a
 * failing assertion mid-refactor.
 *
 * Deliberately a stripper, not a parser: block comments, then line comments (the `[^:]` guard keeps `://` in a
 * URL from eating the rest of the line). §890/§891's lesson is respected — this does not judge assertion
 * STRENGTH, only whether the call site is live code.
 */
export function countExpectSites(src: string): number {
  const stripped = stripComments(src);
  return (stripped.match(/\bexpect\s*\(/g) ?? []).length;
}

function assertionCount(root: string, key: string): number {
  const [pkg, file] = key.split(" ") as [string, string];
  const dir = packageDirs(root).get(pkg);
  if (dir === undefined) throw new Error(`no workspace package named ${pkg} — the floor names a package that does not exist`);
  return countExpectSites(readFileSync(`${root}/${dir}/${file}`, "utf8"));
}

describe("§889: a spine test may not be gutted", () => {
  const root = repoRoot();

  it("every floored file is a REGISTERED spine file (§672 — no row outlives its subject)", () => {
    // A floor on a file the registry no longer names is dead weight that reads as coverage.
    const registered = new Set([...spineByPackage()].flatMap(([pkg, files]) => files.map((f) => `${pkg} ${f}`)));
    const orphaned = Object.keys(ASSERTION_FLOOR).filter((f) => !registered.has(f));
    expect(orphaned, "a floor names a file the spine registry does not").toEqual([]);
    expect(Object.keys(ASSERTION_FLOOR).length, "every spine file needs a floor").toBe(spineFileCount());
  });

  it("no spine file has fallen below its assertion floor, and the total holds", () => {
    const fallen = Object.entries(ASSERTION_FLOOR)
      .map(([f, floor]) => ({ f, n: assertionCount(root, f), floor }))
      .filter((c) => c.n < c.floor);
    expect(
      fallen.map((c) => `${c.f}: ${c.n} assertions, floor ${c.floor}`),
      "a spine test has been weakened. The acceptance gate would stay GREEN — the file exists and runs — " +
        "while the demo it proves no longer proves it. Restore the assertions, or lower the floor here and " +
        "say which demo lost which proof",
    ).toEqual([]);

    const total = Object.keys(ASSERTION_FLOOR).reduce((n, f) => n + assertionCount(root, f), 0);
    expect(total, "the spine's aggregate assertion count fell below the derived floor").toBeGreaterThanOrEqual(MIN_ASSERTIONS);
  });

  // §1692 — THE HOLE THE BLOCK ABOVE NAMES, GIVEN A NUMBER.
  //
  // The floors count `expect(` call sites, and their own header says what that cannot see: "a HOLLOWED
  // assertion — `toBeDefined()` counts the same as a penny-exact invoice comparison. Counting is the cheap
  // half." Hollowing is the erosion that PRESERVES the count: swap `toBe(148000)` for `toBeDefined()` and
  // every floor above still holds while the demo stops proving anything.
  //
  // The ratio is mechanical, so unlike a judgement about whether an assertion is STRONG it needs no English.
  // MEASURED at §1692 across the seven spine files: **12 weak of 245 call sites = 4.9%**, per file
  // 0.0–10.3%. The cap sits at 15% — roughly triple the live ratio, so ordinary churn and legitimate presence
  // checks never trip it, while a systematic swap does.
  //
  // WHAT IT DOES NOT CLAIM: a weak matcher is not a defect. `toBeDefined()` on a presence check is exactly
  // right, which is why this is a RATIO with headroom rather than a ban. It catches the DIRECTION of a
  // trend, not the merit of any single line.
  const WEAK_MATCHER = /\.(toBeDefined|toBeTruthy|toBeFalsy|toBeNull|toBeUndefined)\(/g;

  /**
   * PER FILE, not aggregate — and the first cut of this gate got that wrong (§1692).
   *
   * An aggregate cap dilutes a single-file gutting across the whole spine: hollowing TWELVE assertions in
   * `heartbeat.test.ts` — demo #1's entire causal chain — moved the aggregate from 4.9% to 9.8% and passed a
   * 15% cap. That is the exact defect this gate exists for, sailing through it. The floors above are per-file
   * for the same reason their header gives about case counts, and this must match them.
   *
   * MEASURED at §1692, per file: heartbeat 2.1% · signup-to-quote 0.0% · stop-flow 0.0% · airplane-soak
   * 10.3% · quote-book 6.7% · command-heartbeat 7.5% · MapCanvas 5.9%. The cap is 25% — over twice the
   * highest live file, so presence checks stay legitimate, while the 12-swap above lands at 27%.
   */
  const MAX_WEAK_RATIO_PER_FILE = 0.25;

  it("§1692 no spine file HOLLOWS OUT — the erosion an assertion count cannot see", () => {
    const rows = Object.keys(ASSERTION_FLOOR).map((key) => {
      // Resolved exactly as `assertionCount` does — through the runner's own packageDirs() Map — so the
      // numerator and denominator can never read different files.
      const [pkg, file] = key.split(" ") as [string, string];
      const dir = packageDirs(root).get(pkg);
      if (dir === undefined) throw new Error(`no workspace package named ${pkg}`);
      const text = readFileSync(`${root}/${dir}/${file}`, "utf8");
      const calls = assertionCount(root, key);
      const weak = (text.match(WEAK_MATCHER) ?? []).length;
      return { key, weak, calls, ratio: calls === 0 ? 1 : weak / calls };
    });

    const total = rows.reduce((n, r) => n + r.calls, 0);
    expect(total, "no spine assertions counted — the resolver or the counter broke, not the spine").toBeGreaterThan(150);

    const hollow = rows.filter((r) => r.ratio > MAX_WEAK_RATIO_PER_FILE);
    expect(
      hollow.map((r) => `${r.key}: ${r.weak}/${r.calls} weak (${(r.ratio * 100).toFixed(1)}%)`),
      "a spine file's assertions have HOLLOWED OUT: weak matchers (toBeDefined/toBeTruthy/toBeFalsy/" +
        "toBeNull/toBeUndefined) now exceed a quarter of its call sites. The floors above cannot see this — " +
        "replacing a penny-exact comparison with toBeDefined() keeps the count identical while the demo stops " +
        "proving what it claims. A weak matcher is not itself a defect (a presence check is exactly right); " +
        "what this catches is the DIRECTION of a whole file. Live at §1692: 0.0%–10.3% per file",
    ).toEqual([]);
  });
});
