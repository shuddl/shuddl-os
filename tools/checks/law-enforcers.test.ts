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
  /**
   * §1423 — HOW THIS ROW WAS CONFIRMED, by BREAKING the clause the `what` states and recording which file
   * noticed. §1180 audited this map by checking every enforcer EXISTS and passed all ten; §1421 and §1422
   * then found THREE rows naming evidence that does not enforce the stated clause. Existence cannot tell
   * those apart. Required on every row, so a new law cannot be added with an unproven enforcer.
   */
  readonly proven: string;
  /** `script` — a package.json script · `file` — a pinned test or module · `none` — no gate is possible. */
  readonly kind: "script" | "file" | "none";
  /** True when §1035 records this enforcer as part of the merge roster. */
  readonly inMergeRoster: boolean;
  readonly note?: string;
}

const LAW_ENFORCERS: readonly Enforcer[] = [
  {
    rule: 1,
    proven:
      "NOT PROVEN BY MUTATION — `check:pr` has never executed (0 PRs opened). §1035 verified the property by history instead: 224/224 product commits carry a REQ-ID. This row is the one honest gap in the map.",
    what: "Every PR references REQ-IDs",
    enforcer: "check:pr",
    kind: "script",
    inMergeRoster: false,
    note: "EXISTS and IS WIRED, but has never executed — 0 PRs have ever been opened. §1035 verified the property " +
      "by history instead: 224/224 product commits carry a REQ-ID. §1427 sharpened the second half of this " +
      "note, which read \"deliberately absent from the merge roster; if it is ever wired, this row must say " +
      "so\" and invited the reading that nothing runs it. It is absent from `gatesFor(\"merge\")` — correctly, " +
      "since its input does not exist locally — AND `.github/workflows/ci.yml:32` runs it under " +
      "`if: github.event_name == 'pull_request'` with $PR_BODY. So \"never executed\" is a fact about the PR " +
      "count, not about the wiring: the first PR ever opened runs it.",
  },
  { rule: 2, proven: "§1414/§1416 — planted `INSERT OR REPLACE INTO events` and `DROP TRIGGER events_guard_upd` in application source; check:invariants exits 1 (and exited 0 before §1414/§1416 closed those routes).", what: "Events are append-only (I3/I7)", enforcer: "check:invariants", kind: "script", inMergeRoster: true },
  { rule: 3, proven: "§1415 — planted a raw `INSERT INTO events` outside the sequencer; check:chokepoint exits 1. §1418/§1419 additionally mutation-proved all ten gate bodies AND their call sites.", what: "Gates are server-side (REQ-030)", enforcer: "check:chokepoint", kind: "script", inMergeRoster: true },
  {
    rule: 4,
    proven:
      "§1422 — disabled the UNKNOWN short-circuit in priceShipment so the engine prices on air: check:rater-purity stayed at exit 0 and `price.test.ts` red 5. The script holds REQ-004s purity half; `also` holds the stated clause.",
    what: "No price on air (REQ-004)",
    enforcer: "check:rater-purity",
    also: "packages/rater/test/price.test.ts",
    kind: "script",
    inMergeRoster: true,
    note:
      "§1422 — rule 4 bundles TWO clauses with different enforcers, the same shape §1421 found in rule 5. " +
      "The SCRIPT holds REQ-004's purity half (class is an isolated edge adapter, never the engine " +
      "foundation; no LLM in the rater) and stays the merge-roster entry. The STATED clause — missing " +
      "weight/dims ⇒ UNKNOWN, no sell — is held by the test in `also`. Measured: disabling the UNKNOWN " +
      "short-circuit in `priceShipment` so the engine prices on air leaves `check:rater-purity` at EXIT 0 " +
      "while `price.test.ts` reds five, including \"a non-number weight ⇒ UNKNOWN/missing_physics — never a " +
      "price, never a throw\".",
  },
  {
    rule: 5,
    proven:
      "§1421 — changed assessApprovals interline branch to compare the GROSS: approval.test.ts red 5 (incl. the named PROOF case) while anomaly.test.ts stayed 18/18 green.",
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
  { rule: 6, proven: "§1423 — set a vendored fixtures sha256 to zeroes: check:fixtures escalates from BLOCKED (exit 2, pending private fixtures) to FAIL (exit 1) in BOTH plain and merge mode.", what: "Fixtures gate merges", enforcer: "check:fixtures", kind: "script", inMergeRoster: true },
  { rule: 7, proven: "§1423 — planted a tracked component carrying boxShadow, borderRadius 12 and two raw hexes: audit:design exits 1 naming each (`no shadows (REQ-147)`, `12px > 4px`, `outside the five tokens (REQ-145)`), in .tsx AND .css.", what: "Design CI", enforcer: "audit:design", kind: "script", inMergeRoster: true, note: "blocking since WP-10 (§258)." },
  {
    rule: 8,
    proven:
      "§1423 — removed a roster member (workers/mcp/test/isolation.test.ts): three cases red, incl. `the suites aggregate case count has not fallen` and `no INDIVIDUAL files proofs fell — redistribution is not a defence`.",
    what: "Tenant isolation suite on every merge (REQ-025)",
    enforcer: "tools/checks/isolation-suite.test.ts",
    kind: "file",
    inMergeRoster: false,
    note: "runs inside the unit-tests gate rather than as its own roster entry.",
  },
  {
    rule: 9,
    proven:
      "NOT PROVEN BY MUTATION, and unprovable: a gate cannot observe whether an adversarial swarm was run. §1034 verified it by reading 16/16 close-outs. Recorded as unenforceable rather than pretended.",
    what: "Adversarial audit swarm at every WP exit (REQ-119)",
    enforcer: "(no gate possible)",
    kind: "none",
    inMergeRoster: false,
    note: "§1034 verified it by reading: 16/16 close-outs. A gate cannot observe whether a swarm was run, so this is recorded as unenforceable rather than pretended.",
  },
  {
    rule: 10,
    proven:
      "§1422 — deleted the unmapped-column `gapRows.push` in migrator.ts so a legacy column silently disappears: exactly ONE test red, `THE LAW — a rate sheet flags EVERY non-rate column`.",
    what: "No silent drops in migration",
    enforcer: "packages/adapters/test/migrator.test.ts",
    also: "packages/adapters/src/legacy-mirror.ts",
    kind: "file",
    inMergeRoster: false,
    note:
      "§1422 — CORRECTED IN KIND. This named `legacy-mirror.ts`, which is the IMPLEMENTATION: the row " +
      "pointed at the thing being enforced rather than at the evidence it is. Measured by deleting the " +
      "unmapped-column `gapRows.push` in `migrator.ts` so a legacy column silently disappears: exactly ONE " +
      "test reds — \"THE LAW — a rate sheet flags EVERY non-rate column + the unconsumed rows (no silent " +
      "drop)\" in `migrator.test.ts`, now the enforcer. `legacy-mirror.ts` is kept in `also` because it " +
      "carries the same law for the continuous feed. ONE test defends a constitutional rule; that is a " +
      "defence, and it is thin enough to say out loud.",
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
    // §1422 — `also` is ALWAYS a file path, whatever the row's kind, so it is checked for every row. It was
    // checked only on `kind: "file"` rows for one commit, which left rule 4's second enforcer — a script row
    // carrying a test file — declared and unverified. An unchecked declaration is a comment.
    const missing = LAW_ENFORCERS.flatMap((e) => [
      ...(e.kind === "file" ? [e.enforcer] : []),
      ...(e.also === undefined ? [] : [e.also]),
    ].filter((f) => !existsSync(`${root}/${f}`)).map((f) => `rule ${e.rule} → ${f}`));
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

  it("§1423: every row records how it was CONFIRMED, not merely that its enforcer exists", () => {
    // §1180 audited this map by checking each enforcer EXISTS and passed all ten. §1421 and §1422 then found
    // THREE rows naming evidence that does not enforce the clause the row states — rule 4, 5 and 10. Existence
    // cannot distinguish "this file enforces the law" from "this file is adjacent to the law". Only breaking
    // the stated clause can, so every row must say what breaking it did.
    for (const e of LAW_ENFORCERS) {
      expect(e.proven, `rule ${e.rule} does not record how it was confirmed`).toBeTruthy();
      expect(
        e.proven.length,
        `rule ${e.rule}'s confirmation is too short to name a mutation and its result`,
      ).toBeGreaterThan(80);
    }
    // The eight gate-able rules must each cite the section that BROKE them. Rules 1 and 9 are the declared
    // exceptions and must say so in those words, so a future row cannot quietly join them.
    // Keyed on the explicit marker, NOT on the presence of a `§NNNN` — rules 1 and 9 legitimately cite the
    // sections that verified them by other means (history, reading), so a section reference cannot separate
    // "confirmed by mutation" from "confirmed some other way". A semantic distinction needs a marker.
    const byMutation = LAW_ENFORCERS.filter((e) => !e.proven.startsWith("NOT PROVEN"));
    expect(
      byMutation.map((e) => e.rule),
      "the set of rules confirmed by breaking their stated clause has changed. Eight of ten are provable; " +
        "rules 1 (check:pr has never executed) and 9 (a gate cannot observe an audit swarm) are not, and each " +
        "says so in its own row.",
    ).toEqual([2, 3, 4, 5, 6, 7, 8, 10]);
    for (const e of LAW_ENFORCERS.filter((x) => x.proven.startsWith("NOT PROVEN"))) {
      expect(e.proven.length, `rule ${e.rule} claims NOT PROVEN without saying why`).toBeGreaterThan(120);
    }
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
