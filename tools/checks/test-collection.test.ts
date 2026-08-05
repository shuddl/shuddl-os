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
