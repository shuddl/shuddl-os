import { existsSync, globSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

// EVERY TEST FILE IS ACTUALLY COLLECTED BY THE RUNNER THAT OWNS IT (audit §288).
//
// A test file matched by no `include` is not a failing test — it is a SILENT ABSENCE. The suite stays
// green, the file looks like coverage in review, and "279 tests pass" becomes a lie of omission. Nothing
// in this repo could observe it: `pnpm test` runs `test:tools` then `pnpm -r --if-present run test`, and
// both halves are happy to collect zero files.
//
// MEASURED CLEAN when this landed — all 279 tracked test files are collected. The point is DETECTABILITY,
// not today's count: several configs use NARROW includes (`src/**/*.test.{ts,tsx}` for the three surfaces,
// and `test/**/*.test.tsx` — tsx only — for packages/design), so a `.test.ts` added one directory over, or
// with the other extension, would run nowhere. That is the failure this pins.
//
// OWNERSHIP mirrors how the runner actually resolves, rather than a hand-listed map: the owner of a test
// file is the DEEPEST ancestor directory that either declares a vitest config or is a workspace package
// with a `test` script. A package with a config uses its `include`; a package without one gets vitest's
// defaults (which collect every `*.test.*`), and `tools/**` is owned by vitest.tools.config.ts at the root.

const ROOT = process.cwd();
const VITEST_DEFAULT_INCLUDE = ["**/*.{test,spec}.?(c|m)[jt]s?(x)"];

const IGNORED = ["**/node_modules/**", "**/dist/**", "**/.wrangler/**"];
const isVendored = (p: string): boolean => p.includes("node_modules") || p.includes(`${sep}dist${sep}`) || p.includes(".wrangler");

/** Every tracked-shaped test file in the repo, excluding vendored trees and the separate site workstreams. */
function allTestFiles(): string[] {
  return globSync("**/*.test.{ts,tsx}", { cwd: ROOT, exclude: IGNORED })
    .filter((p) => !isVendored(p))
    .filter((p) => !p.startsWith("shuddl-site") && !p.startsWith("marketing-site"))
    .sort();
}

/** The `include` array a config declares, or vitest's defaults when it declares none. */
function includesOf(configPath: string): string[] {
  const text = readFileSync(configPath, "utf8");
  const m = /include\s*:\s*\[([^\]]*)\]/.exec(text);
  if (!m) return VITEST_DEFAULT_INCLUDE;
  const items = [...(m[1] ?? "").matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1] as string);
  return items.length > 0 ? items : VITEST_DEFAULT_INCLUDE;
}

/** A directory is a test RUNNER root if it declares a vitest config, or is a package with a `test` script. */
function runnerRoots(): Map<string, string[]> {
  const roots = new Map<string, string[]>();
  for (const cfg of globSync("**/vitest*.config.ts", { cwd: ROOT, exclude: IGNORED })) {
    if (isVendored(cfg)) continue;
    roots.set(dirname(cfg) === "." ? "" : dirname(cfg), includesOf(join(ROOT, cfg)));
  }
  for (const pj of globSync("*/*/package.json", { cwd: ROOT, exclude: IGNORED })) {
    if (isVendored(pj)) continue;
    const dir = dirname(pj);
    if (roots.has(dir)) continue;
    const pkg = JSON.parse(readFileSync(join(ROOT, pj), "utf8")) as { scripts?: Record<string, string> };
    if (pkg.scripts?.["test"]) roots.set(dir, VITEST_DEFAULT_INCLUDE);
  }
  return roots;
}

/** The deepest runner root that contains this file — the runner that will actually try to collect it. */
function ownerOf(file: string, roots: Map<string, string[]>): string | undefined {
  let best: string | undefined;
  for (const root of roots.keys()) {
    if (root === "" || file === root || file.startsWith(`${root}/`)) {
      if (best === undefined || root.length > best.length) best = root;
    }
  }
  return best;
}

