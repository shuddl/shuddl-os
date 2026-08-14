import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §1418 (REQ-030 / CLAUDE.md law 3) — EVERY SERVER-SIDE GATE IS NAMED BY A TEST.
//
// §1418 mutation-tested all ten `assert*` gates in `packages/ledger/src/gates/` by making each a no-op and
// running its owning suite. All ten are DEFENDED — 5 to 20 tests red per gate. That is the strongest form of
// the claim CLAUDE.md rule 3 makes ("gates are server-side; UIs merely reflect them"), and it was verified by
// disabling the gate rather than by reading its tests.
//
// A mutation sweep cannot run in CI — it edits source. What CAN run is the cheap half: an ELEVENTH gate must
// not arrive with no test at all. This roster derives the population FROM THE TREE (§1376's rule, after six
// hand-counts came up short) and decides membership by whether any test file names the function. It is
// deliberately weaker than the sweep: naming is not proving. It exists so the sweep's result cannot silently
// stop describing the tree, and its failure message says what to do — run the sweep, do not just add a
// mention.

// §1419 — THE POPULATION IS A BEHAVIOUR, NOT A DIRECTORY. This scanned `packages/ledger/src/gates/` for one
// phase, which is §1376's error in the file that cites §1376: the tree supplied the population but a PATH
// decided membership. Measured at §1419: **18** exported `assert*` functions live in production source and
// **8 of them are outside that directory** — `assertPositionConsent` (REQ-166, the consent gate the positions
// route runs because it writes the guarded `positions` table OUTSIDE the event chokepoint),
// `assertNotPlatformTenant`, `assertHazmatEnabled`, `assertProofToCashEntitled`, `assertGrantedReceipt`,
// `assertViewBudget`. A roster that exists to notice an eleventh gate arriving untested could not see six
// that had already arrived.
//
// MEMBERSHIP HAS TWO FORMS, and conflating them is how the first version would have cried wolf. A gate can be
// pinned BY NAME (a test imports and calls it) or BY BEHAVIOUR (a suite drives the route and asserts the
// refusal). `assertPositionConsent` is named by ZERO tests and is nonetheless one of the best-covered gates
// here: `workers/api/test/positions-gate.test.ts` posts without consent and asserts the REASON rather than
// merely a 403, because §81 established that a wrong-reason pass on a security test is indistinguishable from
// a right one. Requiring a NAME would have flagged it and taught the next person to add a mention.
const PRODUCTION_TREES = ["workers", "packages", "apps"];

/** Gates whose coverage is BEHAVIOURAL, or which are not gates at all. Each names the file that proves it. */
const DECLARED: readonly { readonly fn: string; readonly covered_by: string; readonly why: string }[] = [
  {
    fn: "assertPositionConsent",
    covered_by: "workers/api/test/positions-gate.test.ts",
    why:
      "REQ-166 consent-before-GPS on the positions route, which writes the guarded `positions` table outside " +
      "the event chokepoint. Driven through the route rather than called directly; that suite posts with NO " +
      "consent record and asserts the refusal REASON, not just the status (§81).",
  },
  {
    fn: "assertNever",
    covered_by: "workers/api/src/do/sequencer.ts",
    why:
      "not a gate — the TypeScript exhaustiveness helper. It refuses at COMPILE time, so a test that calls it " +
      "would be asserting the type checker. Declared rather than pattern-excluded so the exemption is one " +
      "named function instead of a rule that could quietly widen.",
  },
];

function exportedGates(root: string): { file: string; fn: string }[] {
  const files = execSync(`git ls-files ${PRODUCTION_TREES.join(" ")}`, { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => (f.endsWith(".ts") || f.endsWith(".tsx")) && !f.includes(".test.") && !f.includes("/test/"));
  return files.flatMap((file) =>
    [...readFileSync(`${root}/${file}`, "utf8").matchAll(/export\s+(?:async\s+)?function\s+(assert\w+)/g)].map((m) => ({
      file,
      fn: m[1] as string,
    })),
  );
}

describe("§1418 REQ-030: every server-side gate is named by a test", () => {
  const root = repoRoot();
  const gates = exportedGates(root);
  const testFiles = execSync("git ls-files packages workers apps", { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => f.includes(".test."));

  it("derives a real population (non-vacuity — an empty roster certifies everything)", () => {
    // §1387: floor the INPUT. There were TEN at §1418; a broken extractor reporting zero would pass every
    // assertion below while checking nothing.
    expect(gates.length, "no gate functions found — the extractor broke, not the tree; there were 18 at §1419").toBeGreaterThanOrEqual(15);
    expect(testFiles.length, "no test files found — the scan broke").toBeGreaterThan(50);
  });

  it("no gate is unnamed by every test in the repo", () => {
    const bodies = testFiles.map((f) => readFileSync(`${root}/${f}`, "utf8"));
    const orphans = gates
      .filter((g) => !bodies.some((b) => b.includes(g.fn)))
      .filter((g) => !DECLARED.some((d) => d.fn === g.fn))
      .map((g) => `${g.file} :: ${g.fn}`);
    expect(
      orphans,
      "a server-side gate is named by no test. CLAUDE.md rule 3 makes these the ONLY place a rule is " +
        "enforced, so an untested one is a law with no evidence it fires. Mutation-check it — make it a " +
        "no-op and confirm its suite reds — rather than adding a mention that merely satisfies this list:\n  " +
        orphans.join("\n  "),
    ).toEqual([]);
  });

  it("every DECLARED exemption names a subject that exists and a file that covers it", () => {
    // §1359 — no exemption outlives its subject; and a declaration nobody checks is just a comment that
    // silences a gate. Both halves are asserted: the function must still be in the derived population, and
    // the file said to cover it must exist and MENTION the subject it is credited with.
    const names = new Set(gates.map((g) => g.fn));
    for (const d of DECLARED) {
      expect(names.has(d.fn), `DECLARED names ${d.fn}, which is no longer an exported gate — delete the row`).toBe(true);
      expect(existsSync(`${root}/${d.covered_by}`), `${d.fn}'s covering file ${d.covered_by} is gone`).toBe(true);
      expect(d.why.length, `${d.fn}'s reason is too short to be a reason`).toBeGreaterThan(60);
    }
    // The behavioural claim, checked rather than trusted: the suite credited with `assertPositionConsent`
    // must actually drive consent. A declaration that points at an unrelated file is worse than none.
    const pos = DECLARED.find((d) => d.fn === "assertPositionConsent");
    expect(
      readFileSync(`${root}/${pos!.covered_by}`, "utf8"),
      "the file credited with covering the REQ-166 consent gate does not mention consent",
    ).toContain("consent");
  });

  it("the roster still covers the gates §1418 mutation-proved", () => {
    // A rename is the realistic way this decays: the sweep's result is recorded against these ten NAMES, and
    // a renamed gate would leave the record describing something that no longer exists (§1359).
    const PROVEN = [
      "assertPodSigned",
      "assertAppointment",
      "assertBookingCredit",
      "assertBookingRecipientContact",
      "assertConsentBeforeGps",
      "assertDelivery",
      "assertDispatch",
      "assertException",
      "assertInterline",
      "assertPickupDepart",
    ];
    const names = new Set(gates.map((g) => g.fn));
    const gone = PROVEN.filter((p) => !names.has(p));
    expect(
      gone,
      "a gate §1418 mutation-proved no longer exists under that name. If it was renamed, update this list AND " +
        "re-run the sweep; if it was deleted, the audit's claim about ten gates must be corrected:\n  " + gone.join("\n  "),
    ).toEqual([]);
  });
});
