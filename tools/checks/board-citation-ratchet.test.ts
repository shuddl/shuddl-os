import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §1452 (REQ-118/119) — A BOARD FIGURE CITED WITHOUT ITS COMMIT IS A CLAIM WITH NO EXPIRY.
//
// §1451's finding: twenty-two consecutive phase gates closed with "board unchanged from §1428's full run"
// while 23 commits landed, nine of them touching non-doc files. §1428 is itself the phase that caught the
// same error and wrote *"a claim you INHERIT is a claim you are MAKING"* — so the lesson failed to survive
// twenty-two phases by its own author. §1451 stated the operable rule:
//
//   > A phase gate may cite a board measured at a different commit only by naming that commit
//   > AND the number of commits since.
//
// §1439 established that naming a rule without adopting it is the cheapest kind of finding. This is the
// adoption. The mechanical core is that a board figure has a distinctive shape (`N PASS · N FAIL · N
// BLOCKED`) and a commit is a hex token — no prose reading required, so §1399's English boundary does not
// apply.
//
// WHY A RATCHET AND NOT A RULE. 74 existing sections cite a board without a commit. They are DATED RECORDS of
// measurements taken at the time; editing them to add a commit I would have to infer is fabricating
// provenance, which is worse than the omission. The historical count is frozen and new violations are
// forbidden — the same shape as `citation-ratchet`, for the same reason: a record that cannot be rewritten
// can still be prevented from getting worse.

const AUDIT = "docs/audits/2026-08-01-technical-debt-audit.md";

/** A board verdict as this record writes it — the aggregate line every phase gate quotes. */
const BOARD = /\b\d+ PASS · \d+ FAIL · \d+ BLOCKED\b|\b21 PASS\b/;
/** A commit as this record cites one: a bare short SHA in backticks or prose. */
const SHA = /\b[0-9a-f]{7,40}\b/;

/**
 * Sections citing a board figure WITHOUT naming any commit.
 *
 * LIVE COUNT 74 at §1452, out of 216 sections that cite a board at all (142 do name one). The floor below is
 * that exact number rather than a looser bound: this is a RATCHET, not a tripwire — the whole point is that
 * one more is a failure. It is expected to fall, never to rise, so `toBeLessThanOrEqual` and not `toBe`.
 */
function unnamedBoardCitations(root: string): string[] {
  const text = readFileSync(`${root}/${AUDIT}`, "utf8");
  const out: string[] = [];
  for (const section of text.split(/\n(?=## §\d+ )/)) {
    const id = /^## §(\d+) /.exec(section);
    if (id === null || !BOARD.test(section)) continue;
    if (!SHA.test(section)) out.push(`§${id[1]}`);
  }
  return out;
}

describe("§1452 REQ-118: a cited board names the commit it was measured at", () => {
  const root = repoRoot();
  const unnamed = unnamedBoardCitations(root);

  it("derives a real population (non-vacuity — an empty scan would freeze nothing)", () => {
    // §1387's rule, and the §1439 shape: LIVE COUNT 216 sections cite a board figure; the floor is 100,
    // deliberately far below it because sections are appended constantly — a tripwire for a broken splitter
    // or a renamed audit file, never a section count anyone maintains.
    const text = readFileSync(`${root}/${AUDIT}`, "utf8");
    const citing = text.split(/\n(?=## §\d+ )/).filter((s) => /^## §\d+ /.test(s) && BOARD.test(s));
    expect(citing.length, "no section cites a board figure — the splitter or the pattern broke, not the record").toBeGreaterThan(100);
  });

  it("the historical count does not GROW", () => {
    expect(
      unnamed.length,
      "a phase gate cites a board verdict without naming the commit it was measured at. §1451 is what that " +
        "costs: twenty-two phases restated a board that was 23 commits stale, and the staleness was invisible " +
        "precisely because no commit was named. Name the commit AND the number of commits since, or " +
        "re-measure. Current offenders beyond the frozen 74:\n  " +
        unnamed.slice(74).join(", "),
    ).toBeLessThanOrEqual(74);
  });

  it("the two boards §1451 compared both name their commits (positive control)", () => {
    // If the detector stopped finding SHAs, the ratchet above would pass by seeing zero violations. These two
    // sections are known-good and must stay out of the offender list.
    expect(unnamed).not.toContain("§1428");
    expect(unnamed).not.toContain("§1451");
  });
});
