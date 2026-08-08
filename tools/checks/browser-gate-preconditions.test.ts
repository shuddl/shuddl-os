import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// REQ-158/076 §726 — TWO BROWSER GATES ARE PURE NEGATIVES, AND ONLY A PRECONDITION MAKES THEM MEAN ANYTHING.
//
// §725 asked what each browser gate would do on an empty page. `visual` is safe by construction — a blank
// page is not the blessed screenshot. `a11y` and `perf` are not:
//
//     a11y   expect(blocking).toEqual([])        an unmounted page has ZERO violations
//     perf   long-task budget under a threshold  an unmounted page has ZERO long tasks
//
// Both pass on nothing. What saves them is one line each, and the a11y suite says so outright:
//
//     "Every surface must have actually PAINTED before we sample: an unmounted <div id='root'> has no
//      findings and would be a VACUOUS PASS. Rendered text is the mount signal."
//
// Those two lines are load-bearing in a way that reads as boilerplate. Delete either and the gate keeps
// reporting PASS with the same assertion count — §609 floored *how many* assertions run, and this floors
// *whether the page existed when they ran*, which §724 showed is a different question.
//
// The instruments differ ON PURPOSE and the difference is documented: `waitForSelector` is wrong for the
// surfaces (they size from a full-height flex chain and the root is briefly not-visible), and
// `waitForFunction` on painted text is wrong for the map (the canvas paints before any text). So this gate
// pins each suite's OWN instrument rather than a shared one.

interface Precondition {
  readonly gate: string;
  readonly file: string;
  /** The instrument this suite uses, and why it is the right one HERE. */
  readonly pattern: RegExp;
  readonly instrument: string;
}

const PRECONDITIONS: readonly Precondition[] = [
  {
    gate: "a11y",
    file: "tests/e2e/accessibility.spec.ts",
    pattern: /waitForFunction\([\s\S]{0,120}?innerText/,
    instrument: "waitForFunction on painted text — the surfaces size from a flex chain, so the root is briefly not-visible and waitForSelector would race",
  },
  {
    gate: "perf",
    file: "packages/map/perf/perf.spec.ts",
    pattern: /waitForSelector\(\s*["'`]canvas/,
    instrument: "waitForSelector('canvas') — the map paints a canvas before any text, so painted-text would never fire",
  },
];

describe("REQ-158/076 §726: a pure-negative browser gate keeps its render precondition", () => {
  const root = repoRoot();

  it("finds both suites (non-vacuity — a renamed spec must not read as clean)", () => {
    for (const { file } of PRECONDITIONS) {
      expect(existsSync(`${root}/${file}`), `${file} is gone — this gate has no subject`).toBe(true);
    }
  });

  it.each(PRECONDITIONS)("$gate still waits for the page to render before sampling", ({ gate, file, pattern, instrument }) => {
    const src = readFileSync(`${root}/${file}`, "utf8");
    expect(
      pattern.test(src),
      `the ${gate} suite no longer waits for the page to render before it samples. Its assertions are PURE ` +
        `NEGATIVES — an unmounted page has zero violations and zero long tasks — so without this the gate ` +
        `reports PASS on a blank screen, with its assertion count unchanged (§724). Restore it, or if the ` +
        `instrument changed deliberately, update this expectation and say why:\n  expected: ${instrument}`,
    ).toBe(true);
  });

  it("§725's third suite is safe by construction, not by precondition (the assumption this file rests on)", () => {
    // `visual` needs no precondition because its assertion IS positive — it compares against a blessed
    // reference. If it ever became a negative check, it joins the table above. Stated so the omission reads
    // as a decision rather than an oversight.
    const src = readFileSync(`${root}/tests/visual/screens.spec.ts`, "utf8");
    expect(
      /toHaveScreenshot|toMatchSnapshot/.test(src),
      "the visual suite no longer compares against a reference image. If it became a negative assertion it " +
        "needs a render precondition like a11y and perf, and belongs in PRECONDITIONS above",
    ).toBe(true);
  });
});
