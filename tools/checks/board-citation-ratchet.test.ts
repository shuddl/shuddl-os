import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

/**
 * Every short SHA a board-citing section names, that does NOT resolve to a commit in this repository.
 *
 * §1677 ADDED THIS, because naming a commit and naming a REAL commit are different claims and only the first
 * was checked. I wrote `9d02e34` into a phase gate's board line — a plausible hex string I had not verified —
 * and every docs gate passed, because the rule above is satisfied by the SHAPE of a hex token. A board verdict
 * whose commit cannot be resolved is unverifiable by the next reader, which is the exact failure §1451 records
 * (a board restated while 23 commits landed) arriving by a different door.
 *
 * §997 MEASURED THIS AND DECLINED IT, correctly: 151/160 cited SHAs resolved and all 9 misses were benign
 * (money in cents, account ids, `abc1234` placeholders), so there was no defect to gate. §1677 is the first
 * real instance, which is what changes the verdict — not a better argument.
 *
 * SCOPING, corrected by its own first run. Restricting to board-citing sections is NOT enough: §4 is the index,
 * it cites boards, and it also contains the sentence in which §997 QUOTES its own benign misses — so the first
 * version flagged `22208400` and `abc1234`, the record's permanent false-positive floor (prose naming
 * known-bad values). What actually separates them is the PHRASE: this record cites a commit as "measured at
 * `sha`" / "carried from `sha`" / "at `sha`", never as an appositive. So the token must be the object of one
 * of those prepositions. Mechanical, no English reading, and it is the idiom the record already uses.
 */
function unresolvableShas(root: string): string[] {
  const text = readFileSync(`${root}/${AUDIT}`, "utf8");
  const cited: { section: string; sha: string }[] = [];
  for (const section of text.split(/\n(?=## §\d+ )/)) {
    const id = /^## §(\d+) /.exec(section);
    if (id === null || !BOARD.test(section)) continue;
    // "measured at `sha`", "carried from `sha`", "at `sha`", "since `sha`" — the object of a commit preposition.
    for (const m of section.matchAll(/\b(?:at|from|since|commit)\s+`([0-9a-f]{7,40})`/gi)) {
      cited.push({ section: `§${id[1]}`, sha: m[1] as string });
    }
  }
  if (cited.length === 0) return [];
  // ONE `git cat-file --batch-check` over the unique set. Per-SHA spawns timed out at 5s under the parallel
  // `test:tools` run (measured, §1677) while passing standalone — a check whose cost scales with the record
  // will eventually fail for a reason that has nothing to do with the record.
  const unique = [...new Set(cited.map((c) => c.sha))];
  const probe = spawnSync("git", ["cat-file", "--batch-check"], {
    cwd: root,
    input: unique.map((sha) => `${sha}^{commit}`).join("\n") + "\n",
    encoding: "utf8",
  });
  if (probe.status === null || typeof probe.stdout !== "string") {
    throw new Error("git cat-file --batch-check could not run — this check cannot certify anything");
  }
  const lines = probe.stdout.trim().split("\n");
  const missing = new Set<string>();
  lines.forEach((line, i) => {
    // A resolvable object prints "<full-oid> commit <size>". A MISS echoes the input — "9d02e34^{commit}
    // missing" — which CONTAINS the word `commit`, so a loose /\bcommit\b/ passes every miss (measured: the
    // re-plant went green, §1677). Anchor on the full shape instead.
    if (!/^[0-9a-f]{40} commit \d+$/.test(line.trim())) missing.add(unique[i] as string);
  });
  return cited.filter((c) => missing.has(c.sha)).map((c) => `${c.section}: ${c.sha}`);
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

  it("§1677 every commit a board citation names RESOLVES in this repository", () => {
    // Not a ratchet: this one is exact. A fabricated SHA is never a dated record worth grandfathering — it is
    // a verdict the next reader cannot re-measure, and there were zero when this was written.
    expect(
      unresolvableShas(root),
      "a phase gate cites a board measured at a commit that does not exist in this repository. Naming a commit " +
        "and naming a REAL one are different claims; only the shape was ever checked, which is how `9d02e34` " +
        "shipped (§1677). Re-read the commit with `git log --oneline` and correct it — do NOT delete the SHA, " +
        "because an unnamed board is the §1451 defect this gate exists for",
    ).toEqual([]);
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