describe("REQ-118/119: no test file is silently uncollected", () => {
  const roots = runnerRoots();
  const files = allTestFiles();

  it("discovers runner roots and test files at all (non-vacuity)", () => {
    // Without this, a wrong cwd or a broken glob makes every assertion below pass on an empty set —
    // the exact shape this gate exists to reject.
    expect(roots.size, "no vitest runner roots discovered").toBeGreaterThan(5);
    expect(files.length, "no test files discovered").toBeGreaterThan(100);
    expect(existsSync(join(ROOT, "vitest.tools.config.ts")), "run from the repo root").toBe(true);
  });

  it("§709: every package holding test files declares a `test` script (--if-present skips the rest)", () => {
    // `pnpm test` is `test:tools && pnpm -r --if-present run test`. **--if-present means a package with no
    // `test` script is silently skipped** — no error, no count, nothing to notice.
    //
    // The assertion below catches that for a package whose runner-root status comes from BEING a workspace
    // package: drop the script and its files fall through to <root>, whose includes do not match (§708, M227
    // on packages/rater). But a package with its OWN vitest.config.ts stays a runner root, its includes keep
    // matching, and the file is still "collected" — while `pnpm test` no longer runs it.
    //
    // MEASURED (§709, M228): deleting `packages/map`'s test script left this gate, gate-wiring AND
    // ci-contract all green. ELEVEN packages ship their own config — workers/api (69 test files),
    // packages/ledger (34), the three surfaces — so **208 test files are one edit each from leaving the
    // largest gate in the merge profile**, silently.
    const withTests = new Map<string, number>();
    for (const pj of globSync("*/*/package.json", { cwd: ROOT, exclude: IGNORED })) {
      const dir = pj.slice(0, pj.lastIndexOf("/"));
      const n = globSync(`${dir}/**/*.test.{ts,tsx}`, { cwd: ROOT, exclude: IGNORED }).length;
      if (n > 0) withTests.set(pj, n);
    }
    expect(withTests.size, "no workspace package with test files found — the scan broke, the repo did not").toBeGreaterThan(8);
    const silent = [...withTests.entries()]
      .filter(([pj]) => {
        const pkg = JSON.parse(readFileSync(join(ROOT, pj), "utf8")) as { scripts?: Record<string, string> };
        return pkg.scripts?.["test"] === undefined;
      })
      .map(([pj, n]) => `${pj} — ${n} test file(s) that \`pnpm test\` would skip`);
    expect(
      silent,
      "a workspace package holds test files but declares no `test` script. `pnpm -r --if-present run test` " +
        "skips it in SILENCE — the tests do not run, nothing reports a count, and if the package owns a " +
        "vitest config the collection assertion above still passes because the files remain 'collected':\n  " +
        silent.join("\n  "),
    ).toEqual([]);
  });

  it("every test file matches an include of the runner that owns it", () => {
    const collectedBy = new Map<string, Set<string>>();
    for (const [root, includes] of roots) {
      const cwd = root === "" ? ROOT : join(ROOT, root);
      const set = new Set<string>();
      for (const pattern of includes) {
        for (const hit of globSync(pattern, { cwd, exclude: IGNORED })) {
          set.add(root === "" ? hit : `${root}/${relative(".", hit)}`);
        }
      }
      collectedBy.set(root, set);
    }

    const uncollected: string[] = [];
    for (const f of files) {
      const owner = ownerOf(f, roots);
      if (owner === undefined) {
        uncollected.push(`${f} — no runner root owns this path`);
        continue;
      }
      if (!collectedBy.get(owner)?.has(f)) {
        uncollected.push(`${f} — owned by ${owner === "" ? "<root>" : owner}, matched by none of its include patterns`);
      }
    }
    expect(uncollected, `test file(s) that no runner collects:\n${uncollected.join("\n")}`).toEqual([]);
  });
});
