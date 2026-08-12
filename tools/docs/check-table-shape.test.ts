import { describe, expect, it } from "vitest";
import {
  cellCount,
  findOverWideRows,
  isDivider,
  listMarkdownFiles,
  repoRoot,
  scanTables,
  vacuityViolation,
} from "./check-table-shape.js";

// REQ-118 (audit §50, §484). The doc-integrity gate that stops the RECORD from overstating safety — a
// table row wider than its header renders with the extra cells DROPPED, which once deleted three
// residual-risk statements and a whole mitigation row from the threat model.
//
// It shipped as a main()-only `.mjs` with ZERO exports, so nothing could import it and nothing did. §484
// measured what that permitted: run from `tools/checks/`, it printed *"OK (0 markdown files, every table
// row matches its header)"* and exited 0, because `git ls-files '*.md'` is CWD-RELATIVE. The gate whose
// job is the record's honesty certified the record having read nothing.
//
// These pin both halves of the fix — the ROOTING that removes the cause, and the FLOOR that catches any
// other way the input could empty out.

describe("REQ-118: the table-shape gate cannot certify a record it did not read", () => {
  it("the real tree is clean", () => {
    const { files, problems } = scanTables();
    expect(problems).toEqual([]);
    expect(files, "and it actually read something — the assertion above is vacuous otherwise").toBeGreaterThan(50);
  });

  // THE REGRESSION, PINNED AT ITS CAUSE. Not "the count is > 0" (that is the symptom) but "the file list
  // does not depend on where you stand", which is the property whose absence produced the 0-file OK.
  it("the scan is rooted at the repo, not the caller's directory", () => {
    const fromRoot = listMarkdownFiles(repoRoot());
    const fromSubdir = listMarkdownFiles(`${repoRoot()}/tools/checks`);
    expect(fromSubdir, "cwd must not narrow the scan — this is the §484 defect").toEqual(fromRoot);
    expect(fromRoot.length).toBeGreaterThan(50);
  });

  it("an empty scan is a FAILURE, and says which command should have produced input (§445)", () => {
    const v = vacuityViolation(0, "/some/root");
    expect(v).not.toBeNull();
    expect(v).toContain("git ls-files");
    expect(v, "state the COMMAND, not the criteria").toContain("/some/root");
    // And the inverse: a non-empty scan must NOT be flagged, or the gate fails permanently.
    expect(vacuityViolation(1, "/some/root")).toBeNull();
  });
});

describe("REQ-118: the parser flags exactly what markdown drops", () => {
  const TBL = (rows: string) => `| a | b |\n| --- | --- |\n${rows}`;

  it("flags an OVER-wide row and names the count that renders as nothing", () => {
    const p = findOverWideRows("d.md", TBL("| 1 | 2 | 3 |\n"));
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("row has 3 cells");
    expect(p[0]).toContain("DROPS the extra 1");
  });

  it("does NOT flag an under-wide row — markdown pads those and nothing is lost", () => {
    expect(findOverWideRows("d.md", TBL("| 1 |\n"))).toEqual([]);
  });

  // §1206 — CORRECTED. This asserted that a pipe inside `code` is not a delimiter; GFM says it is, unless
  // escaped. The old assertion is why the gate's own suite could never catch §1204's miss: the test encoded
  // the same wrong model as the implementation, so the pair was self-consistent and wrong together.
  it("only `\\|` escapes a pipe — a code span does NOT (GFM)", () => {
    expect(findOverWideRows("d.md", TBL("| `a|b` | 2 |\n")), "a code span does not protect a pipe").not.toEqual([]);
    expect(cellCount("| `x|y|z` | b |"), "4 cells, not 2").toBe(4);
    // The escape works, and is the remedy applied to the 24 rows — including inside a code span.
    expect(findOverWideRows("d.md", TBL("| a \\| b | 2 |\n"))).toEqual([]);
    expect(cellCount("| a \\| b | 2 |")).toBe(2);
    expect(cellCount("| `a \\| b` | 2 |")).toBe(2);
  });

  it("a table only starts where a divider follows the header", () => {
    // Without this, any pipe-leading line (a code block, an ASCII diagram) becomes a phantom header and
    // every line after it is measured against it.
    expect(findOverWideRows("d.md", "| not | a | table |\n| still | not |\n")).toEqual([]);
    expect(isDivider("| --- | :-: |")).toBe(true);
    expect(isDivider("| a | b |")).toBe(false);
  });

  it("a non-table line ENDS the table — two tables of different widths do not bleed", () => {
    const two = `${TBL("| 1 | 2 |\n")}\ntext\n| x | y | z |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n`;
    expect(findOverWideRows("d.md", two), "the 3-col table must be measured against ITS OWN header").toEqual([]);
  });

  it("the FUSED-row case §50 found: a row carrying a neighbour's cells", () => {
    // 9 pipes on a 4-column row — an insert that omitted a trailing newline, which deleted a mitigation
    // row from the render and was invisible in the source diff.
    const p = findOverWideRows("threat.md", "| a | b | c | d |\n| --- | --- | --- | --- |\n| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |\n");
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("row has 8 cells");
  });
});
