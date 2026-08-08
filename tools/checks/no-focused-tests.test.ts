import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";
import { stripComments } from "./source-corpus.js";

// REQ-118 §711 — ONE CHARACTER CAN DISABLE A FILE'S ENTIRE SUITE, SILENTLY.
//
// `it.only` does not fail anything. It makes vitest run THAT test and quietly skip every other test in its
// file — the run still exits 0, the gate still reports PASS, and the count drops without a word. `it.skip`
// and `it.todo` are the same shape with a different mechanism: a guarantee stops being checked and nothing
// says so.
//
// MEASURED: 313 tracked test files, ZERO occurrences of `.only`, `.skip`, `.todo` or `.fails`. This repo is
// clean today and nothing keeps it clean — there is no vitest/jest ESLint plugin configured and no gate
// asserting it (checked both). That combination is exactly §671's shape: a state nobody is defending.
//
// It matters here more than in most repos. This audit has spent dozens of phases proving individual
// assertions can fail — the append-only triggers, the tenant-isolation roster, the penny-parity comparator.
// Every one of those lives in a file that a single `.only` elsewhere in it would silence, and the merge gate
// would stay green because a skipped test is not a failing test.
//
// STRICT, with no allowlist. A focused test is a debugging aid that should never survive a commit, and a
// skipped one is a decision that belongs in the register or in a deletion — not in a marker that reads as
// coverage. If a genuine need appears, add the exemption WITH its reason, the way every other allowlist in
// this repo carries one (§636/§666/§672/§694).

const MARKERS = ["only", "skip", "todo", "fails"] as const;
const FOCUSED = /\b(?:it|test|describe)\.(only|skip|todo|fails)\b/g;

function testFiles(root: string): string[] {
  return execSync('git ls-files "*.test.ts" "*.test.tsx"', { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

describe("REQ-118 §711: no test is focused or skipped", () => {
  const root = repoRoot();
  const files = testFiles(root);

  it("finds the test corpus at all (non-vacuity — an empty scan must not read as clean)", () => {
    // Without this, a renamed suffix or a moved tree makes the assertion below pass over zero files, which
    // is the failure mode this repo has met in ten gates (§487…§607).
    expect(files.length, "no test files found — the scan is broken, not the tree").toBeGreaterThan(250);
  });

  it.each(MARKERS)("no `.%s` marker survives in a committed test", (marker) => {
    const found: string[] = [];
    for (const f of files) {
      // Comment-stripped: this file and the audit both DISCUSS `.only` in prose, and a gate that cannot tell
      // code from commentary cries wolf (§674). stripComments is correct here — these are .ts/.tsx (§674's
      // pinned boundary), never CSS.
      const src = stripComments(readFileSync(`${root}/${f}`, "utf8"));
      FOCUSED.lastIndex = 0;
      for (const m of src.matchAll(FOCUSED)) {
        if (m[1] === marker) found.push(`${f}:${src.slice(0, m.index).split("\n").length}`);
      }
    }
    expect(
      found,
      `\`.${marker}\` in a committed test. ${
        marker === "only"
          ? "vitest runs ONLY that test and skips every other one in the file — the run exits 0, the gate " +
            "reports PASS, and the count drops silently."
          : "the guarantee it holds stops being checked, and a skipped test is not a failing test, so every " +
            "gate stays green."
      } Remove it, or delete the test and say why:\n  ${found.join("\n  ")}`,
    ).toEqual([]);
  });
});
