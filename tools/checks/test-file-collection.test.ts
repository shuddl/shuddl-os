import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// REQ-118 §728 — §727'S DEFECT, IN VITEST. A TEST FILE THE CONFIG DOES NOT MATCH IS NOT RUN, AND IS SILENT.
//
// §727 found that a browser spec outside playwright's `testMatch` merges green. The identical hazard exists
// one layer down: a vitest `include` is a NARROWING of the default, and anything outside it is invisible —
// not failing, not skipped, not counted. MEASURED in `packages/design`, whose include read `test/**/*.test.tsx`:
//
//     planted packages/design/test/zz-probe.test.ts  →  expect(1).toBe(2)
//     vitest run                                     →  "Test Files 2 passed (2)"   ← never collected
//
// §709 already gated the layer ABOVE this — every package holding tests declares a `test` script — and this is
// the layer it stops one line short of: the package runs, the script runs, and one file inside it does not.
// That is the adjacency shape (`check-what-a-discipline-stops-one-line-short-of`): the discipline existed, it
// was applied at the package boundary, and the file boundary never got it.
//
// SCOPE IS EXACTLY THE PACKAGES THAT NARROW. Six of eleven configs declare no `include` and therefore inherit
// vitest's default (`**/*.{test,spec}.?(c|m)[jt]s?(x)`), which cannot orphan a `*.test.ts(x)` anywhere in the
// package. Five narrow it, and only those five can lose a file:
//
//     apps/command · apps/driver · apps/portal   src/**/*.test.{ts,tsx}   — anything outside src/ is dropped
//     packages/map                               test/**, perf/**        — anything in src/ is dropped
//     packages/design                            (was) test/**/*.test.tsx — every .test.ts was dropped  ← FIXED
//
// LIMIT, STATED: this matches with node's `globSync`, not with vitest's own globber (tinyglobby/picomatch is
// a transitive dep and is not resolvable under pnpm's strict layout — checked). For patterns this simple the
// semantics coincide, and two things keep the claim honest rather than assumed: the corpus assertion below
// fails loudly if this matcher ever disagrees with reality on a file that DOES run, and the gate is
// mutation-proved to say NO (an orphan planted outside `src/**` reds it). What it cannot rule out is a
// matcher MORE lenient than vitest on some pattern not in use here — hence the reopen trigger.

interface Narrowing {
  readonly dir: string;
  readonly patterns: readonly string[];
}

function configFiles(root: string): string[] {
  return execSync('git ls-files "*vitest.config.ts"', { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
}

/** String literals of a `key: [...]` array, ignoring a match that sits inside a line comment. */
function arrayLiteral(src: string, key: string): string[] | null {
  for (const m of src.matchAll(new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`, "g"))) {
    const lineStart = src.lastIndexOf("\n", m.index) + 1;
    if (src.slice(lineStart, m.index).trimStart().startsWith("//")) continue;
    return [...m[1]!.matchAll(/["']([^"']+)["']/g)].map((x) => x[1]!);
  }
  return null;
}

/**
 * The configs that narrow the default, and by what.
 *
 * NOTE the comment-handling: a naive `/\*.*?\*\//s` comment stripper CORRUPTS THIS INPUT, because `/**​/` in
 * `src/**​/*.test.ts` is itself a valid block-comment token. A first cut did exactly that and reported
 * `src*.test.{ts,tsx}` — and, worse, reported `packages/map` as declaring NO include when it declares three.
 * The globs must be read from raw source (§"when a gate looks wrong, suspect the measurement").
 */
function narrowings(root: string): Narrowing[] {
  const out: Narrowing[] = [];
  for (const cfg of configFiles(root)) {
    const src = readFileSync(`${root}/${cfg}`, "utf8");
    const dir = cfg.slice(0, cfg.lastIndexOf("/"));
    // A custom `exclude` is a SECOND narrowing axis this gate does not model. None exists today; if one
    // appears, fail rather than quietly under-report (fail-closed is about the fallback VALUE).
    const exclude = arrayLiteral(src, "exclude");
    if (exclude !== null) {
      throw new Error(
        `${cfg} declares a custom \`exclude\` (${exclude.join(", ")}). This gate models \`include\` only, so it ` +
          "would now UNDER-report: a file matching include but hit by exclude is not run and would look collected. " +
          "Model exclude here before landing that config.",
      );
    }
    const include = arrayLiteral(src, "include");
    if (include === null) continue; // inherits vitest's default — cannot orphan
    if (include.length === 0) {
      throw new Error(`${cfg} declares an \`include\` this gate could not parse — it must not be read as "no narrowing"`);
    }
    out.push({ dir, patterns: include });
  }
  return out;
}

/** Tracked test files in a package, relative to that package. */
function trackedTests(root: string, dir: string): string[] {
  return execSync(`git ls-files "${dir}/**/*.test.ts" "${dir}/**/*.test.tsx"`, { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((f) => f.slice(dir.length + 1));
}

describe("REQ-118 §728: every tracked test file is collected by its package's vitest config", () => {
  const root = repoRoot();
  const narrowed = narrowings(root);

  it("finds the configs, and finds that some narrow (non-vacuity — an empty list must not read as clean)", () => {
    // Two distinct ways this gate could go silent: the config scan breaks (zero configs), or the include
    // parser breaks (zero narrowings, every package looking like it inherits the default). Both would make
    // every assertion below iterate nothing and PASS — the shape this repo has met in ten gates (§487…§607).
    expect(configFiles(root).length, "no vitest configs found — the scan is broken, not the tree").toBeGreaterThanOrEqual(10);
    expect(
      narrowed.length,
      "no config appears to narrow `include`. Either every package genuinely inherits the default — in which " +
        "case this gate has no subject and should be deleted — or the include parser broke and is reporting " +
        "DEFAULT for configs that narrow, which is how it fails silently",
    ).toBeGreaterThanOrEqual(4);
  });

  it.each(narrowings(repoRoot()))("$dir collects every test file it tracks", ({ dir, patterns }) => {
    const collected = new Set(patterns.flatMap((p) => globSync(p, { cwd: `${root}/${dir}` })).map((f) => f.split("\\").join("/")));
    const tracked = trackedTests(root, dir);
    expect(tracked.length, `${dir} narrows \`include\` but tracks no test files — check the corpus query, not the tree`).toBeGreaterThan(0);
    const orphans = tracked.filter((f) => !collected.has(f));
    expect(
      orphans,
      `a tracked test file is NOT collected by ${dir}'s vitest \`include\` (${patterns.join(", ")}). It is not ` +
        "failing and it is not skipped — it does not run, and no report shows its absence: a file asserting " +
        "`expect(1).toBe(2)` leaves the suite green (measured, §728). Widen the include, or move the file:\n  " +
        orphans.join("\n  "),
    ).toEqual([]);
  });
});
