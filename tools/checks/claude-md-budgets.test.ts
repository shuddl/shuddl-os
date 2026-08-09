import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// REQ-118 §611 — CLAUDE.md's HARD BUDGETS ARE CHECKED AGAINST THE THINGS THAT ENFORCE THEM.
//
// §610's rule: any summary that RESTATES a value something else COMPUTES will drift, and the fix is to read
// one side and compute the other. The largest instance in the repo is not a gate's output — it is CLAUDE.md
// line 15, which states six budgets as law:
//
//   ≤22 tables (21 used) · 3 surfaces · 12 canonical views · 35 event kinds · 5 color tokens · 2 font families
//
// Every one is enforced somewhere, and **nothing read CLAUDE.md as data** — every reference to it across the
// repo is a comment or an error message quoting it. So a budget amendment (which CLAUDE.md itself says
// requires a register amendment) moves the constant and leaves the document stating the old number, in the
// file whose own header says it OVERRIDES any default behaviour and which every session reads first. A stale
// law is worse than an absent one: it is followed.
//
// MEASURED when this landed: all six agree. This locks a clean state rather than repairing a defect — §486's
// cheap half, and the case that most needs a test because nothing is failing and nothing else would notice it
// starting to.
//
// A STATIC SCAN, matching rater-purity / authority-coverage / append-chokepoint / visual-corpus. The
// alternative — importing MAX_CANONICAL_VIEWS from apps/command and TOKENS from packages/design — would pull
// a React app and a CSS-adjacent module into a node-environment tools test for two integers.
//
// NOT COVERED, deliberately: the "(21 used)" parenthetical. That is a RUNTIME figure derived from the
// migration set across two databases, which `check:invariants` recomputes and prints on every run
// (`invariants OK — 21/22 tables`) and which fails the gate if it ever exceeds TABLE_BUDGET. Parsing CREATE
// TABLE statements here to re-derive it would be a second, weaker implementation of a check that already
// exists — the §"two mechanisms" trap, where the copy becomes the thing that rots.

interface Budget {
  /** What CLAUDE.md calls it, for the failure message. */
  label: string;
  /** Pulls the stated number out of CLAUDE.md. */
  stated: RegExp;
  /** The file that actually enforces it. */
  source: string;
  /** Pulls the enforced number out of that file. */
  enforced: (src: string) => number | null;
}

