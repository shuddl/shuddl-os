import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gatesFor } from "../release/run-gate.js";

// EVERY GATE SCRIPT IS INVOKED BY SOMETHING (audit §289).
//
// The silent-absence shape from §288, one layer up. A test nobody collects is invisible; so is a GATE
// nobody runs. `pnpm check:foo` exists, passes by hand, gets cited in a runbook, and enforces nothing —
// and no gate can observe that, because the failure is the absence of an invocation.
//
// MEASURED CLEAN when this landed: all gate-shaped scripts are reachable by exactly one of three legitimate
// routes, and the three are different ON PURPOSE:
//   1. `tools/release/run-gate.ts` — the merge/release profiles, where most gates belong.
//   2. the CI workflow directly — for a gate whose INPUT only exists there (`check:pr` needs $PR_BODY, and
//      run-gate has no PR body to give it).
//   3. another script's command chain — for a gate that needs a BUILD before it can speak
//      (`deploy:surfaces` = build → `check:surfaces -- --built` → wrangler deploy).
//
// So "not in run-gate" is not by itself a defect; "in nothing" is. This pins the difference.

const PKG = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };

// The aggregate runners are the things that DO the invoking — they need no invoker of their own.
const RUNNERS = new Set(["verify", "verify:dev", "verify:merge", "verify:release", "test", "typecheck", "lint"]);

const gateScripts = (): string[] =>
  Object.keys(PKG.scripts)
    .filter((k) => /^(?:check|audit|test):/.test(k))
    .filter((k) => !RUNNERS.has(k))
    .sort();

/**
 * Every CI workflow. §695 — GitHub Actions accepts BOTH extensions, and four separate globs in this file
 * each hard-coded `*.yml`. A workflow named `.yaml` would have been invisible to all four at once: the
 * invocation corpus, the verify:merge pin (§691), the merge-path assertion (§694) and its staleness check.
 *
 * Shared rather than repeated, per this repo's own `share-lint-matchers-with-parity-tests` rule — four
 * hand-written copies of one matcher is exactly the drift that skill was written about, and here they were
 * copies of the thing that decides whether ANY of these assertions can see CI at all.
 */
function workflowFiles(): string[] {
  return [...globSync(".github/workflows/*.yml"), ...globSync(".github/workflows/*.yaml")].sort();
}

/** Every place a gate could legitimately be wired, as one searchable corpus. */
function invocationCorpus(): string {
  const parts: string[] = [readFileSync("tools/release/run-gate.ts", "utf8")];
  for (const wf of workflowFiles()) parts.push(readFileSync(wf, "utf8"));
  // Other scripts' command chains — excluding each script's OWN definition, which would make every
  // script trivially "referenced by itself" and the whole check vacuous.
  for (const [name, cmd] of Object.entries(PKG.scripts)) parts.push(`${name} ${cmd}`);
  return parts.join("\n");
}

/** Does anything other than `name`'s own definition invoke `name`? */
function isInvoked(name: string, corpus: string): boolean {
  const ownDefinition = `${name} ${PKG.scripts[name] ?? ""}`;
  return corpus
    .split("\n")
    .filter((line) => line !== ownDefinition)
    .some((line) => line.includes(name));
}

