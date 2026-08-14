import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";
import { stripStruck } from "./strip-struck.js";

// §1411 (REQ-118) — THE STRIKETHROUGH MASK IS LOCAL, AND MASKING IS INDEPENDENT OF UNRELATED PROSE.
//
// The defect is written up in `strip-struck.ts`. What it needs from a test is the property it violated,
// not the shape it had: with a global `~~[\s\S]*?~~` pair, **what a gate could see depended on how many
// times the document happened to mention `~~` earlier**. Adding a row to an index table 25,000 lines above
// a citation changed whether that citation was checked. The last two tests below are that property stated
// directly, so the regression cannot come back wearing a different regex.

const RECORDS = ["docs/audits/2026-08-01-technical-debt-audit.md", "docs/ops/GO-LIVE-CHECKLIST.md"] as const;
const CITATION = /`([\w./-]+\.(?:ts|tsx|md|json|sql|mjs|js)):(\d+)/g;

const visibleCitations = (text: string): number => [...stripStruck(text).matchAll(CITATION)].length;

describe("§1411 REQ-118: the strikethrough mask is line-local and offset-preserving", () => {
  const root = repoRoot();

  it("masks a real strike and keeps the correction beside it", () => {
    expect(stripStruck("across ~~four~~ THREE workers")).not.toContain("four");
    expect(stripStruck("across ~~four~~ THREE workers")).toContain("THREE");
  });

  it("an UNPAIRED marker masks nothing (the prose case that broke the old regex)", () => {
    // "nine gates touch `~~`" is a sentence this repo actually writes. Under a global pair it opened a
    // span that ran to the next `~~` anywhere in the file.
    const prose = "nine gates touch `~~` and the claim at `packages/ledger/src/lens.ts:12` is live";
    expect(stripStruck(prose)).toBe(prose);
  });

  it("a span DOES cross a soft line break — both records strike wrapped sentences", () => {
    // The first version of this mask was line-wise and this case is why it lasted one commit:
    // GO-LIVE-CHECKLIST.md:344-346 and workers/agents/wrangler.toml:108-110 both strike a correction
    // wrapped across lines, and `wrangler-absence-claims` immediately read one as a live claim.
    const wrapped = "~~this claim was\nwrong~~ CORRECTED: it is `packages/ledger/src/lens.ts:12`";
    expect(stripStruck(wrapped)).not.toContain("wrong");
    expect(stripStruck(wrapped)).toContain("CORRECTED");
    expect(stripStruck(wrapped).split("\n")).toHaveLength(2);
  });

  it("but NEVER a blank line — a stray marker cannot reach past its own paragraph", () => {
    // The bound that makes the whole thing safe. Under the old global pair the citation below was masked
    // and therefore certified without being read; that is the 62% case in one line.
    const doc = "a paragraph mentioning the `~~` convention\n\nlater: `packages/ledger/src/lens.ts:12` ~~struck~~";
    expect(stripStruck(doc)).toContain("packages/ledger/src/lens.ts:12");
    expect(stripStruck(doc)).not.toContain("struck");
  });

  it("preserves length and line count exactly (citation-links derives line numbers from offsets)", () => {
    for (const rel of RECORDS) {
      const text = readFileSync(`${root}/${rel}`, "utf8");
      expect(stripStruck(text)).toHaveLength(text.length);
      expect(stripStruck(text).split("\n")).toHaveLength(text.split("\n").length);
    }
  });

  it("masks a real but BOUNDED share of each record (a corpus floor, not a hit count)", () => {
    // §1387's rule: floor the INPUT. The failure mode is not "masked nothing", it is "masked the document"
    // — the old regex hid 66% of the audit while every gate reading it reported clean. Both bounds are
    // asserted so a future mask cannot pass by doing nothing either.
    for (const rel of RECORDS) {
      const text = readFileSync(`${root}/${rel}`, "utf8");
      const stripped = stripStruck(text);
      let masked = 0;
      for (let i = 0; i < text.length; i += 1) if (text[i] !== " " && stripped[i] === " ") masked += 1;
      expect(masked, `${rel}: nothing masked — the mask broke, not the record`).toBeGreaterThan(0);
      expect(
        (masked / text.length) * 100,
        `${rel}: the mask hides more than a twentieth of the record. A strikethrough span is a phrase, not ` +
          `a chapter — this is what a newline-crossing pair looks like from the outside.`,
      ).toBeLessThan(5);
    }
  });

  it("what a citation MEANS does not depend on unrelated prose elsewhere in the file", () => {
    // THE REGRESSION, stated as a property. Appending a line that merely MENTIONS the notation must not
    // change how many citations are visible anywhere. Under the old regex this went from 526 to 260.
    for (const rel of RECORDS) {
      const text = readFileSync(`${root}/${rel}`, "utf8");
      const before = visibleCitations(text);
      expect(
        before,
        `${rel}: no citations found — the probe broke, not the record. LIVE COUNT 182 (audit) / 154 ` +
          `(checklist) at §1413; the floor is 20, far below both: a tripwire for a broken matcher, and NOT a ` +
          `citation-count assertion — the records grow every phase and this must not need editing.`,
      ).toBeGreaterThan(20);
      expect(
        visibleCitations("a note about the `~~` convention\n\n" + text),
        `${rel}: adding ONE unpaired marker changed what the rest of the document means. Every gate that ` +
          `reads this record now certifies a different subset than it did a commit ago, silently.`,
      ).toBe(before);
    }
  });

  it("no file re-authors the mask (§1413 — the sweep that missed two copies searched for a SHAPE)", () => {
    // §1411 rewired five copies and reported the class closed. It was not: `ledger-status-vocabulary` held
    // two more, found only at §1413 and only because the enumeration finally went by BEHAVIOUR ("replaces a
    // `~~` pattern") instead of by the shape §1411 happened to have seen (`[\s\S]`). That is my own
    // sweep-by-behaviour rule, broken in the phase that was about duplicated matchers.
    //
    // MASKS only. A regex that READS a struck span is legitimate and stays legal — `checklist-figures`
    // matches `~~**41**~~ **43**` on purpose, to compare a corrected figure against the live one. The
    // distinction is `.replace(`, and it is the reason this roster is not simply "any regex containing ~~".
    const files = execSync("git ls-files packages workers tools apps", { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
      .filter((f) => f !== "tools/checks/strip-struck.ts" && f !== "tools/checks/strip-struck.test.ts");
    const offenders = files.filter((f) =>
      readFileSync(`${root}/${f}`, "utf8")
        .split("\n")
        .some((l) => !l.trim().startsWith("//") && /\.replace\(\s*\/[^\n]*~~/.test(l)),
    );
    expect(
      offenders,
      "a file masks struck spans with its own regex instead of `stripStruck`. Every private copy has been " +
        "wrong in a different way: the global pair hid 62% of a record, line-wise dropped wrapped strikes, " +
        "and `[^~]*` mis-paired around this repo's `~24 guards` idiom. Import the shared one:\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  it("the roster's detector would notice one (positive control)", () => {
    expect(/\.replace\(\s*\/[^\n]*~~/.test('const x = s.replace(/~~.*?~~/g, "");')).toBe(true);
    expect(/\.replace\(\s*\/[^\n]*~~/.test('const m = /~~\\*\\*(\\d+)\\*\\*~~/.exec(s);')).toBe(false);
  });

  it("nor on WHERE that prose is inserted", () => {
    // The insertion that exposed the original defect was in the middle, not at the top — parity flips for
    // everything after the insertion point, so the midpoint is the case that actually bit.
    const text = readFileSync(`${root}/${RECORDS[0]}`, "utf8");
    const lines = text.split("\n");
    const mid = [...lines.slice(0, lines.length >> 1), "", "…marks superseded text by ~~striking~~ it, and `~~`", "", ...lines.slice(lines.length >> 1)];
    expect(visibleCitations(mid.join("\n"))).toBe(visibleCitations(text));
  });
});
