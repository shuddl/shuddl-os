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
// §1504 — KEYED BY FILE, not by name alone. `assertNever` exists TWICE in production source, so a row keyed
// only on the name exempted both copies the moment the population saw the second one — an exemption written
// for one subject silently covering another that shares its identifier.
const DECLARED: readonly { readonly file: string; readonly fn: string; readonly covered_by: string; readonly why: string }[] = [
  {
    file: "workers/api/src/gate-context.ts",
    fn: "assertPositionConsent",
    covered_by: "workers/api/test/positions-gate.test.ts",
    why:
      "REQ-166 consent-before-GPS on the positions route, which writes the guarded `positions` table outside " +
      "the event chokepoint. Driven through the route rather than called directly; that suite posts with NO " +
      "consent record and asserts the refusal REASON, not just the status (§81).",
  },
  {
    file: "workers/agents/src/index.ts",
    fn: "assertNever",
    covered_by: "tools/checks/gate-roster.test.ts",
    why:
      "the agents worker's exhaustiveness helper, and it is module-PRIVATE — no test can import it, and no " +
      "message can reach it, because the AgentTrigger schema rejects a foreign kind as poison long before " +
      "dispatch. Its runtime path opens only on a schema/switch DESYNC. Covered instead by the static case " +
      "below, which requires every `x: never` helper to THROW: that is the property a future edit could break " +
      "(the sequencer's exported twin IS called directly, by workers/api/test/gates.test.ts). §1504 removed " +
      "the previous row here, which claimed a test would only be 'asserting the type checker' — gates.test.ts " +
      "calls the twin and asserts its RUNTIME throw, so that reason was contradicted by an existing test.",
  },
  {
    file: "packages/ledger/src/geo/fence.ts",
    fn: "assertIntCoord",
    covered_by: "packages/ledger/test/fence.test.ts",
    why:
      "REQ-065's microdegree coordinate guard, driven BEHAVIOURALLY through insideFence rather than by name: " +
      "that suite's 'malformed input throws' case reds when the guard is deleted (measured §1504). Same form " +
      "as assertPositionConsent above — behavioural coverage, named here so the roster does not demand a " +
      "mention that would add nothing.",
  },
];