describe("REQ-118/119: no gate script is defined and never run", () => {
  const gates = gateScripts();
  const corpus = invocationCorpus();

  it("finds gate scripts and an invocation corpus at all (non-vacuity)", () => {
    // Without this, a renamed script section or a moved run-gate makes every assertion below pass on an
    // empty set — the same shape the gate exists to reject.
    expect(gates.length, "no gate-shaped scripts found in package.json").toBeGreaterThan(15);
    expect(corpus.length, "invocation corpus is empty").toBeGreaterThan(5000);
    expect(corpus).toContain("run-gate");
  });

  it("every check:/audit:/test: script is invoked by run-gate, CI, or another script", () => {
    const orphans = gates.filter((g) => !isInvoked(g, corpus));
    expect(
      orphans,
      `gate script(s) nothing invokes — a gate nobody runs enforces nothing:\n  ${orphans.join("\n  ")}`,
    ).toEqual([]);
  });

  // THE PROFILE SIZES ARE PINNED HERE BECAUSE THE DOCS CANNOT HOLD THEM (audit §293).
  //
  // `PROJECT-STATE.md` states the rule and had already been bitten by it: *"a hand-maintained count of a
  // list the build owns will always rot"* — three plain gates were added and every prose copy of "21 gates
  // (12 plain)" decayed silently, in a second document, unnoticed until swept.
  //
  // A count pinned in PROSE cannot fail. A count pinned HERE fails the moment the list changes, which puts
  // the doc update in front of the person who caused it — the §269 shape: make growth the thing that breaks.
  // These numbers are not a budget and carry no ceiling; they are a tripwire. When one changes legitimately,
  // update it AND the copies named in the failure message.
  // §807 — THE ROSTER BY NAME. The size tripwire above answers "how many gates are there"; it was never
  // meant to answer "is THIS gate still one of them", and its own comment says so ("not a budget… a
  // tripwire", pinned so the DOC counts cannot rot).
  //
  // §806 found the consequence for one gate and this is the sweep. MEASURED: swapping a gate off the merge
  // profile for a dummy — count preserved, the most ordinary commit shape imaginable — is SILENT for
  // `invariants`, `rater-purity`, `coverage` and `authority-coverage`. Those are the enforcement of, in
  // order: the I1–I8 schema invariants and the append-only guards (CLAUDE.md rule 2), REQ-024's "LLM calls
  // never in packages/ledger", the 100% register-coverage gate (REQ-118/119), and REQ-030's authority
  // registry. Each could leave the merge surface without one test failing.
  //
  // Asserted as an EXACT SET, both directions: a gate that vanishes fails, and a gate that appears fails
  // until someone adds it here deliberately. That second half is the point — the same philosophy as the size
  // tripwire, applied to identity instead of arithmetic.
  it("§807: the merge roster is exactly this set of gates, BY NAME", () => {
    const MERGE_ROSTER = [
      "runtime", "typecheck", "lint", "unit-tests", "invariants", "rater-purity", "append-chokepoint",
      "authority-coverage", "traceability", "coverage", "seed", "citations", "table-shape", "section-refs",
      "bundle-ratchet", "acceptance", "design-audit", "identity-leak", "fixtures", "rater-parity",
      "invoice-parity", "concierge-parse", "perf", "visual", "a11y", "e2e",
    ];
    expect(
      gatesFor("merge").map((g) => g.gate).sort(),
      "the merge gate roster changed. If a gate was ADDED, add it here and update the size tripwire + the doc " +
        "counts it names. If a gate VANISHED, that is the failure this exists to catch: a swap that preserves " +
        "the count is invisible to every other assertion in this file.",
    ).toEqual([...MERGE_ROSTER].sort());
  });

  // §808 — THE RELEASE-ONLY GATES, closing the residual §807 STATED rather than fixed.
  //
  // §807 pinned the merge roster and named what it left: *"the five release-only gates remain count-pinned…
  // the same sweep should be run for them before the first release."* §790's rule is that an identified gap
  // left open is worse than one never looked for, so it is closed here instead of filed.
  //
  // MEASURED: four of the five are SILENT to the same swap — `deploy-preflight`, `restore-verify`,
  // `staging-smoke`, `backup-manifest` (only `surfaces` was caught). These gate a DEPLOY rather than a merge,
  // which makes the exposure different in kind rather than smaller: `restore-verify` is the proof that a
  // backup actually restores, and a release that shipped without it would have no evidence its DR works —
  // discovered, if ever, on the day it is needed.
  //
  // Declared with a mixed shape (`kind: "cmd"` and one `kind: "external"`), so this asserts NAMES only; the
  // kinds are the size tripwire's business.
  it("§808: the release profile adds exactly these five gates, BY NAME", () => {
    const mergeSet = new Set(gatesFor("merge").map((g) => g.gate));
    const releaseOnly = gatesFor("release").map((g) => g.gate).filter((g) => !mergeSet.has(g));
    expect(
      [...releaseOnly].sort(),
      "the release-only gate set changed. These run at DEPLOY, not merge — `restore-verify` is the only proof " +
        "that a backup restores, and `deploy-preflight`/`staging-smoke` are the only checks between a green " +
        "merge and production. A swap that preserves the profile SIZE is invisible to every other assertion " +
        "in this file.",
    ).toEqual(["backup-manifest", "deploy-preflight", "restore-verify", "staging-smoke", "surfaces"]);
  });

  // §809 — THE KIND IS PART OF A GATE'S IDENTITY, and the name rosters do not cover it.
  //
  // §808 closed with this edge stated: the §807/§808 rosters assert NAMES, so a gate changing `kind` slips
  // through. That is not cosmetic. `kind: "external"` short-circuits execution entirely —
  // `run-gate.ts:170@external` pushes `{status: "BLOCKED", executed: false, assertions: 0}` and `continue`s.
  // BLOCKED is a non-failing state (it means "blocked on input this repo cannot supply"), so flipping a gate
  // to external converts it from an ENFORCED check into a permanently-blocked non-check that still appears
  // on the board.
  //
  // MEASURED: flipping `append-chokepoint` is caught — but only INCIDENTALLY, by the orphan-script test above,
  // because `check:append-chokepoint` then has no invoker. Flipping **`typecheck`** is **SILENT**, because CI
  // also runs that script directly so it never orphans. The escape hatch is therefore open for exactly the
  // most fundamental gates — the ones whose scripts are run in more than one place.
  //
  // Asserted as an exact set rather than per-gate: `backup-manifest` is the ONLY gate that legitimately
  // cannot run in-repo (OIDC/external backup credentials). Every other gate must be a `cmd` that executes.
  it("§809: `backup-manifest` is the ONLY external gate — every other gate must actually RUN", () => {
    const external = gatesFor("release").filter((g) => g.kind === "external").map((g) => g.gate);
    expect(
      [...external].sort(),
      "a gate's kind changed to `external`. That is not a relabelling: an external gate never executes — it " +
        "reports BLOCKED with executed:false, assertions:0, and BLOCKED does not fail the aggregate. So the " +
        "gate stays on the board, stops enforcing anything, and no other assertion notices (the orphan-script " +
        "test only catches it when the script has no other invoker). If a gate genuinely cannot run in-repo, " +
        "add it here with the reason; otherwise it must remain a `cmd`.",
    ).toEqual(["backup-manifest"]);
    // The merge profile must contain NO external gates at all — everything it runs, it runs.
    expect(
      gatesFor("merge").filter((g) => g.kind === "external").map((g) => g.gate),
      "the merge profile gained an external (non-executing) gate",
    ).toEqual([]);
  });

  it("profile sizes match the docs that quote them", () => {
    const merge = gatesFor("merge").length;
    const release = gatesFor("release").length;
    const where = "update docs/ops/PROJECT-STATE.md ('do not trust a count written here') and docs/ops/RELEASE-EVIDENCE.md ('Counts:')";
    // 25→26 / 30→31 on 2026-08-07 (audit §509): the `section-refs` gate joined `plain`.
    // 24→25 / 29→30 on 2026-08-06 (audit §483): `bundle-ratchet` joined `plain`, which BOTH profiles
    // include. This tripwire fired on the first run after the gate was added — the §269 shape working as
    // designed, and the reason the doc counts below were corrected in the same commit as the gate.
    expect(merge, `merge profile size changed — ${where}`).toBe(26);
    expect(release, `release profile size changed — ${where}`).toBe(31);
    // Release is a strict superset: a gate that runs at merge must not vanish at release.
    const mergeGates = new Set(gatesFor("merge").map((g) => g.gate));
    const releaseGates = new Set(gatesFor("release").map((g) => g.gate));
    for (const g of mergeGates) expect(releaseGates.has(g), `${g} runs at merge but not at release`).toBe(true);
  });

  it("the self-reference escape is closed (a script cannot invoke itself)", () => {
    // Proves the previous assertion is not passing merely because each script's own definition mentions
    // its own name. A synthetic script referenced NOWHERE else must read as an orphan.
    const synthetic = "check:__nothing_invokes_this";
    const withSynthetic = `${corpus}\n${synthetic} tsx tools/checks/nothing.ts`;
    expect(withSynthetic.includes(synthetic)).toBe(true);
    const lines = withSynthetic.split("\n").filter((l) => l !== `${synthetic} tsx tools/checks/nothing.ts`);
    expect(lines.some((l) => l.includes(synthetic))).toBe(false);
  });
});

