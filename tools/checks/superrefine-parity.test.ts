import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §912 — A RULE WRITTEN TWICE MUST BE WRITTEN THE SAME WAY TWICE, AND BOTH COPIES MUST BE TESTED.
//
// `packages/contracts/src/events.ts` carries the device-binding rules in TWO mirrored `superRefine`
// blocks — one on `LedgerEvent` (the stored shape), one on `EventInput` (the pre-storage shape). The
// duplication is forced: a Zod discriminated union cannot take a refined object as a member, so the
// rule cannot be inherited and has to be restated per union.
//
// MEASURED AT §912, by mutating each branch and running the suite: FOUR of the eight branches were
// silent. And the coverage was ASYMMETRIC — `device_id === actor.device` was tested only on
// EventInput, I4 only on LedgerEvent, the dedupe-key branch on NEITHER. Each copy was tested for a
// DIFFERENT subset, so the pair read as covered while neither actually was. That is the failure mode
// the repo's own `share-lint-matchers-with-parity-tests` rule exists for: the copy that gets less
// attention becomes the evasion vector.
//
// `events.test.ts` now drives one probe corpus through both schemas, which fixes today's asymmetry.
// This gate closes the ROSTER HALF (§802/§822): that corpus is a hand-written list, so a NEW branch
// added to one block and not the other — or added to both and tested in neither — would be invisible
// to it. A roster finds what it lists; this is the scan.
//
// WHAT A GREEN HERE DOES NOT MEAN. It proves the two blocks state the same rules and that some test
// regex matches each rule's message. It does NOT prove the test asserting that message uses a sound
// fixture — §906's defect (a bare `toThrow()` refusing for an unrelated reason) is invisible here.

const EVENTS_SRC = "packages/contracts/src/events.ts";
const EVENTS_TEST = "packages/contracts/test/events.test.ts";

/** The `message: "..."` set inside each `.superRefine(...)` block, in source order. */
function superRefineMessages(src: string): string[][] {
  const lines = src.split("\n");
  const blocks: string[][] = [];
  for (let s = 0; s < lines.length; s++) {
    if (!(lines[s] ?? "").includes(".superRefine(")) continue;
    const msgs: string[] = [];
    for (let i = s + 1; i < lines.length; i++) {
      const l = lines[i] ?? "";
      if (/^ {2}\}\)/.test(l)) break; // block closes at two-space indent
      const m = /message: "([^"]+)"/.exec(l);
      if (m) msgs.push(m[1] as string);
    }
    blocks.push(msgs);
  }
  return blocks;
}

/** Every regex literal handed to `toThrow(...)` in the test file, compiled. */
function thrownMatchers(testSrc: string): RegExp[] {
  const out: RegExp[] = [];
  for (const m of testSrc.matchAll(/toThrow\(\s*\/((?:[^/\\\n]|\\.)+)\/([gimsuy]*)\s*\)/g)) {
    out.push(new RegExp(m[1] as string, m[2] as string));
  }
  return out;
}

describe("§912: the mirrored superRefines agree, and every rule they state is asserted", () => {
  const root = repoRoot();
  const src = readFileSync(`${root}/${EVENTS_SRC}`, "utf8");
  const blocks = superRefineMessages(src);

  it("both blocks parse with real content (non-vacuity — two empty sets agree about nothing)", () => {
    // §819's failure mode: a changed block shape yields empty arrays and every assertion below passes
    // over nothing. Floors sit under the values measured at §912 (2 blocks, 4 messages each).
    expect(blocks.length, `expected 2 superRefine blocks in ${EVENTS_SRC}, found ${blocks.length} — the scan is broken, not the source`).toBe(2);
    for (const [i, b] of blocks.entries()) {
      expect(b.length, `superRefine block ${i} yielded no messages — the scan is broken`).toBeGreaterThanOrEqual(4);
    }
  });

  it("LedgerEvent and EventInput state the SAME set of device-binding rules", () => {
    const [a, b] = blocks as [string[], string[]];
    expect(
      [...new Set(b)].sort(),
      "the two mirrored superRefines in events.ts have diverged. A rule added to one union and not " +
        "the other means an event refused as stored is ACCEPTED as input (or the reverse) — the " +
        "pre-storage shape is the one a write meets first. Restate the branch in both blocks.",
    ).toEqual([...new Set(a)].sort());
  });

  it("every rule either block states is pinned by a matcher that names IT and no other rule", () => {
    // "Some matcher matches it" is too weak, and this gate shipped that way for one mutation round:
    // the I4 tests used `/unwitnessed|device/`, an alternation matching EVERY message containing the
    // word "device". Renaming a rule in BOTH blocks then kept this green, because the loose matcher
    // still matched the new text — a green certifying only that the words overlap (§906's lesson,
    // landing on the instrument rather than the code). The matchers were tightened and the property
    // strengthened: a matcher counts for a rule only if it DISCRIMINATES that rule from the others.
    const messages = [...new Set(blocks.flat())];
    const matchers = thrownMatchers(readFileSync(`${root}/${EVENTS_TEST}`, "utf8"));
    expect(matchers.length, `no toThrow(/regex/) matchers found in ${EVENTS_TEST} — the scan is broken`).toBeGreaterThanOrEqual(4);
    const unpinned = messages.filter(
      (msg) => !matchers.some((re) => re.test(msg) && messages.filter((m) => re.test(m)).length === 1),
    );
    expect(
      unpinned,
      "a superRefine branch states a rule that no test matcher pins UNIQUELY. Either the branch is " +
        "untested — §912 found four such, and deleting any of them left all 308 contracts tests " +
        "green — or a test 'covers' it with a regex so loose it would also pass on a different " +
        `rule's refusal. Add a case in ${EVENTS_TEST} whose toThrow() regex names this rule alone:\n  ` +
        unpinned.join("\n  "),
    ).toEqual([]);
  });
});
