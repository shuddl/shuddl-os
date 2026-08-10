import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §870 — NO READ-MODEL PROJECTION SHIPS UNTESTED.
//
// §868 found `projectApprovals` and `projectAppointment` with no unit test, reached only through a happy-path
// integration test — so their tolerance branches (which protect APPEND availability) and their statement-shape
// laws (`OR IGNORE` not `REPLACE`; a plain `UPDATE` on the unguarded `legs` table, where a REPLACE is silent
// slot theft) were unreachable from any test in the repo. It found them BY HAND, and said so.
//
// A hand sweep is a measurement with an expiry (§838's lesson, and the exact shape of
// `sweep-containment-coverage.test.ts`, which this file mirrors: derive the population from source, prove the
// derivation is alive, then require each member to be named).
//
// §868 ALSO MISCOUNTED THE POPULATION IT WAS SWEEPING — it reported "six projections, four unit-tested" when
// there are EIGHT and six were tested. The finding (which two were dark) was right; the frame was wrong,
// because I counted from `projections.test.ts`'s import list rather than from the directory. That is the
// argument for this gate in one sentence: **a population derived from a consumer is not the population.**
//
// IMPORT, NOT MENTION. Coverage here requires a test to `import` the symbol. A prose mention is not a test —
// and this is not hypothetical: `approvals-projection.test.ts` NAMES `projectAppointment` in its header
// comment, so a mention-based check would have called `appointment.ts` covered before its suite existed.

// SCOPE IS TRACKED FILES, deliberately. `git ls-files` sees what MERGES; an untracked projection cannot reach
// main, so it is correctly invisible here. Recorded because it makes this gate's own mutation test subtle:
// dropping an untracked `decoy.ts` into the directory is SILENT, and the silence is the probe's fault, not the
// gate's (§870). `git add` it and both assertions fire, naming the symbol and its file.

/** Every read-model projection: a `project*` function exported from packages/ledger/src/projection. */
function projections(root: string): Map<string, string> {
  const files = execSync('git ls-files "packages/ledger/src/projection"', { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".ts") && !f.includes(".test."));
  const out = new Map<string, string>();
  for (const f of files) {
    for (const m of readFileSync(`${root}/${f}`, "utf8").matchAll(/^export function (project[A-Za-z]+)/gm)) {
      out.set(m[1] as string, f);
    }
  }
  return out;
}

/** Symbols a test file actually IMPORTS (any import form), never merely mentions. */
function importedByTests(root: string): Set<string> {
  const tests = execSync("git ls-files -- '*.test.ts' '*.test.tsx'", { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const imported = new Set<string>();
  for (const t of tests) {
    const text = readFileSync(`${root}/${t}`, "utf8");
    for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from/g)) {
      for (const raw of (m[1] as string).split(",")) {
        const name = raw.trim().split(/\s+as\s+/)[0]?.trim();
        if (name) imported.add(name);
      }
    }
  }
  return imported;
}

describe("§870: no read-model projection ships untested", () => {
  const root = repoRoot();
  const found = projections(root);
  const imported = importedByTests(root);

  it("derives the projections from SOURCE, and the derivation is alive (non-vacuity)", () => {
    // The failure this repo has met in four gates (§487/§554/§572): a renamed directory or a changed export
    // shape yields an empty map, and the completeness assertion below passes over nothing. The floor is the
    // measured population at §870 — if a projection is deleted, this fails and someone states why.
    expect(found.size, "no projections derived — the scan is broken, not the tree").toBeGreaterThanOrEqual(8);
    expect(
      [...found.keys()].sort(),
      "the projection roster changed; add the new one's test and update this pin",
    ).toEqual([
      "projectAgentRuns",
      "projectAppointment",
      "projectApprovals",
      "projectAuthority",
      "projectMessages",
      "projectMoneyLines",
      "projectPassport",
      "projectStatusCache",
    ]);
    expect(imported.size, "no imports parsed from the test corpus — the parser is broken").toBeGreaterThan(200);
  });

  it("every projection is IMPORTED by at least one test", () => {
    const missing = [...found.entries()].filter(([sym]) => !imported.has(sym)).map(([sym, f]) => `${sym}  (${f})`);
    expect(
      missing,
      "a read-model projection no test imports. §868 found two in this state and what it cost was not " +
        "coverage percentage: their TOLERANCE branches (a malformed event must project nothing rather than " +
        "throw — a throw breaks the APPEND, not the read) and their STATEMENT-SHAPE laws (`INSERT OR IGNORE` " +
        "never `REPLACE`; a plain `UPDATE` on `legs`, which is UNGUARDED, so a REPLACE is silent slot theft " +
        "no trigger would catch) were unreachable from every test in the repo. An integration test that " +
        "drives the happy path cannot reach either. Give it a unit test beside " +
        "packages/ledger/test/approvals-projection.test.ts:\n  " +
        missing.join("\n  "),
    ).toEqual([]);
  });

  it("every projection MODULE is imported by production code — tested is not wired (§871)", () => {
    // §870 closed by naming this gap: a projection can be exported, unit-tested and green here while NOTHING
    // CALLS IT — and the symptom in production is not an error, it is a read-model that silently never fills.
    // An empty approvals queue or an unclaimed dock slot looks exactly like "no work today".
    //
    // MODULE-level, not symbol-level, and that is the lesson from measuring this by hand first (§871): a
    // symbol probe for `projectMessages` reported NO PRODUCTION CALLER and was WRONG — that function is
    // internal, and the module's production entry point is `applyMessageProjection`, which the sequencer
    // imports at workers/api/src/do/sequencer.ts:482@applyMessageProjection — so a roster of per-module
    // entry-point names would rot, while "is this module imported by anything that ships" cannot, because it
    // asks about the file rather than about a name I guessed.
    const prodFiles = execSync("git ls-files -- '*.ts' '*.tsx'", { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter((f) => f && !/\.(test|spec)\./.test(f) && !f.startsWith("packages/ledger/src/projection/"));
    const prod = prodFiles.map((f) => readFileSync(`${root}/${f}`, "utf8")).join("\n");

    const orphaned = [...new Set(found.values())].filter((f) => {
      const stem = f.replace(/^.*\//, "").replace(/\.ts$/, "");
      return !new RegExp(`from\\s+["'][^"']*projection/${stem}(\\.js)?["']`).test(prod);
    });
    expect(
      orphaned,
      "a read-model projection nothing in production imports. It is dead code, or — worse — a table that " +
        "was meant to fill and never does, which surfaces as an empty queue rather than an error:\n  " +
        orphaned.join("\n  "),
    ).toEqual([]);
  });

  it("a MENTION does not count as coverage (the instrument's own failure mode, pinned)", () => {
    // `approvals-projection.test.ts` names `projectAppointment` in prose. Were this check mention-based, that
    // comment alone would have marked appointment.ts covered while its suite did not exist — the §845 shape
    // (detecting the claim rather than the thing). This asserts the parser reads imports, not text.
    const mentionOnly = "projectNothingAtAllXyz";
    const fakeTest = `// this file mentions ${mentionOnly} in a comment\nimport { somethingElse } from "./x.js";`;
    const names = new Set<string>();
    for (const m of fakeTest.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from/g)) {
      for (const raw of (m[1] as string).split(",")) names.add(raw.trim());
    }
    expect(names.has(mentionOnly), "a commented symbol must not read as imported").toBe(false);
    expect(names.has("somethingElse"), "and a real import must").toBe(true);
  });
});