// REQ-118 §656 — THE `unit-tests` GATE MUST STILL REACH THE TOOLS SUITE.
//
// §655 measured that this session's ten gate files are on the merge path, and named the single point of
// failure it rests on: `unit-tests` runs the `test` script, and `test` is
//
//     pnpm run test:tools && pnpm -r --if-present run test
//
// The `&&` is load-bearing twice over. Drop `test:tools` from that chain and **every** gate under `tools/`
// detaches from the merge gate at once — 44 test files today, including all ten added this session — while
// `verify:merge` still reports `unit-tests PASS`, because the second half alone exits 0. Replace `&&` with
// `;` or `||` and a failing tools suite stops failing the gate.
//
// Nothing asserted either property. `test-collection.test.ts` describes the chain in a COMMENT (§288) and
// `RUNNERS` above contains the string "test" as a gate NAME, which is a different claim entirely.
//
// This is §634's shape — a guarantee resting on one line in one file — applied to the line that carries this
// audit's own output.
describe("REQ-118 §656: the test script still chains the tools suite", () => {
  const test = PKG.scripts["test"] ?? "";

  it("§691: CI invokes verify:merge — the whole 26-gate surface hangs on this one step", () => {
    // THE OUTERMOST WIRING, and until now the only unasserted one. `invocationCorpus()` above proves each
    // gate script is invoked SOMEWHERE — but "somewhere" includes run-gate.ts, so every gate stays
    // "invoked" even if CI never runs run-gate at all. The corpus cannot distinguish "wired into the
    // aggregate" from "the aggregate is wired into CI".
    //
    // MEASURED: replacing `run: pnpm verify:merge` in ci.yml with an echo left test:tools at exactly the
    // same 3 known failures. The entire merge surface — every gate this audit hardened — could be deleted
    // from CI and nothing anywhere would notice. That is §634's shape (a guarantee resting on one line in a
    // composition root) at the outermost layer, where it is worth the most.
    // A LITERAL pin, not a coverage computation — stated because it has one honest false positive: swapping
    // the step to `verify:release` runs a SUPERSET (release = plain + skippable + releaseInfra) and would
    // still fail here. That is deliberate. The release profile BLOCKS in CI without a deployed environment,
    // so the swap is not a real alternative, and pinning the literal keeps the failure message specific
    // instead of asking the reader to reason about profile subsets at 3am.
    const workflows = workflowFiles();
    expect(workflows.length, "no workflows found — this assertion cannot see CI, so its silence means nothing").toBeGreaterThan(0);
    const invoked = workflows
      .map((wf) => readFileSync(wf, "utf8"))
      .some((y) => /run:\s*pnpm\s+(?:-s\s+)?verify:merge\b/.test(y));
    expect(
      invoked,
      "no workflow runs `pnpm verify:merge`. Every gate in the merge profile — the append chokepoint, tenant " +
        "isolation, the design audit, the browser gates — runs in CI ONLY because that step exists. Without " +
        "it CI still passes on whatever individual steps remain, and the 26-gate surface silently becomes " +
        "advisory",
    ).toBe(true);
  });

  /**
   * Gate-shaped scripts a workflow may run WITHOUT being on the merge path, each with the reason its input
   * cannot exist there. §694 — an exemption, so it carries a reason and a staleness check like every other
   * allowlist in this repo (§636/§666/§672).
   */
  const SANCTIONED_CI_ONLY: ReadonlyMap<string, string> = new Map([
    [
      "check:pr",
      "REQ-118 — reads $PR_BODY for the PR's REQ-IDs. That input exists only in a pull-request context, so " +
        "run-gate cannot invoke it and the merge profile cannot contain it.",
    ],
  ]);

  // §1320 — THE PREFIX SET IS A SEMANTIC FILTER, AND ITS LIMIT IS MEASURED RATHER THAN GUESSED.
  //
  // These five prefixes separate GATES from operational jobs, which is a judgement no name can fully carry.
  // Widening the filter to "any defined script" was measured and rejected: `pnpm backup` runs in a workflow,
  // IS a defined script, and is a scheduled operational job rather than coverage — it would land in
  // `soleCoverage` as pure noise, which is how a gate earns deletion (§1053).
  //
  // WHAT ESCAPES, stated exactly (measured §1320): the workspace defines 16 script prefixes and this
  // recognises 5, and **4 of the 30 merge-gate scripts are bare-named** — `typecheck`, `lint`, `test`,
  // `preflight` — so an invocation of those is invisible here. Harmless today, because all four ARE merge
  // scripts and would pass the assertion anyway. The live risk is the other direction: a future workflow gate
  // named outside these prefixes (`typecheck:strict`, a bare `securityscan`) is never tested for merge-path
  // membership, and its silence is indistinguishable from compliance. The naming convention this rests on is
  // enforced NOWHERE — grepped, §1320. A gate whose name breaks it must be added to the prefix list here.
  /** Gate-shaped pnpm invocations in a workflow, excluding the `verify:*` aggregates themselves. */
  function workflowGates(yml: string): string[] {
    return [...yml.matchAll(/run:\s*pnpm (?:-s )?(?:exec )?([a-z0-9:_-]+)/g)]
      .map((m) => m[1]!)
      .filter((n) => /^(check|audit|test|perf|smoke):/.test(n));
  }

  it("§693/§694: every gate ANY workflow runs is on the merge path or sanctioned (cadence, never sole coverage)", () => {
    // §692 measured that neutering nightly's `check:traceability` step is undetected — then found the
    // severity bounded, because that script is ALSO a merge gate, so its loss costs the nightly CADENCE and
    // not the COVERAGE. §691's step, by contrast, was the sole path for 26 gates. Same mutation result, an
    // order of magnitude apart, separated only by a fact neither file asserted. This is that fact, asserted.
    //
    // §694 widens it from `nightly.yml` to EVERY workflow. The first cut named one file by path, which is
    // the same literal-pin limit §691 carries: a third workflow would inherit nothing. Globbing closes both.
    const workflows = workflowFiles();
    expect(workflows.length, "no workflows found — this assertion cannot see CI, so its silence means nothing").toBeGreaterThan(1);
    const mergeScripts = new Set([...readFileSync("tools/release/run-gate.ts", "utf8").matchAll(/script: "([^"]+)"/g)].map((m) => m[1]!));
    expect(mergeScripts.size, "no gate scripts parsed from run-gate.ts — the scan broke").toBeGreaterThan(20);

    const soleCoverage: string[] = [];
    for (const wf of workflows) {
      for (const g of workflowGates(readFileSync(wf, "utf8"))) {
        if (mergeScripts.has(g) || SANCTIONED_CI_ONLY.has(g)) continue;
        soleCoverage.push(`${wf}: ${g}`);
      }
    }
    expect(
      soleCoverage,
      "a workflow runs a gate the merge profile does NOT, so that workflow is its only path and its deletion " +
        "would be silent — the shape §691 closed for verify:merge. Either add it to the merge profile, give " +
        "it its own wiring assertion, or add it to SANCTIONED_CI_ONLY naming the input that cannot exist " +
        "outside CI:\n  " +
        soleCoverage.join("\n  "),
    ).toEqual([]);
  });

  it("§694: nothing sits in SANCTIONED_CI_ONLY that no workflow runs", () => {
    // §"record holds with expiry triggers" — an exemption outliving its subject is a standing excuse.
    const live = new Set(workflowFiles().flatMap((wf) => workflowGates(readFileSync(wf, "utf8"))));
    const stale = [...SANCTIONED_CI_ONLY.keys()].filter((k) => !live.has(k));
    expect(stale, `SANCTIONED_CI_ONLY excuses a script no workflow runs — delete the entry:\n  ${stale.join("\n  ")}`).toEqual([]);
  });

  it("runs test:tools", () => {
    expect(
      test,
      "the `test` script no longer runs `test:tools`. Every gate under tools/ — 44 files — detaches from the " +
        "`unit-tests` merge gate silently, because the remaining half exits 0 on its own",
    ).toContain("test:tools");
  });

  // §940 — TWO PROPERTIES, NOT ONE OPERATOR.
  //
  // ~~§656 required `test:tools &&`~~ — superseded on the MECHANISM, not the property. §656 mutated `&&` → `;`
  // and correctly found it fatal: a bare `;` returns only the LAST command's exit code, so a failing tools
  // suite stops failing the gate. Its fix bought POLARITY with `&&`, which also buys short-circuit — free at
  // the time, because `test:tools` passed.
  //
  // It stopped being free. `test:tools` now carries a persistent owner-held red (the REQ-289 register row), so
  // `&&` meant `pnpm -r run test` had not executed in the `unit-tests` merge gate at all. MEASURED AT §940: a
  // failing test planted in `packages/ledger` was INVISIBLE to `pnpm test` (0 hits) and visible once both exit
  // codes were aggregated (3) — 3,269 tests across 17 suites, every one green, not being run. A real
  // regression was indistinguishable from the known row.
  //
  // So both properties are asserted directly instead of being inferred from an operator:
  //   COMPLETENESS — both halves run unconditionally.
  //   POLARITY     — either half failing fails the gate (§656's property, kept).
  // A mechanism assertion cannot report that it has stopped buying what it was bought for.

  // §941 — THE CLASS, NOT THE INSTANCE. §940 asserted these two properties against `test` alone. Counting all
  // 30 specs in gatesFor() found exactly one other gate script built the same way — `typecheck` — so the rule
  // is stated over a ROSTER, and the roster's completeness is derived from gatesFor() below rather than
  // trusted. Two of thirty: the class is closed, not sampled.
  //
  // `typecheck` PASSES today, so it was masking nothing; §940's `test` had a persistent red in its first half
  // and was hiding 3,269 tests. That is the whole lesson — `&&` is safe exactly while the first half has no
  // durable red, which is a property of the repo's ledger of open rows and NOT of the script. Nobody filing a
  // red can be expected to re-derive it, so it is a gate.
  const TWO_HALF_GATES: { script: string; toolsHalf: string; recursiveHalf: string }[] = [
    { script: "test", toolsHalf: "test:tools", recursiveHalf: "--if-present run test" },
    { script: "typecheck", toolsHalf: "typecheck:tools", recursiveHalf: "--if-present run typecheck" },
  ];

  it("§941: the roster covers every gate script that chains internally (no new instance escapes)", () => {
    // The discovery half. A third two-half gate added later must join the roster or fail here — otherwise the
    // rule below silently applies to a shrinking fraction of the gates it claims to govern (§"floor the input").
    const gateScripts = [...gatesFor("merge"), ...gatesFor("release")].flatMap((g) => (g.kind === "cmd" ? [g.script] : []));
    const chaining = [...new Set(gateScripts)].filter((s) => {
      const cmd = PKG.scripts[s];
      // Match the SHAPE, not one flag order. The first version required the contiguous string
      // "pnpm -r --if-present run", so adding --no-bail/--workspace-concurrency (§949) made this
      // discovery half find ZERO chaining scripts — the rule would have silently governed nothing.
      return typeof cmd === "string" && /pnpm\s+-r\b/.test(cmd) && /--if-present\s+run/.test(cmd);
    });
    const unrostered = chaining.filter((s) => !TWO_HALF_GATES.some((g) => g.script === s));
    expect(
      unrostered,
      "gate script(s) run a tools half and a recursive half but are not in TWO_HALF_GATES, so §940/§941's " +
        "completeness and polarity rules do not reach them:\n  " +
        unrostered.join("\n  "),
    ).toEqual([]);
    expect(chaining.length, "no two-half gate scripts found at all — the scan is broken, not package.json").toBeGreaterThanOrEqual(2);
  });

  it.each(TWO_HALF_GATES)("§940/§941: `$script` runs both halves unconditionally (completeness)", ({ script, toolsHalf, recursiveHalf }) => {
    const cmd = PKG.scripts[script] as string;
    expect(cmd, `the \`${script}\` script no longer runs \`${toolsHalf}\``).toContain(toolsHalf);
    expect(cmd, `the \`${script}\` script no longer runs its recursive half (script: "${cmd}")`).toContain(recursiveHalf);
    expect(
      new RegExp(`${toolsHalf}\\s*&&`).test(cmd),
      `\`${script}\` chains ${toolsHalf} with && (script: "${cmd}"). That short-circuits: while ${toolsHalf} ` +
        "fails, the recursive half does not run AT ALL, so a real failure anywhere in the packages renders " +
        `identically to the first half's failure. §940 measured exactly that on \`test\` — 3,269 tests across ` +
        "17 suites, every one green, not being run, behind the owner's REQ-289 row. Capture both exit codes.",
    ).toBe(false);
  });

  it.each(TWO_HALF_GATES)("§949: `$script` reports EVERY package, not just up to the first failure", ({ script }) => {
    // §940 named this residual and accepted it after watching `--no-bail` cascade workerd socket failures.
    // That experiment changed TWO variables: §949 measured them apart and the cascade was CONCURRENCY, not
    // no-bail. Without `--no-bail`, `pnpm -r` stops at the first failing package — MEASURED: one planted
    // failure in `packages/contracts` left only **3 of 17** suites reporting, with api (824 tests), ledger
    // (697), rater, billing, mcp, translator, agents and all three app surfaces never executed. The gate's
    // coverage then depends on where in the topological order the first failure lands, not on the gate.
    const cmd = PKG.scripts[script] as string;
    expect(
      cmd,
      `\`${script}\` does not pass --no-bail to its recursive half (script: "${cmd}"). pnpm then bails at the ` +
        "first failing package and the rest of the workspace is never run — §949 measured 3 of 17 suites " +
        "reporting. For `test` this must be paired with --workspace-concurrency=1: running every " +
        "vitest-pool-workers suite at once exhausts workerd's local sockets and cascades FALSE failures " +
        "(§940 measured that). `typecheck` needs no-bail alone; tsc binds no sockets.",
    ).toContain("--no-bail");
  });

  it.each(TWO_HALF_GATES)("§656/§940/§941: `$script` fails if EITHER half fails (polarity)", ({ script, toolsHalf }) => {
    // §656's property, preserved under the new mechanism. A bare `;` returns only the LAST command's exit code
    // and silently discards the first half's failure — §656's M158 mutation, which remains fatal.
    const cmd = PKG.scripts[script] as string;
    const captured = new RegExp(`${toolsHalf}\\s*;\\s*(\\w+)=\\$\\?`).exec(cmd);
    expect(
      captured,
      `\`${script}\` neither chains with && nor captures ${toolsHalf}' exit status (script: "${cmd}"). A bare ` +
        "`;` returns only the LAST command's code, so the first half would run and be ignored — §656's M158, " +
        "the difference between running a check and enforcing one.",
    ).not.toBeNull();
    const v = (captured as RegExpExecArray)[1] as string;
    expect(
      cmd,
      `\`${script}\` captures ${toolsHalf}' status into $${v} but never uses it in its exit — the capture is ` +
        "decoration, and a failing first half still exits 0.",
    ).toMatch(new RegExp(`exit\\s+\\$\\(\\(\\s*${v}\\s*\\|\\|`));
  });
});
