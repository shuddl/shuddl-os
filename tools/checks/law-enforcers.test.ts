import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §1394 (REQ-118) — EVERY NON-NEGOTIABLE RULE NAMES ITS ENFORCER, AND THE NAME IS CHECKED.
//
// §1035 answered "is the constitution actually enforced?" by mapping each of CLAUDE.md's ten non-negotiable
// rules to the thing that enforces it — eight commands or pinned tests, two that cannot be commands and are
// verified by reading. That map has lived as PROSE in the audit ever since, which means a renamed script, a
// deleted suite or a gate dropped from the merge roster would leave §1035's claim standing and false.
//
// WHY THIS GATE EXISTS AT ALL, and the motivation is embarrassing rather than theoretical: THREE times in one
// session I planted a violation and ran the WRONG gate. §1380 (twice: an excluded file, then a comment) and
// §1393 — where an `@anthropic-ai/sdk` import into `packages/ledger` was checked with `check:rater-purity`,
// which reported OK because its own message scopes it to `packages/rater/src`. The ledger half of REQ-024 is
// enforced by ESLint. A green from the wrong gate reads exactly like an unenforced law.
//
// The fix for "I did not know which gate owns this" is not more care. It is a map that is READ rather than
// remembered, and that fails when it stops being true.

interface Enforcer {
  readonly rule: number;
  readonly what: string;
  readonly enforcer: string;
  /** A SECOND file when one law bundles two clauses with different enforcers (§1421). Existence-checked. */
  readonly also?: string;
  /** `script` — a package.json script · `file` — a pinned test or module · `none` — no gate is possible. */
  readonly kind: "script" | "file" | "none";
  /** True when §1035 records this enforcer as part of the merge roster. */
  readonly inMergeRoster: boolean;
  readonly note?: string;
}

const LAW_ENFORCERS: readonly Enforcer[] = [
  {
    rule: 1,
    what: "Every PR references REQ-IDs",
    enforcer: "check:pr",
    kind: "script",
    inMergeRoster: false,
    note: "EXISTS, never executed — 0 PRs have ever been opened. §1035 verified the property by history instead: 224/224 product commits carry a REQ-ID. Deliberately absent from the merge roster; if it is ever wired, this row must say so.",
  },
  { rule: 2, what: "Events are append-only (I3/I7)", enforcer: "check:invariants", kind: "script", inMergeRoster: true },
  { rule: 3, what: "Gates are server-side (REQ-030)", enforcer: "check:chokepoint", kind: "script", inMergeRoster: true },
  { rule: 4, what: "No price on air (REQ-004)", enforcer: "check:rater-purity", kind: "script", inMergeRoster: true },
  {
    rule: 5,
    what: "Interline floors compare the executing share, never gross (REQ-040)",
    enforcer: "packages/rater/test/approval.test.ts",
    also: "packages/rater/test/anomaly.test.ts",
    kind: "file",
    inMergeRoster: false,
    note:
      "§1421 — CORRECTED. Law 5 bundles TWO clauses and they have DIFFERENT enforcers, which this row got " +
      "wrong: it stated the share-vs-gross clause and named the anomaly file. Measured by mutating the " +
      "interline branch of `assessApproval` to compare the GROSS: `approval.test.ts` reds FIVE, one of them " +
      "named \"PROOF the executing-share rule changed the outcome: gross alone would have been none\" — while " +
      "`anomaly.test.ts` stayed 18/18 GREEN. The $222,084 / 35-lb regression is a cents-per-lb detector; it " +
      "is permanent and it is a different mechanism. Both files are existence-checked below.",
  },
  { rule: 6, what: "Fixtures gate merges", enforcer: "check:fixtures", kind: "script", inMergeRoster: true },
  { rule: 7, what: "Design CI", enforcer: "audit:design", kind: "script", inMergeRoster: true, note: "blocking since WP-10 (§258)." },
  {
    rule: 8,
    what: "Tenant isolation suite on every merge (REQ-025)",
    enforcer: "tools/checks/isolation-suite.test.ts",
    kind: "file",
    inMergeRoster: false,
    note: "runs inside the unit-tests gate rather than as its own roster entry.",
  },
  {
    rule: 9,
    what: "Adversarial audit swarm at every WP exit (REQ-119)",
    enforcer: "(no gate possible)",
    kind: "none",
    inMergeRoster: false,
    note: "§1034 verified it by reading: 16/16 close-outs. A gate cannot observe whether a swarm was run, so this is recorded as unenforceable rather than pretended.",
  },
  {
    rule: 10,
    what: "No silent drops in migration",
    enforcer: "packages/adapters/src/legacy-mirror.ts",
    kind: "file",
    inMergeRoster: false,
    note: "pinned behaviour in the migrator + legacy-mirror suites; every unmapped column raises a gap row.",
  },
];

