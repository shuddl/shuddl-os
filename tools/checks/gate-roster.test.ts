import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

const GATES_DIR = "packages/ledger/src/gates";

function exportedGates(root: string): { file: string; fn: string }[] {
  const files = execSync(`git ls-files ${GATES_DIR}`, { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".ts") && !f.includes(".test."));
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
    expect(gates.length, "no gate functions found — the extractor broke, not the tree; there were 10 at §1418").toBeGreaterThanOrEqual(8);
    expect(testFiles.length, "no test files found — the scan broke").toBeGreaterThan(50);
  });

  it("no gate is unnamed by every test in the repo", () => {
    const bodies = testFiles.map((f) => readFileSync(`${root}/${f}`, "utf8"));
    const orphans = gates.filter((g) => !bodies.some((b) => b.includes(g.fn))).map((g) => `${g.file} :: ${g.fn}`);
    expect(
      orphans,
      "a server-side gate is named by no test. CLAUDE.md rule 3 makes these the ONLY place a rule is " +
        "enforced, so an untested one is a law with no evidence it fires. Mutation-check it — make it a " +
        "no-op and confirm its suite reds — rather than adding a mention that merely satisfies this list:\n  " +
        orphans.join("\n  "),
    ).toEqual([]);
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
