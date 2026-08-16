import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §1649 (REQ-118/119) — EVERY TEST FILE IS INSIDE ITS PACKAGE'S `include`.
//
// `§709` floors the level above this one: every package holding test files declares a `test` script, because
// `pnpm -r --if-present` SILENTLY SKIPS a package without one. This is the same hazard one level down. Five
// packages narrow vitest's default include to a directory:
//
//   apps/command · apps/driver · apps/portal   →  src/**/*.test.{ts,tsx}
//   packages/design                            →  test/**/*.test.{ts,tsx}
//   packages/map                               →  test/**, perf/**
//
// A `include` is a SELECTOR sitting between the files on disk and the files that run. A test written one
// directory outside it is not a failure and not a skip — it is silence, and the suite stays green because the
// assertions never execute. Nothing compares the two sides.
//
// MEASURED at §1649, by running all 17 suites and counting: **277 tracked test files, 277 collected** — every
// package agrees with its disk today, and **0** files define `describe`+`it` outside the `*.test.*` naming
// convention. This gate freezes that agreement for the five packages where a pattern can silently exclude one.
//
// SCOPE: the six packages using vitest's DEFAULT include, and the six with no config at all, are not checked —
// their pattern is `**/*.{test,spec}.…`, which no tracked test file can sit outside. Narrowing one of those
// configs LATER is exactly what this gate is here to catch: add the package to NARROWED below in the same PR.

/** The five packages whose config narrows the include, and the directory prefixes that config admits. */
const NARROWED: ReadonlyArray<{ dir: string; allowed: readonly string[] }> = [
  { dir: "apps/command", allowed: ["src/"] },
  { dir: "apps/driver", allowed: ["src/"] },
  { dir: "apps/portal", allowed: ["src/"] },
  { dir: "packages/design", allowed: ["test/"] },
  { dir: "packages/map", allowed: ["test/", "perf/"] },
];

/** PURE: the tracked test files that sit outside every allowed prefix. Separate so a synthetic corpus proves it. */
export function outsideInclude(files: readonly string[], dir: string, allowed: readonly string[]): string[] {
  return files.filter((f) => {
    const rel = f.slice(dir.length + 1);
    return !allowed.some((a) => rel.startsWith(a));
  });
}

function trackedTests(root: string, dir: string): string[] {
  return execSync(`git ls-files "${dir}/**/*.test.ts" "${dir}/**/*.test.tsx"`, { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => f.length > 0);
}

describe("§1649 REQ-118: no test file sits outside its package's vitest include", () => {
  const root = repoRoot();

  it("the narrowed list still describes the tree (each config exists and still narrows)", () => {
    // If a config stops narrowing, this row is stale and the gate is checking a constraint nobody has — the
    // §174 failure mode. If it starts narrowing somewhere new, the scope note above says to add it here.
    for (const { dir } of NARROWED) {
      const cfg = `${root}/${dir}/vitest.config.ts`;
      expect(existsSync(cfg), `${dir}: config gone — remove it from NARROWED or repoint this gate`).toBe(true);
      expect(readFileSync(cfg, "utf8"), `${dir}: no longer narrows its include — this row is now vacuous`).toContain("include:");
    }
  });

  it("the detector flags a file outside the pattern and clears one inside (positive control)", () => {
    const files = ["apps/command/src/views/a.test.ts", "apps/command/test/b.test.ts"];
    expect(outsideInclude(files, "apps/command", ["src/"])).toEqual(["apps/command/test/b.test.ts"]);
    expect(outsideInclude(["packages/map/perf/x.test.ts"], "packages/map", ["test/", "perf/"])).toEqual([]);
  });

  it("reads a real corpus (non-vacuity — an empty scan is inside every pattern)", () => {
    // LIVE COUNT at §1649: command 17 · driver 15 · portal 15 · design 2 · map 10 = 59.
    const total = NARROWED.reduce((n, { dir }) => n + trackedTests(root, dir).length, 0);
    expect(total, "almost no test files parsed — the glob broke, not the tree").toBeGreaterThanOrEqual(50);
  });

  it("every tracked test file is inside its package's include", () => {
    const stranded = NARROWED.flatMap(({ dir, allowed }) => outsideInclude(trackedTests(root, dir), dir, allowed));
    expect(
      stranded,
      "these test files are NOT matched by their package's vitest `include`, so they never run — the suite " +
        "stays green because their assertions never execute. Move the file under an allowed directory, or " +
        "widen the config's `include` and update NARROWED in the same commit:\n  " + stranded.join("\n  "),
    ).toEqual([]);
  });
});
