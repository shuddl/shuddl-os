import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";
import { scanSourceForForbiddenReplace } from "./invariants.js";
import { stripComments } from "./strip-comments.js";

// §1412 (REQ-118) — ONE COMMENT STRIPPER, AND NOTHING MAY RE-AUTHOR IT.
//
// §1411 cost 62% of the citation corpus because five gates each wrote their own strikethrough mask and one of
// them was wrong. The identical duplication existed here in a different notation: NINE hand-rolled
// `/\/\*[\s\S]*?\*\//g` strippers alongside this state machine, which tracks string and template states.
// All nine of THEIR corpora measured clean at §1412 — nothing was actually blind — so that consolidation was
// prevention rather than repair, and the roster below is empty on purpose.
//
// ~~which is correct because it tracks string and template states~~ — struck at §1414. It does not tokenise
// REGEX LITERALS, and a regex carrying an odd number of quote characters desynced it for the rest of the
// file. Two ordinary lines then hid an `INSERT OR REPLACE INTO events` from law #2's own enforcer. The
// mechanism a comment states is falsifiable, and this one lasted two phases.

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

  it("§1414: a regex literal with odd quotes cannot blind the append-only scanner", () => {
    // THE BYPASS, pinned end to end. Two ordinary lines — a regex carrying three `"` characters, then any
    // string containing a path glob — used to make `INSERT OR REPLACE INTO events` invisible to
    // check:invariants (exit 0 against a control's exit 1). Law #2's enforcer, defeated by a regex and a
    // glob. The composition is what broke, so the composition is what this asserts: strip, then scan.
    const src = [
      String.raw`export const RE = /evInput\(\s*"([^"]+)"\s*,\s*(\w+)\s*\)/g;`,
      'const g = "workers/*";',
      'export const sql = "INSERT OR REPLACE INTO events (id) VALUES (1)";',
    ].join("\n");
    const stripped = stripComments(src);
    expect(stripped, "the mis-read swallowed the statement — the state machine desynced again").toContain(
      "INSERT OR REPLACE INTO events",
    );
    expect(
      scanSourceForForbiddenReplace([{ path: "probe.ts", text: stripped }]),
      "law #2's scanner cannot see a REPLACE on `events` behind a regex literal and a path glob",
    ).not.toHaveLength(0);
  });

  it("§1414: a quoted string does not survive its line, but a template literal does", () => {
    // The fix and its deliberate exemption, side by side. `"` cannot span a newline in TS, so a state still
    // open at one is a mis-read; a template genuinely can, so it is left alone.
    expect(stripComments('const a = "unclosed\nconst b = 1; /* c */ const d = 2;')).toContain("const d = 2");
    expect(stripComments("const t = `line one\nline two`; // x")).toContain("line two");
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
