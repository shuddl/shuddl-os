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
