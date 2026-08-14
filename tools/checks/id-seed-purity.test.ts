import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";
import { SOURCE_SCAN_GLOBS, isTestPath, stripComments } from "./source-corpus.js";

// §1460 (REQ-118/REQ-039) — A DETERMINISTIC ID IS ONLY AS DETERMINISTIC AS ITS SEED.
//
// The repo's at-least-once guarantee is built on seeded ids: Cloudflare Queues redeliver, and every agent stays
// idempotent by minting an id a redelivery REPRODUCES EXACTLY, so the sequencer DO dedupes on it and returns the
// original append. That derivation is pure by convention — `uuidFromSeed("biller:invoice-event:" + podEventId)`
// — and convention is the whole of the enforcement.
//
// WHY A STATIC GATE AND NOT A RUNTIME ONE. The obvious pin is "call it twice and compare", and the repo had
// exactly that: `expect(await invoiceEventIdFor("pod-evt-42")).toBe(await invoiceEventIdFor("pod-evt-42"))`,
// named *"a redelivered POD re-derives the SAME invoice event id"*. Both calls land in the SAME MILLISECOND, so
// folding a clock into the seed leaves it green — **measured at §1460: 142/142 in the owning worker, the entire
// suite**. A same-tick comparison cannot see a clock BY CONSTRUCTION; only elapsed time perturbs it. That test is
// now fixed too (it moves `Date.now` between the calls), but the fix is per-call-site and there are 24 seeds
// across five workers. This gate is the class-wide half: it reads the SEED, where the hazard is written, so it
// cannot go vacuous for the reason the runtime assertion did.
//
// WHAT IT IS NOT. Only seeds written as a TEMPLATE LITERAL at the call site are visible here. A seed built into a
// variable first (`const seed = ...; uuidFromSeed(seed)`) is invisible to a static scan — those are counted and
// floored below rather than silently treated as absent, the §1426 discipline. Comments are stripped first, so
// prose ABOUT `Date.now()` next to a seed is not a finding (§1416: a scanner that flags its own message).

/** Impurity written directly into the seed — each defeats redelivery dedupe outright. */
const IMPURE = /Date\.now\(\)|new Date\b|Math\.random\(\)|crypto\.randomUUID\(\)|performance\.now\(\)/;

/**
 * A clock reaching the seed through a VARIABLE. Injected clocks are the repo's convention (`now` is a dep, never
 * read from wall-clock inside a domain function), so this cannot be a blanket ban — it is a "declare it" rule.
 */
const CLOCKISH = /\$\{\s*(now|nowMs|timestamp|ts|at|atMs)\s*\}/;

/** Seeds that deliberately fold a clock. Each must still exist and still be clock-bearing (§1426). */
const DECLARED_IMPURE: readonly { readonly file: string; readonly why: string }[] = [
  {
    file: "workers/agents/src/mirror-sweep.ts",
    why:
      "The `lgm_gap_` anomaly id folds the injected `now` ON PURPOSE — the gap rows are a RECURRING MONITOR " +
      "('these columns still map to nothing'), so a later sweep must re-raise rather than dedupe. The file " +
      "states the rule in both directions: `writeQuarantine` is idempotent by CONTENT and says *'NOT the " +
      "clock — contrast the gap rows, which fold the clock to re-raise every sweep'*, and the loop itself is " +
      "headed 'LAW 2'. A same-tick retry still dedupes; only a later tick re-raises. This is the one seed in " +
      "the repo where redelivery-stability is NOT the goal, and it is the reason this gate declares exceptions " +
      "instead of banning the shape.",
  },
];