describe("§1394 REQ-118: every non-negotiable rule has a live, named enforcer", () => {
  const root = repoRoot();
  const claudeMd = readFileSync(`${root}/CLAUDE.md`, "utf8");

  it("the roster covers EVERY numbered rule the law states — derived, not assumed", () => {
    // The completeness half. §1035's claim is "ten rules, ten enforcers"; if CLAUDE.md grows an eleventh, that
    // claim silently becomes a statement about ten of eleven. The count comes from the LAW, never from here.
    const section = /## Non-negotiable engineering rules\n([\s\S]*?)\n## /.exec(claudeMd);
    expect(section, "the non-negotiable rules section is gone or renamed — that is a governance change").not.toBeNull();
    const numbered = [...section![1]!.matchAll(/^(\d+)\.\s+\*\*/gm)].map((m) => Number(m[1]));
    expect(numbered.length, "no numbered rules parsed — the matcher broke, not the constitution").toBeGreaterThanOrEqual(5);
    expect(
      LAW_ENFORCERS.map((e) => e.rule),
      "CLAUDE.md's numbered rules and this roster disagree. A rule without an enforcer row is a law nobody has " +
        "asked who enforces; an extra row here is an enforcer for a rule that no longer exists.",
    ).toEqual(numbered);
  });

  it("every script-kind enforcer is a real package.json script", () => {
    const scripts = (JSON.parse(readFileSync(`${root}/package.json`, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
    const missing = LAW_ENFORCERS.filter((e) => e.kind === "script" && !(e.enforcer in scripts)).map((e) => `rule ${e.rule} → ${e.enforcer}`);
    expect(
      missing,
      "a rule names an enforcing command that does not exist. Either the script was renamed and this roster " +
        "must follow, or the law is now enforced by nothing:\n  " + missing.join("\n  "),
    ).toEqual([]);
  });

  it("every file-kind enforcer still exists on disk", () => {
    const missing = LAW_ENFORCERS.flatMap((e) =>
      e.kind === "file"
        ? [e.enforcer, ...(e.also === undefined ? [] : [e.also])]
            .filter((f) => !existsSync(`${root}/${f}`))
            .map((f) => `rule ${e.rule} → ${f}`)
        : [],
    );
    expect(missing, `a rule's pinned enforcer file is gone:\n  ${missing.join("\n  ")}`).toEqual([]);
  });

  it("every enforcer §1035 records as a MERGE gate is still in the merge roster", () => {
    // The half that decays quietly: a gate can keep existing while being dropped from `gatesFor("merge")`,
    // and then the law is enforced only by whoever remembers to run it. §962 is this repo's record of a gate
    // step that existed and was skipped.
    const gate = readFileSync(`${root}/tools/release/run-gate.ts`, "utf8");
    const unwired = LAW_ENFORCERS.filter((e) => e.inMergeRoster && !gate.includes(`"${e.enforcer}"`)).map(
      (e) => `rule ${e.rule} → ${e.enforcer}`,
    );
    expect(
      unwired,
      "a rule's enforcer is no longer in the merge roster, so nothing runs it on a merge:\n  " + unwired.join("\n  "),
    ).toEqual([]);
  });

  it("every enforcer that is NOT a merge gate says why", () => {
    // Without this, `inMergeRoster: false` becomes the quiet default and the roster stops distinguishing
    // "deliberately not a merge gate" from "nobody checked".
    for (const e of LAW_ENFORCERS.filter((x) => !x.inMergeRoster)) {
      expect(e.note, `rule ${e.rule} (${e.enforcer}) is outside the merge roster with no stated reason`).toBeDefined();
      expect((e.note ?? "").length, `rule ${e.rule}'s reason is too short to be a reason`).toBeGreaterThan(40);
    }
  });
});
