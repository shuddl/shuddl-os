import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §1370 (REQ-118) — NO `git ls-files` GLOB SILENTLY DROPS THE TOP LEVEL OF ITS OWN TREE.
//
// §1369's defect, made unrepeatable. `git ls-files` takes PATHSPECS, not globs, and its `*` crosses `/`. So a
// pattern of the form `A/**/*.ts` requires at least one real directory between `A` and the file, and every file
// sitting DIRECTLY under `A` is invisible. Under `node:fs globSync` — which reads the same rosters elsewhere in
// this repo — `**` matches zero directories and those files ARE included.
//
// Measured at §1369: the shared `SOURCE_SCAN_GLOBS` resolved to 335 files under globSync and 185 under
// git ls-files. The 150 missing included `workers/api/src/intake-core.ts` (an append surface),
// `packages/ledger/src/anchor.ts` and `workers/agents/src/index.ts` — and the git side is what
// `append-chokepoint` reads.
//
// WHY A GATE RATHER THAN A THIRD SWEEP. I have now enumerated these call sites by hand twice. The sites that are
// safe today are mostly safe by ACCIDENT: `packages/**/*.ts` misses nothing only because no `.ts` file currently
// sits directly in `packages/`. The day someone adds `packages/index.ts` it becomes invisible, with no failure
// anywhere — the §1368 shape, where a latent drift's real cost is the wrong record someone writes later.
//
// THE RULE. For every `A/**/*.EXT` pathspec passed to `git ls-files` in this repo's tooling, either
//   (a) the same call also passes `A/*.EXT` — the pairing that makes the two engines agree, or
//   (b) `A` has no direct children matching `*.EXT`, so there is nothing to miss (recorded, not assumed —
//       this is re-measured on every run, so it stops being an excuse the moment a file lands there).

interface Site {
  readonly file: string;
  readonly line: number;
  readonly globs: readonly string[];
}

/** Every `git ls-files …` invocation in the tooling, with the quoted pathspecs it passes. */
function gitLsFilesSites(root: string): Site[] {
  const files = execSync("git ls-files tools", { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".ts"));
  const out: Site[] = [];
  for (const file of files) {
    const lines = readFileSync(`${root}/${file}`, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.includes("git ls-files")) continue;
      if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
      // Pathspecs are string literals on the line; template holes (${…}) are skipped as undecidable statically.
      const globs = [...line.matchAll(/["'`]([A-Za-z0-9_*./-]+)["'`]/g)].map((m) => m[1]!).filter((g) => g.includes("*"));
      if (globs.length > 0) out.push({ file, line: i + 1, globs });
    }
  }
  return out;
}

/** Files directly under `A` matching `*.EXT` that `A/**‌/*.EXT` cannot see. */
function droppedTopLevel(root: string, glob: string): string[] {
  const m = /^(.*?)\/\*\*\/(\*\.[A-Za-z0-9.]+)$/.exec(glob);
  if (!m) return [];
  const [, base, tail] = m;
  const ls = (spec: string): string[] =>
    execSync(`git ls-files ${JSON.stringify(spec)}`, { cwd: root, encoding: "utf8" }).split("\n").filter((f) => f !== "");
  const wide = new Set(ls(`${base}/${tail}`)); // `*` crosses `/` under git, so this is the SUPERSET
  for (const f of ls(glob)) wide.delete(f);
  // Keep only files DIRECTLY under a base that has no further directory — the ones the `**` form drops.
  const depth = (base!.match(/\//g) ?? []).length;
  return [...wide].filter((f) => (f.match(/\//g) ?? []).length === depth + 1);
}

describe("§1370 REQ-118: no git ls-files glob drops the top level of its tree", () => {
  const root = repoRoot();
  const sites = gitLsFilesSites(root);

  it("finds the call sites (non-vacuity — an empty scan certifies nothing)", () => {
    // The corpus floor bounds what was READ, not what was found (§1148 — the lesson §1369 was an instance of).
    expect(sites.length, "no `git ls-files` glob sites found — the scanner broke, not the tooling").toBeGreaterThanOrEqual(20);
    expect(
      sites.some((s) => s.globs.some((g) => g.includes("/**/"))),
      "no `A/**/*.ext` pathspec found at all — the pattern this gate exists for has changed shape",
    ).toBe(true);
  });

  it("every `A/**/*.ext` pathspec is either paired with `A/*.ext` or has nothing to drop", () => {
    const holes: string[] = [];
    for (const site of sites) {
      for (const glob of site.globs) {
        const m = /^(.*?)\/\*\*\/(\*\.[A-Za-z0-9.]+)$/.exec(glob);
        if (!m) continue;
        const paired = `${m[1]!}/${m[2]!}`;
        if (site.globs.includes(paired)) continue; // (a) explicitly paired
        const dropped = droppedTopLevel(root, glob);
        if (dropped.length === 0) continue; // (b) nothing to miss — re-measured, not assumed
        holes.push(`${site.file}:${site.line} — "${glob}" cannot see ${dropped.length} file(s) directly under ${m[1]!}/, e.g. ${dropped[0]!}`);
      }
    }
    expect(
      holes,
      "a `git ls-files` pathspec of the form `A/**/*.ext` is hiding files that sit DIRECTLY under `A`. Git " +
        "pathspecs are not globs: `*` crosses `/`, so `A/**/` demands a real directory. Whatever this gate " +
        "scans, it is not scanning those files, and its own non-vacuity floor cannot tell — a floor bounds the " +
        "corpus you HAVE. Add the paired `A/*.ext` pathspec (redundant under node:fs globSync, load-bearing " +
        "here):\n  " +
        holes.join("\n  "),
    ).toEqual([]);
  });

  it("the detector actually detects — a known-bad pathspec is caught (positive control)", () => {
    // Without this, a `droppedTopLevel` that always returned [] would make the case above vacuous, which is the
    // precise failure mode §1369 was: a scan that quietly saw less than it claimed.
    const dropped = droppedTopLevel(root, "workers/mcp/src/**/*.ts");
    expect(dropped.length, "the known top-level files under workers/mcp/src are no longer detected as dropped").toBeGreaterThan(0);
    expect(dropped.every((f) => /^workers\/mcp\/src\/[^/]+\.ts$/.test(f))).toBe(true);
  });
});