interface Seed {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function seeds(root: string): { readonly literal: Seed[]; readonly indirect: number; readonly files: number } {
  const files = execSync(`git ls-files -- ${SOURCE_SCAN_GLOBS.map((g) => `'${g}'`).join(" ")}`, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
    .split("\n")
    .filter((f) => f !== "" && !isTestPath(f));

  const literal: Seed[] = [];
  let indirect = 0;
  for (const file of files) {
    const src = stripComments(readFileSync(`${root}/${file}`, "utf8"));
    for (const m of src.matchAll(/\b(?:uuidFromSeed|sha256Hex)\(\s*(`[^`]*`)?/g)) {
      if (m[1] === undefined) {
        indirect += 1; // a variable, a call, or bytes — not statically readable
        continue;
      }
      literal.push({ file, line: src.slice(0, m.index).split("\n").length, text: m[1] });
    }
  }
  return { literal, indirect, files: files.length };
}

describe("§1460 REQ-039: no deterministic-id seed carries a clock or a random draw", () => {
  const root = repoRoot();
  const { literal, indirect, files } = seeds(root);

  it("derives a real corpus (§1148: a floor must bound the corpus READ, not the hits found)", () => {
    // Both floors are stated because they fail differently: a collapsed FILE count means the glob roster or
    // `git ls-files` broke, a collapsed SEED count means the call pattern did. LIVE, MEASURED at §1460:
    // **337 files, 24 literal seeds, 34 indirect** — the indirect number was written as "13" from memory before
    // it was run, and it is 34, which is the §1437 defect (a floor whose message names a quantity nobody
    // measured sends the next reader somewhere false). Floors sit well below so ordinary churn never trips them.
    //
    // "34 invisible seeds" would be the alarming reading, and it is wrong — the number was CLASSIFIED before it
    // was allowed to stand (§1345). Of the 34: ~18 are the two primitives' own plumbing (`sha256Hex(s)` inside
    // `uuidFromSeed`, `uuidFromSeed(seed)` inside each worker's wrapper) where the real seed is the CALLER's
    // template literal and IS scanned; ~13 hash CONTENT BYTES (evidence bytes, an SPKI device key, canonical
    // event bytes, a position row) which are supposed to be content-derived and for which a clock would be a
    // different bug entirely; leaving roughly THREE genuinely opaque string variables. The reach gap is ~3, not
    // 34. Stating it the other way would make this gate read as mostly-blind when it is nearly complete.
    expect(files, "the shared SOURCE_SCAN_GLOBS corpus collapsed — the roster broke, not the repo").toBeGreaterThan(200);
    expect(literal.length, "no template-literal seed found — the call pattern changed and this gate reads nothing").toBeGreaterThanOrEqual(15);
    expect(indirect, "the indirect count collapsed; if seeds stopped being built in variables that is a REAL change, confirm it").toBeGreaterThanOrEqual(5);
  });

  it("no seed reads a clock or randomness directly", () => {
    const bad = literal.filter((s) => IMPURE.test(s.text)).map((s) => `${s.file}:${s.line}  ${s.text}`);
    expect(
      bad,
      "a deterministic-id seed reads the clock or a random draw, so a queue REDELIVERY mints a DIFFERENT id. " +
        "The sequencer dedupes on the event id, so the duplicate is appended to an append-only ledger where it " +
        "cannot be removed (I3/I7 — only a correcting event); and where the id also keys an outbound " +
        "idempotency key (`evidence-email/<invoice event id>`) the customer is emailed twice. Seed from the " +
        "trigger's event id instead — that is what makes the retry reproduce the original:\n  " +
        bad.join("\n  "),
    ).toEqual([]);
  });

  it("a seed folding an injected clock is DECLARED, with why", () => {
    const undeclared = literal
      .filter((s) => CLOCKISH.test(s.text))
      .filter((s) => !DECLARED_IMPURE.some((d) => d.file === s.file))
      .map((s) => `${s.file}:${s.line}  ${s.text}`);
    expect(
      undeclared,
      "a seed interpolates a clock-valued variable. That is legitimate ONLY for an id meant to RE-RAISE rather " +
        "than dedupe (a recurring monitor). If that is the intent, declare it in DECLARED_IMPURE with the " +
        "reason; if it is not, the id is not redelivery-stable:\n  " + undeclared.join("\n  "),
    ).toEqual([]);
  });

  it("every declared exception still exists and still folds a clock (no exemption outlives its subject)", () => {
    for (const d of DECLARED_IMPURE) {
      const still = literal.some((s) => s.file === d.file && CLOCKISH.test(s.text));
      expect(still, `${d.file} no longer has a clock-folding seed — delete the exemption, the gate can enforce it directly`).toBe(true);
      expect(d.why.length, `${d.file}'s reason is too short to be a reason`).toBeGreaterThan(120);
    }
  });

  it("both detectors fire on a planted seed (positive control — §1387)", () => {
    // A gate whose green means "found nothing" must prove it can find something. Without this, narrowing either
    // regex to nothing would read exactly like a clean repo.
    for (const planted of ["`biller:invoice-event:${podEventId}:${Date.now()}`", "`x:${Math.random()}`", "`y:${crypto.randomUUID()}`"]) {
      expect(IMPURE.test(planted), `IMPURE missed ${planted}`).toBe(true);
    }
    expect(CLOCKISH.test("`${tenant}:${now}:${g.reason}`"), "CLOCKISH missed an injected clock").toBe(true);
    expect(IMPURE.test("`biller:invoice-event:${podEventId}`"), "IMPURE fired on a pure seed").toBe(false);
    expect(CLOCKISH.test("`biller:invoice-event:${podEventId}`"), "CLOCKISH fired on a pure seed").toBe(false);
    // `now` must match as a WHOLE interpolation, never as a substring of a legitimate name.
    expect(CLOCKISH.test("`${knownShipper}:${nowhere}`"), "CLOCKISH matched a substring — it would cry wolf").toBe(false);
  });
});
