import { existsSync, globSync, readFileSync } from "node:fs";
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

/** Every place a gate could legitimately be wired, as one searchable corpus. */
function invocationCorpus(): string {
  const parts: string[] = [readFileSync("tools/release/run-gate.ts", "utf8")];
  for (const wf of globSync(".github/workflows/*.yml")) parts.push(readFileSync(wf, "utf8"));
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
    const workflows = globSync(".github/workflows/*.yml");
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
    const workflows = globSync(".github/workflows/*.yml");
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
    const live = new Set(globSync(".github/workflows/*.yml").flatMap((wf) => workflowGates(readFileSync(wf, "utf8"))));
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

  it("chains it with && so a tools failure fails the gate", () => {
    // `;` would run both and return only the last exit code; `||` would run the second ONLY on failure. Either
    // keeps the script present while destroying what it is for.
    expect(
      /test:tools\s*&&/.test(test),
      `the tools suite is no longer chained with && (script: "${test}"). A failing tools gate would then not ` +
        "fail `unit-tests`, which is the difference between running a check and enforcing one",
    ).toBe(true);
  });
});