// §1504 — THE POPULATION WAS SCOPED BY A SYNTAX. This matched `export function assert…` only, which is
// §1419's defect one level down: there a PATH decided membership, here the `export` keyword did. Measured at
// §1504: **5** `assert*` functions in production source are module-private and were therefore invisible —
// `assertIntCoord`, `assertNonNegInt`, `assertPosInt`, `assertBps`, and a SECOND `assertNever` (the agents
// worker's copy of the sequencer's exhaustiveness helper). Mutating all five: `assertIntCoord` and `assertBps`
// red, and **three did not** — two rater param guards whose only case used a bare `.toThrow()` that a
// downstream layer also satisfied, and the agents `assertNever`, watched by nothing at all.
//
// Being unexported makes a gate LESS visible, not less load-bearing: it is still the only place its rule runs.
function gateFunctions(root: string): { file: string; fn: string }[] {
  const files = execSync(`git ls-files ${PRODUCTION_TREES.join(" ")}`, { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => (f.endsWith(".ts") || f.endsWith(".tsx")) && !f.includes(".test.") && !f.includes("/test/"));
  return files.flatMap((file) =>
    [...readFileSync(`${root}/${file}`, "utf8").matchAll(/(?:export\s+)?(?:async\s+)?function\s+(assert\w+)/g)].map((m) => ({
      file,
      fn: m[1] as string,
    })),
  );
}

/** Every exhaustiveness helper — a function whose parameter is typed `never` — with the body that follows it. */
function neverHelpers(root: string): { file: string; fn: string; body: string }[] {
  const files = execSync(`git ls-files ${PRODUCTION_TREES.join(" ")}`, { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => (f.endsWith(".ts") || f.endsWith(".tsx")) && !f.includes(".test.") && !f.includes("/test/"));
  const out: { file: string; fn: string; body: string }[] = [];
  for (const file of files) {
    const text = readFileSync(`${root}/${file}`, "utf8");
    for (const m of text.matchAll(/function\s+(\w+)\s*\(\s*\w+\s*:\s*never\s*\)[^{]*\{/g)) {
      const start = (m.index ?? 0) + m[0].length;
      // §1378 — DELIMITED STRUCTURALLY, never by a fixed line window: the body runs to this function's own
      // closing brace at column 0. A fixed reach would read a neighbour's `throw` on a long body (silent
      // false PASS) or miss one on a short file that ends first.
      const end = text.indexOf("\n}", start);
      out.push({ file, fn: m[1] as string, body: text.slice(start, end === -1 ? text.length : end) });
    }
  }
  return out;
}

describe("§1418 REQ-030: every server-side gate is named by a test", () => {
  const root = repoRoot();
  const gates = gateFunctions(root);
  const testFiles = execSync("git ls-files packages workers apps", { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => f.includes(".test."));

  it("derives a real population (non-vacuity — an empty roster certifies everything)", () => {
    // §1387: floor the INPUT. There were TEN at §1418; a broken extractor reporting zero would pass every
    // assertion below while checking nothing.
    expect(
      gates.length,
      "no gate functions found — the extractor broke, not the tree. LIVE COUNT 23 (§1504: 18 exported + 5 " +
        "module-private, after the `export`-scoped population was widened; was 18 at §1419/§1437); " +
        "the floor is 15, deliberately below it and far above zero: a TRIPWIRE for a broken extractor, not a " +
        "gate count anyone must maintain. Deleting a gate should fail the roster tests below, not this one.",
    ).toBeGreaterThanOrEqual(15);
    expect(
      testFiles.length,
      "no test files found — the scan broke, not the tree. LIVE COUNT ~410 (§1428's board); the floor is 50, " +
        "orders of magnitude below it: a tripwire for a broken `git ls-files`, never a coverage assertion.",
    ).toBeGreaterThan(50);
  });

  it("no gate is unnamed by every test in the repo", () => {
    const bodies = testFiles.map((f) => readFileSync(`${root}/${f}`, "utf8"));
    const orphans = gates
      .filter((g) => !bodies.some((b) => b.includes(g.fn)))
      .filter((g) => !DECLARED.some((d) => d.fn === g.fn && d.file === g.file))
      .map((g) => `${g.file} :: ${g.fn}`);
    expect(
      orphans,
      "a server-side gate is named by no test. CLAUDE.md rule 3 makes these the ONLY place a rule is " +
        "enforced, so an untested one is a law with no evidence it fires. Mutation-check it — make it a " +
        "no-op and confirm its suite reds — rather than adding a mention that merely satisfies this list:\n  " +
        orphans.join("\n  "),
    ).toEqual([]);
  });

  // §1504 — the exhaustiveness helpers, checked STATICALLY because one of them cannot be reached any other way.
  //
  // Both copies exist to make a schema/switch desync loud: a new union member with no dispatch case stops
  // compiling (belt), and if it ever ran it throws (suspenders). The compile half needs no test — it is the
  // type checker. The RUNTIME half is a real property that an edit can silently remove, and it was: neutering
  // the agents worker's copy (`return undefined as never`) left that suite 145/145 green, because its own
  // helper is module-private and its trigger schema rejects a foreign kind as poison before dispatch.
  //
  // A no-op exhaustiveness helper is worse than none: the desync it exists to catch becomes a FALL-THROUGH,
  // which for the agents queue means an unhandled trigger is silently ACKed instead of retried to the DLQ.
  it("every exhaustiveness helper (`x: never`) THROWS — a no-op one turns a desync into a silent fall-through", () => {
    const helpers = neverHelpers(root);
    // LIVE, MEASURED at §1504: exactly 2 — workers/api/src/do/sequencer.ts and workers/agents/src/index.ts.
    expect(helpers.length, "no `x: never` helper found — the extractor broke, not the tree").toBeGreaterThanOrEqual(2);
    const silent = helpers.filter((h) => !/\bthrow\b/.test(h.body)).map((h) => `${h.file} :: ${h.fn}`);
    expect(
      silent,
      "an exhaustiveness helper does not throw. Its compile-time half still works, but the day a union member " +
        "arrives without a dispatch case in a build that skipped typecheck, the runtime falls THROUGH instead " +
        "of failing loudly — for the agents queue that is a silent ack of an unhandled trigger:\n  " + silent.join("\n  "),
    ).toEqual([]);
  });

  it("every DECLARED exemption names a subject that exists and a file that covers it", () => {
    // §1359 — no exemption outlives its subject; and a declaration nobody checks is just a comment that
    // silences a gate. Both halves are asserted: the function must still be in the derived population, and
    // the file said to cover it must exist and MENTION the subject it is credited with.
    const keys = new Set(gates.map((g) => `${g.file}::${g.fn}`));
    for (const d of DECLARED) {
      expect(keys.has(`${d.file}::${d.fn}`), `DECLARED names ${d.file}::${d.fn}, which is no longer a gate — delete the row`).toBe(true);
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
