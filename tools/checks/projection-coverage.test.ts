import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";
import { stripComments } from "./source-corpus.js";

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
    // §1507 — `.tsx?`; no projection is a component today, and the corpus should not be the thing that decides.
    .filter((f) => /\.tsx?$/.test(f) && !f.includes(".test."));
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
    // imports at workers/api/src/do/sequencer.ts:494@applyMessageProjection — so a roster of per-module
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

  it("every projection the sequencer IMPORTS is also CALLED there — imported is not called (§873)", () => {
    // §872's surviving trigger. A module can be imported and its statements dropped: `applyMoneyProjection`
    // RETURNS prepared statements that only matter once they are spread into the array handed to `db.batch()`.
    // Delete the spread and keep the import and nothing static objects — the projection runs, its statements
    // are discarded, and the table silently never fills. That is the same symptom as an unwired module, one
    // layer deeper.
    //
    // COMMENTS STRIPPED FIRST, via the repo's own helper. §872 is the reason: an ad-hoc `Symbol\s*\(` probe
    // counted a hazard note — "it would POISON projectMoneyLines (throw → DLQ)" — as a call site, and the
    // wrong claim reached a committed section AND a reopen trigger. `sweep-containment-coverage.test.ts`
    // already imported `stripComments` for exactly this; the solution existed and the throwaway probe skipped
    // it. The better a symbol is documented, the more false call sites it has.
    const seqPath = "workers/api/src/do/sequencer.ts";
    const code = stripComments(readFileSync(`${root}/${seqPath}`, "utf8"));

    const importedHere = new Set<string>();
    for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*\/projection\/[^"']*["']/g)) {
      for (const raw of (m[1] as string).split(",")) {
        const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim();
        if (name && /^(project|apply)[A-Z]/.test(name)) importedHere.add(name);
      }
    }

    expect(importedHere.size, "no projection entry points parsed from the sequencer — the scan is broken").toBeGreaterThanOrEqual(7);

    const uncalled = [...importedHere].filter((sym) => !new RegExp(`\\b${sym}\\s*\\(`).test(code));
    expect(
      uncalled,
      `${seqPath} imports a projection entry point it never calls. Either its statements are being dropped ` +
        "before `db.batch()` — a read-model that silently never fills, indistinguishable from an empty queue — " +
        "or the import is dead and should go:\n  " + uncalled.join("\n  "),
    ).toEqual([]);
  });

  it("ONE runtime composition root writes read-models — a second caller would break I1 (§874)", () => {
    // I1: "the projection and its event commit together or not at all." The sequencer guarantees that by
    // putting the event insert AND every projection statement into a single `db.batch()`. A second RUNTIME
    // caller would not — it would write a read-model row with no event behind it, which is exactly the state
    // ledger-is-truth exists to make impossible. Nothing structural prevented one from appearing.
    //
    // The correct alternative already exists and is worth naming, because it is what a new caller should copy:
    // `workers/agents/src/watchtower.ts` needs an authority flip, and rather than projecting, it appends an
    // `authority.flipped` event via `seq.append(...)` and lets the DO project it. §873 wrongly recorded that
    // file as a second composition root — it mentions `projectAuthority` only in comments (§874).
    const ALLOWED: Record<string, string> = {
      "workers/api/src/do/sequencer.ts":
        "THE composition root — event insert + every projection statement in one db.batch() (I1).",
      "tools/seed/load.ts":
        "build-time seed loader: it constructs the fixture, so there is no event to co-commit with.",
    };

    const entries = [...found.keys(), "applyMoneyProjection", "applyMessageProjection"];
    const files = execSync("git ls-files -- '*.ts' '*.tsx'", { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter(
        (f) =>
          f &&
          !/\.(test|spec)\./.test(f) &&
          !/(^|\/)(helpers|fixtures?)\.ts$/.test(f) &&
          !f.startsWith("packages/ledger/src/projection/"),
      );

    const callers = new Set<string>();
    for (const f of files) {
      const code = stripComments(readFileSync(`${root}/${f}`, "utf8"));
      if (entries.some((e) => new RegExp(`\\b${e}\\s*\\(`).test(code))) callers.add(f);
    }

    expect(callers.size, "no projection callers found at all — the scan is broken, not the tree").toBeGreaterThanOrEqual(2);
    const unexpected = [...callers].filter((f) => !(f in ALLOWED));
    expect(
      unexpected,
      "a file outside the sequencer writes a read-model projection. I1 requires the projection and its event " +
        "to commit together, and only the sequencer's single db.batch() does that — a second runtime writer " +
        "produces read-model rows with NO EVENT BEHIND THEM. If this file needs a projection change, append " +
        "the event instead and let the DO project it (workers/agents/src/watchtower.ts does exactly this via " +
        "seq.append). If it is genuinely build-time, add it to ALLOWED with its reason:\n  " +
        unexpected.join("\n  "),
    ).toEqual([]);

    for (const [f, why] of Object.entries(ALLOWED)) {
      expect(callers.has(f), `${f} is allowlisted but no longer calls a projection — delete the row ("${why.slice(0, 44)}…")`).toBe(true);
    }
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
