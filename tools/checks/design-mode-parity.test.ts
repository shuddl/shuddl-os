import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §939 — THE DESIGN GATE'S BLOCKING MODE IS CONSTITUTIONAL LAW, SO IT MAY NOT BE A FREE VARIABLE.
//
// CLAUDE.md rule 7, genesis/11 §44 and genesis/14 §62 all state the same thing: the design audit BLOCKS
// merges as of the WP-10 exit. The mechanism is four lines of JSON with exactly one consumer:
//
//     tools/design/audit.ts:333   const { mode } = JSON.parse(readFileSync(".../design-ci.json"))
//     tools/design/audit.ts:351   if (mode === "blocking") process.exit(1);
//
// MEASURED AT §939 — flipping "blocking" → "advisory":
//   - is SILENT: `test:tools` failed only on the known REQ-289 trio (1,169 passed), `audit:design` exit 0,
//     `check:invariants` exit 0. Nothing in the repo read the word.
//   - and DEFEATS the gate: a `box-shadow` planted in `packages/design/motion.css` (CLAUDE.md's 0-shadows
//     budget) exits **1** under blocking and **0** under advisory — while STILL PRINTING
//     "design audit: 2 violation(s) [mode=advisory]". The report is right and the exit code is wrong, so a
//     human reading logs sees the refusal and CI reading $? sees success.
//
// §252 planted violations and watched them go RED; §258 read that the config says "blocking". Both are true.
// Neither asked whether the CONFIGURATION HOLDS — a gate proved correct and a gate proved durable are
// different claims, and repealing this law needs no code change at all, just a JSON one-liner.
//
// SHAPE (§830): the DOC states the law and the CONFIG implements it, so this parses the mode CLAUDE.md
// asserts and requires the config to MATCH — never a third stored copy of the word "blocking". Flipping
// either side fails here, which puts a deliberate change in front of a reviewer as a two-file commit.

const LAW = "CLAUDE.md";
const CONFIG = "tools/design/design-ci.json";
const AUDIT = "tools/design/audit.ts";

/** The mode CLAUDE.md rule 7 asserts the config carries — the law, parsed from the governing doc. */
function modeAssertedByLaw(root: string): string | null {
  const claudeMd = readFileSync(`${root}/${LAW}`, "utf8");
  // Matches rule 7's `tools/design/design-ci.json` is `{"mode":"blocking"}` (whitespace-tolerant).
  const m = /design-ci\.json`?\s*is\s*`?\{\s*"mode"\s*:\s*"(\w+)"/.exec(claudeMd);
  return m === null ? null : (m[1] as string);
}

describe("§939: the design gate's blocking mode matches the law that states it", () => {
  const root = repoRoot();
  const configured = (JSON.parse(readFileSync(`${root}/${CONFIG}`, "utf8")) as { mode?: string }).mode;
  const asserted = modeAssertedByLaw(root);

  it("both sides parse (non-vacuity — two failed reads agree about nothing)", () => {
    // Without this, a reworded rule 7 or a restructured config yields null/undefined and the equality below
    // passes over nothing: the §487/§554/§572 failure, and the one this repo keeps re-meeting.
    expect(
      asserted,
      `${LAW} rule 7 no longer states a design-ci mode where this gate reads it. Either the law moved (update ` +
        "this matcher) or it was removed (which is a governance change, not a refactor).",
    ).not.toBeNull();
    expect(configured, `${CONFIG} has no "mode" key`).toBeDefined();
  });

  it("the configured mode IS the mode the law asserts", () => {
    expect(
      configured,
      `${CONFIG} says "${configured}" but ${LAW} rule 7 states "${asserted}".\n` +
        "§939 measured what the difference buys: a planted box-shadow exits 1 under blocking and 0 under " +
        'advisory, while still printing "design audit: N violation(s)". So this one word decides whether ' +
        "pixel law gates merges at all, and flipping it touches no code and no test.\n" +
        "If the law is genuinely changing, change BOTH — CLAUDE.md rule 7 (striking the old clause, not " +
        "deleting it, per its own precedent) and this config, in one commit.",
    ).toBe(asserted);
  });

  it('"blocking" still means the process exits non-zero', () => {
    // Guards the other repeal route: leave the word alone and hollow out what it does. A mode that is
    // honoured by no branch is a §688 "hollowed roster" — the shape §926 measured, where the loud failure
    // (deletion) is caught and the quiet one (gutting) is not.
    const audit = readFileSync(`${root}/${AUDIT}`, "utf8");
    expect(
      audit,
      `${AUDIT} no longer exits non-zero in blocking mode. The config can then say "blocking" while the ` +
        "gate reports violations and returns 0 — which is exactly the failure §939 caught, reached from " +
        "the other side.",
    ).toMatch(/if\s*\(\s*mode\s*===\s*"blocking"\s*\)\s*process\.exit\(\s*[1-9]/);
  });

  it("design-audit is a non-skippable merge gate (rule 7's second clause)", () => {
    // Rule 7 states two things. The mode makes a violation fail the audit; this makes the audit reach the
    // merge. Both are required for "a violation fails the merge" and only one of them is the JSON file.
    const runGate = readFileSync(`${root}/tools/release/run-gate.ts`, "utf8");
    const entry = /\{[^{}]*gate:\s*"design-audit"[^{}]*\}/.exec(runGate);
    expect(entry, "design-audit is no longer declared in gatesFor() at all").not.toBeNull();
    expect(
      (entry as RegExpExecArray)[0],
      "design-audit gained `modeArg: true`, which moves it into run-gate's SKIPPABLE list — rule 7 requires " +
        "it non-skippable, so a pixel violation would stop failing merges even with mode=blocking intact.",
    ).not.toContain("modeArg");
  });
});