/** Count the double-quoted strings inside a named `as const` array literal. */
function countArrayEntries(src: string, name: string): number | null {
  const m = new RegExp(`${name}[^=]*=\\s*\\[(.*?)\\]\\s*as const`, "s").exec(src);
  return m === null ? null : (m[1]!.match(/"[^"]+"/g) ?? []).length;
}

/** Count the `key: value` pairs of a named `as const` object literal. */
function countObjectKeys(src: string, name: string): number | null {
  const m = new RegExp(`export const ${name} = \\{(.*?)\\}\\s*as const`, "s").exec(src);
  return m === null ? null : (m[1]!.match(/^\s*\w+:/gm) ?? []).length;
}

/** Read a `export const NAME = <int>` declaration. */
function readIntConst(src: string, name: string): number | null {
  const m = new RegExp(`export const ${name} = (\\d+)`).exec(src);
  return m === null ? null : Number(m[1]);
}

const BUDGETS: readonly Budget[] = [
  {
    label: "tables",
    stated: /≤(\d+) tables/,
    source: "tools/checks/invariants.ts",
    enforced: (s) => readIntConst(s, "TABLE_BUDGET"),
  },
  {
    label: "surfaces",
    stated: /(\d+) surfaces/,
    source: "tools/checks/invariants.ts",
    enforced: (s) => countArrayEntries(s, "SURFACE_ROSTER"),
  },
  {
    label: "canonical views",
    stated: /(\d+) canonical views/,
    source: "apps/command/src/views/registry.ts",
    enforced: (s) => readIntConst(s, "MAX_CANONICAL_VIEWS"),
  },
  {
    label: "event kinds",
    stated: /(\d+) event kinds/,
    source: "packages/contracts/src/events.ts",
    enforced: (s) => countArrayEntries(s, "EVENT_KINDS"),
  },
  {
    label: "color tokens",
    stated: /(\d+) color tokens/,
    source: "packages/design/src/tokens.ts",
    enforced: (s) => countObjectKeys(s, "TOKENS"),
  },
  {
    label: "font families",
    stated: /(\d+) font families/,
    source: "packages/design/src/tokens.ts",
    enforced: (s) => countObjectKeys(s, "FONTS"),
  },
];

describe("REQ-118 §611: CLAUDE.md's hard budgets match what enforces them", () => {
  const root = repoRoot();
  const claudeMd = readFileSync(`${root}/CLAUDE.md`, "utf8");

  it("every budget is stated in CLAUDE.md and readable from its source (non-vacuity)", () => {
    // Both halves can go silent: a reworded CLAUDE.md line stops matching, and a renamed/restructured
    // constant stops parsing. Either would compare undefined to undefined and pass — the class this repo met
    // in eleven gates (§487/§554/§572/§584/§586/§590/§592/§593/§598/§607/§608).
    const unreadable = BUDGETS.filter((b) => {
      const stated = b.stated.exec(claudeMd);
      const enforced = b.enforced(readFileSync(`${root}/${b.source}`, "utf8"));
      return stated === null || enforced === null;
    }).map((b) => b.label);
    expect(
      unreadable,
      "a budget could not be read from CLAUDE.md or from its enforcing source. That is a BROKEN SCAN, not a " +
        "clean record — fix the parse before trusting the comparison below",
    ).toEqual([]);
  });

  // §743 — THE ROSTER'S OWN COMPLETENESS. Both assertions above iterate BUDGETS, so a budget stated in
  // CLAUDE.md that nobody added to the roster is invisible to the gate whose entire job is "stated equals
  // enforced". MEASURED: inserting `· 7 agent queues ·` into the hard-budgets line — a budget nothing anywhere
  // enforces — left this file at 2/2 GREEN.
  //
  // That is §671's completeness-floor shape at the level of the gate itself, and it matters here more than
  // usual because the hard-budgets line is EXACTLY where a new budget would be written: CLAUDE.md says a
  // budget change is a register amendment, so the amendment lands in this line first and the enforcement
  // follows. The window between those two edits is the window this floor closes.
  //
  // Derived, not listed (§699: membership is a property of the DOCUMENT). Every `<number> <word>` pair on the
  // hard-budgets line must be claimed by some BUDGETS entry — or be named below with its reason.
  it("every budget STATED in CLAUDE.md is covered by the roster (§743 completeness floor)", () => {
    const line = /## Hard budgets[^\n]*\n([^\n]*)/.exec(claudeMd)?.[1] ?? "";
    expect(line.length, "the hard-budgets line did not parse — a broken scan, not a clean record").toBeGreaterThan(60);

    // ZERO-TOLERANCE RULES ARE NOT COUNT COMPARISONS. "0 shadows/gradients/radius>4px" is enforced by the
    // design audit refusing a PLANTED artifact (CLAUDE.md rule 7 records that proof: a shadow, an over-budget
    // radius and a raw hex), not by reading an integer out of a source file. Exempt WITH its reason, the way
    // every other allowlist in this repo carries one — never by widening the pattern until it stops matching.
    // Each exemption is matched at the NUMBER's own position and carries its reason. The floor found all three
    // on its first run, which is the evidence it works: they are the only numbers on that line that are not
    // count-vs-constant comparisons.
    const EXEMPT: readonly string[] = [
      // A RUNTIME figure, not a budget: `check:invariants` recomputes it from the migration set across two
      // databases on every run (`invariants OK — 21/22 tables`) and fails if it exceeds TABLE_BUDGET. This
      // file's own header already excludes it, for the §"two mechanisms" reason — re-deriving it here would be
      // a second, weaker copy of a check that exists.
      "21 used",
      // ZERO-TOLERANCE, proven by PLANTING an artifact rather than by reading an integer: CLAUDE.md rule 7
      // records the design audit refusing a planted shadow, an over-budget radius and a raw hex. There is no
      // constant to compare against, which is exactly why it cannot be a roster entry.
      "0 shadows",
      // The radius half of the same zero-tolerance rule, and the only number on the line with no whitespace
      // after it — `radius>4px`.
      "4px",
    ];

    // Matched by SPAN, not by reconstructing the phrase: a roster regex reads `(\d+) canonical views` while a
    // naive `<n> <word>` pair yields "12 canonical", and comparing those two strings is a guess about how many
    // words a budget's name has. Instead, run each roster regex against the LINE and record the character range
    // it claims; every number on the line must fall inside some claimed range.
    const claimed: (readonly [number, number])[] = [];
    for (const b of BUDGETS) {
      const m = b.stated.exec(line);
      if (m?.index !== undefined) claimed.push([m.index, m.index + m[0].length] as const);
    }
    const numbers = [...line.matchAll(/\d+/g)];
    expect(numbers.length, "no numbers found on the hard-budgets line — the scan broke, not the line").toBeGreaterThanOrEqual(6);

    const uncovered = numbers
      .filter((m) => {
        const at = m.index!;
        if (claimed.some(([from, to]) => at >= from && at < to)) return false;
        // EXEMPT entries are matched at the same position, so a zero-tolerance rule is excused precisely where
        // it appears rather than anywhere the digit happens to occur.
        return !EXEMPT.some((e) => line.startsWith(e, at));
      })
      .map((m) => `"${line.slice(m.index!, Math.min(line.length, m.index! + 28))}…"`);
    expect(
      uncovered,
      "CLAUDE.md states a hard budget that the BUDGETS roster does not cover, so nothing checks it against an " +
        "enforcing source. A budget in this line is LAW — every session reads it first. Add a roster entry " +
        "naming what enforces it, or, if it is a zero-tolerance rule proven by planting an artifact rather " +
        "than by a count, add it to EXEMPT with that reason:\n  " +
        uncovered.join("\n  "),
    ).toEqual([]);
  });

  it("each stated budget equals the number its gate actually enforces", () => {
    const drift = BUDGETS.map((b) => {
      const stated = Number(b.stated.exec(claudeMd)![1]);
      const enforced = b.enforced(readFileSync(`${root}/${b.source}`, "utf8"))!;
      return { label: b.label, stated, enforced, source: b.source };
    }).filter((d) => d.stated !== d.enforced);

    expect(
      drift,
      "CLAUDE.md states a budget that no longer matches what enforces it. The document is the source-of-truth " +
        "every session reads FIRST and its header says it overrides any default behaviour, so a stale number " +
        "there is followed as law. If the budget genuinely changed, that is a register amendment (CLAUDE.md " +
        "says so itself) — amend the row, then update the line:\n  " +
        drift.map((d) => `${d.label}: CLAUDE.md says ${d.stated}, ${d.source} enforces ${d.enforced}`).join("\n  "),
    ).toEqual([]);
  });
});
