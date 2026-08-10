import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §878 — A CHECKLIST ROW MAY NOT NAME A SYMBOL THAT DOES NOT EXIST.
//
// §877 found `notifyBoard`: an open-debt row citing a seam the sequencer "exposes", where `git grep` returned
// three hits and ALL THREE were documentation — this row, the WP-02 plan, and docs/wp/WP-02.md. The row was
// right about the world (the board is a polled read) and wrong about the artifact, which is the harder kind of
// stale to notice: nothing fails, and a backticked identifier reads as evidence.
//
// §877 closed by saying the record cannot check itself while its claims are free text. That is true in general
// and FALSE for this one case. A backticked camelCase identifier is not prose — it is a mechanical claim that a
// symbol exists, and existence is decidable.
//
// MEASURED BEFORE BUILDING (§878): 75 such identifiers in the checklist; exactly ONE absent from every tracked
// source file, and it was `notifyBoard`. A 1.3% flag rate is what makes this a gate rather than a lint someone
// turns off in a week.
//
// WHAT THIS DOES NOT DO. It proves a symbol is SOMEWHERE in the tree, not that the row's claim about it is
// true — §877's `hashPath` row named a real symbol and still described code that had been rewritten underneath
// it. A green here certifies quite little; it just happens to certify the thing that broke.

/**
 * camelCase only, deliberately: `notifyBoard`, `hashPath`, `projectApprovals` are code, while `events`,
 * `pod.signed`, `JWT_SECRET` and `--progress` are tables, event kinds, env vars and design tokens. The narrow
 * shape is what holds the precision at 74/75; widening it trades a real gate for a noisy one.
 */
const CAMEL = /`([a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*)`/g;

/**
 * Symbols the record names precisely BECAUSE they are absent. A gate that scans prose cannot tell an example
 * from a use (§829, §871, and this file makes three), so the exception is keyed to the symbol and carries the
 * reason — never a looser pattern.
 */
const NAMED_AS_ABSENT: Record<string, string> = {
  notifyBoard:
    "§877: the row exists to record that this seam was planned and never built. Live board push is REQ-257 " +
    "(vNEXT); the row says 'do not re-add a notifyBoard seam to satisfy this row'.",
};

const CHECKLIST = "docs/ops/GO-LIVE-CHECKLIST.md";

describe("§878: the live checklist may not cite a symbol that does not exist", () => {
  const root = repoRoot();
  const doc = readFileSync(`${root}/${CHECKLIST}`, "utf8");

  const cited = new Map<string, number>();
  for (const m of doc.matchAll(CAMEL)) {
    const s = m[1] as string;
    cited.set(s, (cited.get(s) ?? 0) + 1);
  }

  // THIS FILE IS EXCLUDED FROM ITS OWN CORPUS, and the reason is a defect it caught in itself (§882).
  //
  // `NAMED_AS_ABSENT` necessarily WRITES the symbol it certifies as absent, and this is a `.ts` file, so once
  // committed it satisfies its own existence check — `notifyBoard` "now exists in source". The §672 half fired
  // correctly and the subject was me.
  //
  // What makes it worth a comment rather than a one-line filter: the gate PASSED before the commit and FAILED
  // after, with no edit in between. The corpus is `git ls-files`, so an untracked file is invisible (§870) —
  // which means a self-referencing gate cannot be validated until it is tracked. Run it once more after
  // committing anything that adds a symbol to the allowlist.
  const SELF = "tools/checks/checklist-symbols.test.ts";

  const sourceText = (): string => {
    const files = execSync("git ls-files -- '*.ts' '*.tsx' '*.mjs' '*.sql' '*.json'", { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter((f) => Boolean(f) && f !== SELF);
    return files.map((f) => readFileSync(`${root}/${f}`, "utf8")).join("\n");
  };

  it("extracts a real population from the checklist (non-vacuity)", () => {
    // A changed doc path or a broken pattern yields an empty map, and the assertion below would pass over
    // nothing — the failure this repo met in four gates (§487/§554/§572). Floor well under the 75 measured.
    expect(cited.size, `no camelCase identifiers found in ${CHECKLIST} — the scan is broken, not the record`).toBeGreaterThanOrEqual(50);
  });

  it("every camelCase symbol the checklist backticks exists in tracked source", () => {
    const src = sourceText();
    const missing = [...cited.keys()]
      .filter((s) => !(s in NAMED_AS_ABSENT))
      .filter((s) => !new RegExp(`\\b${s}\\b`).test(src));
    expect(
      missing,
      `${CHECKLIST} cites a symbol that appears nowhere in tracked source. Either the row is stale (the code ` +
        "was renamed or deleted and the row still points at it — §877 found exactly this), or the symbol was " +
        "planned and never built, in which case say so and add it to NAMED_AS_ABSENT with its reason:\n  " +
        missing.join("\n  "),
    ).toEqual([]);
  });

  it("no NAMED_AS_ABSENT row outlives its subject (§672)", () => {
    // Two ways a row rots: the checklist stops mentioning the symbol (the exception is dead weight), or the
    // symbol gets BUILT (the exception now hides a real citation from the check that should be watching it).
    const src = sourceText();
    for (const [sym, why] of Object.entries(NAMED_AS_ABSENT)) {
      expect(cited.has(sym), `${sym} is allowlisted but the checklist no longer names it — delete the row ("${why.slice(0, 40)}…")`).toBe(true);
      expect(
        new RegExp(`\\b${sym}\\b`).test(src),
        `${sym} is allowlisted as NEVER BUILT, but it now exists in source — delete the row and let the check watch it`,
      ).toBe(false);
    }
  });
});
