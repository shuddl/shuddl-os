import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §1426 (REQ-118) — A GATE'S PATHSPEC MUST MATCH SOMETHING.
//
// WHY THIS EXISTS. Twice in one block (§1419, §1425) an ad-hoc probe used `packages/*/src` as a git pathspec
// and got ZERO results — because a pathspec naming a directory through a glob does not expand to its
// contents. Both times the zero read as a finding about the codebase (*"no INSERT INTO anywhere"*, *"no
// invariant is implemented"*) until a positive control exposed it. At the second instance the rule is to stop
// fixing and start counting, so §1426 evaluated every glob pathspec in `tools/`.
//
// THE ANSWER WAS A CLEAN NEGATIVE: the gates use the file-terminated form (`workers/*/src/*.ts` → 99 files,
// `workers/*/src/**/*.ts` → 48) and not one of them uses the directory-only shape that bit me. The defect was
// in my probes, not in the tree.
//
// WHAT THIS GATE IS AND IS NOT, measured at §1436 rather than assumed. Four gates had their globs broken one
// at a time; ALL FOUR red on their own — `named-resources` (3 cases), `idb-durability`, `mcp-api-seam` and
// `event-payload-strictness` (1 each) — because the repo's non-vacuity convention (§487/§490, "a scan that
// reads nothing reports clean") is already near-universal, and the `scanCorpus` callers additionally throw
// `EmptyGlobError`. So this gate is NOT the sole watcher for any pathspec in the tree today, and the earlier
// claim that raw `git ls-files` callers "had no such protection" was too strong.
//
// It earns its place as STRUCTURAL rather than conventional protection: a new gate written without its own
// floor is covered the day it lands, instead of depending on its author remembering §487. Defence in depth,
// stated as defence in depth.
//
// SCOPE. Only pathspecs written as literals can be evaluated here; a spec built from a template
// (`${ROUTES_DIR}/*.ts`) is invisible to a static scan and is skipped rather than guessed at — those are
// exactly the entries a naive version of this sweep reported as broken. The skip is counted and floored so it
// cannot quietly swallow the whole population.

const DECLARED_EMPTY: readonly { readonly spec: string; readonly why: string }[] = [
  {
    spec: "workers/**/*.tsx",
    why:
      "workers carry no JSX — this is the workers half of a PAIRED spec whose packages half matches 14 files, " +
      "so the union is non-empty and the pair is what the gate reads. Deleting the empty half would make the " +
      "gate silently workers-blind the day a worker gains a .tsx.",
  },
  {
    spec: "*.cjs",
    why:
      "no .cjs file exists today. Part of the deliberately broad text-extension list §1415 gave section-refs " +
      "so a §N pointer in ANY comment-bearing format is resolved; an extension with no subjects is inert, and " +
      "removing it would re-narrow the corpus that §1415 widened to catch a dangling reference.",
  },
  {
    spec: "*.sh",
    why:
      "no .sh file is tracked today. Same §1415 list and the same reasoning as *.cjs: the cost of listing an " +
      "absent extension is zero, and the cost of omitting one is a §N reference nothing resolves.",
  },
];

function literalPathspecs(root: string): { file: string; line: number; spec: string }[] {
  // This file is excluded BY PATH: its positive control below deliberately passes git the broken
  // directory-only spec, and a scanner that reads its own control reports it as a defect. §1416's
  // `PRAGMA writable_schema` message flagged itself for the same reason. By path, never by phrase, so the
  // exclusion is one named file rather than a rule that could quietly widen (§1412).
  const SELF = "tools/checks/pathspec-nonempty.test.ts";
  const files = execSync("git ls-files tools", { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".ts") && f !== SELF);
  const out: { file: string; line: number; spec: string }[] = [];
  for (const file of files) {
    const lines = readFileSync(`${root}/${file}`, "utf8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] as string;
      if (!line.includes("git ls-files") && !line.includes("git grep")) continue;
      if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
      for (const m of line.matchAll(/["']([^"'\s]*\*[^"'\s]*)["']/g)) {
        const spec = m[1] as string;
        if (spec.includes("${")) continue; // template-built: not statically evaluable
        out.push({ file, line: i + 1, spec });
      }
    }
  }
  return out;
}

describe("§1426 REQ-118: every literal pathspec a gate passes to git matches at least one file", () => {
  const root = repoRoot();
  const specs = literalPathspecs(root);

  it("derives a real population (non-vacuity — an empty sweep certifies everything)", () => {
    // §1437 — the message named the wrong QUANTITY. `specs` is OCCURRENCES (one entry per match per line);
    // the "38" written here at §1426 was the UNIQUE spec count. A floor whose message compares a different
    // kind of number sends the next reader to the wrong place. Both are stated now, and both are floored, so
    // a collapse in either is loud: 64 occurrences / 36 unique when this was written.
    expect(specs.length, "no literal pathspec OCCURRENCES found — the extractor broke; there were 64 at §1437").toBeGreaterThanOrEqual(40);
    expect(new Set(specs.map((s) => s.spec)).size, "unique pathspec count collapsed; there were 36 at §1437").toBeGreaterThanOrEqual(25);
  });

  it("no pathspec silently matches nothing", () => {
    const empty = [...new Set(specs.map((s) => s.spec))]
      .filter((spec) => execSync(`git ls-files -- '${spec}'`, { cwd: root, encoding: "utf8" }).trim() === "")
      .filter((spec) => !DECLARED_EMPTY.some((d) => d.spec === spec));
    expect(
      empty,
      "a gate passes git a pathspec that matches NO tracked file, so whatever it checks it checks over an " +
        "empty corpus and reports clean. The usual cause is a pathspec naming a DIRECTORY through a glob " +
        "(`packages/*/src`), which does not expand to its contents — use the file-terminated form " +
        "(`packages/*/src/**/*.ts`). If the emptiness is intentional, declare it above with why:\n  " +
        empty.join("\n  "),
    ).toEqual([]);
  });

  it("the directory-only shape that caused this gate is still empty (positive control)", () => {
    // The exact spec that returned zero at §1419 and §1425. If git ever starts expanding it, the rule above
    // is checking for a hazard that no longer exists and this control says so.
    expect(execSync("git ls-files -- 'packages/*/src'", { cwd: root, encoding: "utf8" }).trim()).toBe("");
    // Both halves of the file-terminated form, because §1370's gate requires an `A/**/*.ext` spec to be
    // PAIRED with `A/*.ext` — node:fs lets `**` match zero directories while git's pathspec does not, so the
    // unpaired form drops every top-level file. This control tripped that gate on its first run, which is two
    // of these gates checking each other and is the reason both exist.
    expect(
      execSync("git ls-files -- 'packages/*/src/*.ts' 'packages/*/src/**/*.ts'", { cwd: root, encoding: "utf8" }).trim().length,
    ).toBeGreaterThan(0);
  });

  it("every DECLARED empty spec is still empty and still used (no exemption outlives its subject)", () => {
    for (const d of DECLARED_EMPTY) {
      expect(
        execSync(`git ls-files -- '${d.spec}'`, { cwd: root, encoding: "utf8" }).trim(),
        `${d.spec} now matches files — delete the exemption, the gate can enforce it directly`,
      ).toBe("");
      expect(specs.some((s) => s.spec === d.spec), `${d.spec} is no longer used by any gate — delete the row`).toBe(true);
      expect(d.why.length, `${d.spec}'s reason is too short to be a reason`).toBeGreaterThan(80);
    }
  });
});
