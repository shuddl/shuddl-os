import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";
import { stripComments } from "./strip-comments.js";

// §1412 (REQ-118) — ONE COMMENT STRIPPER, AND NOTHING MAY RE-AUTHOR IT.
//
// §1411 cost 62% of the citation corpus because five gates each wrote their own strikethrough mask and one of
// them was wrong. The identical duplication existed here in a different notation: NINE hand-rolled
// `/\/\*[\s\S]*?\*\//g` strippers alongside this state machine, which is correct because it tracks string and
// template states. All nine corpora measured CLEAN at §1412 — nothing was actually blind — so this gate is
// prevention rather than repair, and the roster below is empty on purpose.

const NAIVE = String.raw`\/\*[\s\S]*?\*\/`;

/** Files allowed to contain the naive pattern, and why. Empty means the class has no live instances. */
const DECLARED: readonly { readonly file: string; readonly why: string }[] = [];

describe("§1412 REQ-118: the comment stripper is shared and string-aware", () => {
  const root = repoRoot();

  it("a /* inside a STRING opens nothing (the whole reason the state machine exists)", () => {
    // `app.use("/v1/*", auth)` and `globSync("{apps,workers}/*")` are real lines in this tree — 56 files carry
    // one. Under the naive regex each opens a swallow that runs to the next `*/` in the file.
    const src = 'app.use("/v1/*", auth);\nconst x = 1; /* a real comment */\nconst y = 2;';
    expect(stripComments(src)).toContain('app.use("/v1/*", auth)');
    expect(stripComments(src)).toContain("const y = 2");
    expect(stripComments(src)).not.toContain("a real comment");
  });

  it("strips line comments and block comments, and preserves offsets", () => {
    const src = "const a = 1; // note\n/* block\nspans */ const b = 2;";
    expect(stripComments(src)).not.toContain("note");
    expect(stripComments(src)).not.toContain("spans");
    expect(stripComments(src)).toContain("const b = 2");
    expect(stripComments(src)).toHaveLength(src.length);
    expect(stripComments(src).split("\n")).toHaveLength(src.split("\n").length);
  });

  it("a comment marker inside a template literal is not a comment", () => {
    const src = "const t = `a /* b */ c`;\nconst d = 1;";
    expect(stripComments(src)).toContain("a /* b */ c");
  });

  it("an escaped quote does not end the string early", () => {
    const src = 'const s = "he said \\" /* not a comment */";\nconst e = 2;';
    expect(stripComments(src)).toContain("/* not a comment */");
  });

  it("no file re-authors the naive stripper", () => {
    // The population comes from the tree, not from memory — §1376's rule, after six hand-counts came up short.
    // `strip-comments.ts` itself is excluded because its header QUOTES the pattern it replaces; that is the
    // irreducible mention-is-not-a-use case, and it is excluded by PATH rather than by a phrase so the
    // exclusion cannot quietly widen.
    const files = execSync("git ls-files packages workers tools apps", { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
      .filter((f) => f !== "tools/checks/strip-comments.ts" && f !== "tools/checks/strip-comments.test.ts");
    const offenders = files
      .filter((f) => readFileSync(`${root}/${f}`, "utf8").includes(NAIVE))
      .filter((f) => !DECLARED.some((d) => d.file === f));
    expect(
      offenders,
      "a file strips block comments with a regex instead of `stripComments`. `/*` inside a string is not a " +
        "comment opener, so that regex swallows from a path glob to the next `*/` — silently, and for the " +
        "residue checks it makes a forbidden reference DISAPPEAR rather than fail. Import the shared one:\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  it("the detector would notice one (positive control — a blind roster certifies everything)", () => {
    // §1370: an always-false detector makes the assertion above vacuous, which is this family's usual failure.
    expect(`const x = src.replace(/${NAIVE}/g, "");`.includes(NAIVE)).toBe(true);
  });
});
