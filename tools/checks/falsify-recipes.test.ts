import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §1473 (REQ-118) — A `FALSIFY` RECIPE MUST NAME A TEST CASE THAT EXISTS.
//
// §1472 found that the comments which survive scrutiny are the FALSIFIABLE ones, and this repo has a convention
// for exactly that: `FALSIFY (§N): <mutation> → <suite> reds "<case name>"`. §1473 re-ran all four and **all four
// were still true** — against the record's own finding that 3 of 4 forward-looking reopen triggers were WRONG.
// The structural difference is that a recipe is an EXPERIMENT anyone can run, naming the exact case that must
// fail, while a reopen trigger is a prediction nobody can execute.
//
// So the convention is worth keeping honest. What rots is not the mutation (still expressible) but the NAME: a
// test gets reworded and the recipe now points at nothing, so the next reader runs the mutation, sees an
// unfamiliar failure or none at all, and cannot tell whether the guard is gone or the sentence is stale.
//
// WHY THIS GATE AND NOT §1472'S. That phase DECLINED to gate mutual lockstep pairs because their population is
// derived from PROSE and §1399's rule is that an English boundary can never close. This gate's population is a
// fixed MARKER token — `FALSIFY` — which authors write deliberately, and its check is string equality against
// the test corpus. Marker-scoped and mechanically decidable, which is the distinction that makes one gateable
// and the other not.
//
// WHAT IT CANNOT DO, stated: it does not run the mutation, so it cannot prove the recipe still REDS — only that
// its named subject still exists. §1473 ran all four by hand; that is a phase's work, not a gate's.

/** The whole comment block a recipe lives in — a recipe routinely wraps across several `//` lines. */
function unwrapCommentBlock(src: string, from: number): string {
  const out: string[] = [];
  for (const line of src.slice(from).split("\n")) {
    const s = line.trim();
    if (!s.startsWith("//") && !s.startsWith("*")) break;
    out.push(s.replace(/^(\/\/+|\*)\s?/, ""));
  }
  return out.join(" ");
}

interface Recipe {
  readonly file: string;
  readonly line: number;
  readonly cases: string[];
}

function recipes(root: string): Recipe[] {
  const files = execSync(
    "git ls-files -- 'workers/*/src/*.ts' 'workers/*/src/*.tsx' 'workers/*/src/**/*.ts' 'workers/*/src/**/*.tsx' 'packages/*/src/*.ts' 'packages/*/src/*.tsx' 'packages/*/src/**/*.ts' 'packages/*/src/**/*.tsx' 'apps/*/src/*.ts' 'apps/*/src/*.tsx' 'apps/*/src/**/*.ts' 'apps/*/src/**/*.tsx'",
    { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  )
    .split("\n")
    .filter((f) => f !== "" && !f.endsWith(".test.ts") && !f.includes("/test/"));
  const out: Recipe[] = [];
  for (const file of files) {
    const src = readFileSync(`${root}/${file}`, "utf8");
    for (const m of src.matchAll(/FALSIFY/g)) {
      const lineStart = src.lastIndexOf("\n", m.index) + 1;
      const block = unwrapCommentBlock(src, lineStart);
      out.push({
        file,
        line: src.slice(0, m.index).split("\n").length,
        cases: [...block.matchAll(/reds\s+"([^"]{8,})"/g)].map((c) => c[1] as string),
      });
    }
  }
  return out;
}

function testCorpus(root: string): string {
  const files = execSync("git ls-files -- '*.test.ts' '*.test.tsx'", { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
    .split("\n")
    .filter((f) => f !== "");
  return files.map((f) => readFileSync(`${root}/${f}`, "utf8")).join("\n");
}

describe("§1473 REQ-118: every FALSIFY recipe names a test case that still exists", () => {
  const root = repoRoot();
  const found = recipes(root);
  const corpus = testCorpus(root);

  it("derives a real population (non-vacuity — an empty scan certifies every recipe)", () => {
    // LIVE, MEASURED at §1473: 4 recipes, in parse.ts, entitlements.ts, invoice-gate.ts and transition-gates.ts.
    // Floor 2, below the live count because a recipe legitimately comes and goes with the guard it documents.
    expect(found.length, "no FALSIFY recipe found — the marker or the corpus glob broke, not the convention").toBeGreaterThanOrEqual(2);
    expect(corpus.length, "the test corpus read as empty — every name would then look missing").toBeGreaterThan(100_000);
  });

  it("each recipe names at least one expected failing case", () => {
    // A recipe that says what to break but not what should fail leaves the reader unable to tell a working
    // guard from a stale sentence — they run the mutation and have nothing to compare the result against.
    const silent = found.filter((r) => r.cases.length === 0).map((r) => `${r.file}:${r.line}`);
    expect(
      silent,
      'a FALSIFY recipe does not name the case it expects to red. Write it as: FALSIFY (§N): <mutation> → ' +
        '`<suite>` reds "<exact case name>" — the quoted name is what makes the experiment checkable by someone ' +
        "who was not there:\n  " + silent.join("\n  "),
    ).toEqual([]);
  });

  it("every named case is live in the test corpus", () => {
    const dangling = found.flatMap((r) => r.cases.filter((c) => !corpus.includes(c)).map((c) => `${r.file}:${r.line} → "${c}"`));
    expect(
      dangling,
      "a FALSIFY recipe names a test case that no longer exists — the guard may be fine and the sentence stale, " +
        "or the case may be gone with the guard now unpinned, and the recipe can no longer tell you which. " +
        "Re-run the mutation, then either repoint the name or restore the case:\n  " + dangling.join("\n  "),
    ).toEqual([]);
  });

  it("the unwrapper joins a WRAPPED recipe (positive control — this is how both probe artifacts happened)", () => {
    // §1473 measured this the hard way: a single-line extractor reported 2 of 4 recipes as naming no case,
    // because their quoted name wrapped onto the next `//` line. Both were probe artifacts, and a gate shipped
    // on that extractor would have failed two correct recipes on its first run.
    const wrapped = ['// FALSIFY (§1): flip the guard → `pkg test/x.test.ts` reds', '// "the exact case name here"', "const x = 1;"].join("\n");
    const block = unwrapCommentBlock(wrapped, 0);
    expect(block, "the unwrapper stopped at the line break — wrapped recipes would read as naming nothing").toContain('reds "the exact case name here"');
    expect([...block.matchAll(/reds\s+"([^"]{8,})"/g)].map((m) => m[1])).toEqual(["the exact case name here"]);
    // …and it must STOP at the first non-comment line, or it would swallow code and match quoted strings in it.
    expect(block, "the unwrapper ran past the comment block into code").not.toContain("const x");
  });
});
