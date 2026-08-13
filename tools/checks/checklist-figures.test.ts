import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { repoRoot } from "./repo-root.js";

// §933 — A CHECKLIST FIGURE THAT NOBODY RE-DERIVES IS A CLAIM WITH AN EXPIRY AND NO ALARM.
//
// The repo-owned section of GO-LIVE-CHECKLIST carries 35 eight-field rows, each with an explicit "Evidence expires"
// field naming what would falsify it. Those fields have exactly the standing of a reopen trigger: written
// once at the moment the row was filed, and run never.
//
// MEASURED AT §932: three were re-checked — the ones whose expiry condition names a NUMBER, so it is
// decidable in one command — and TWO had moved. The CONFIRM-GATED count had drifted 14 → 15 (the row's own
// trigger said "when the count changes materially"), and a row asserting "no tolerance implementation in
// tools/ or packages/" was simply false: `parity.ts@PARITY_TOLERANCE_BPS` is typed, tested, and its own
// header claims to BE rule 6's routes gate.
//
// This pins the figures so that decay is loud instead of silent. Each is DERIVED from source here and
// compared to what the checklist states — §830's rule: read one side and COMPUTE the other, never store
// both. A row that changes now fails HERE, in front of whoever changed it.
//
// SCOPE, STATED HONESTLY. This covers the THREE figures §932 verified, not all 35 rows. Most expiry
// conditions name a DECISION ("when the parenthetical is marked illustrative"), which no gate can evaluate.
// A discovery half — "find every numeric claim in the checklist" — is the §831/§833 shape and was measured
// there to produce eight false positives and zero real ones on prose of this kind, which is the profile of
// a gate people learn to silence. So this is a roster, deliberately, and its own incompleteness is the
// reopen trigger rather than a pretence of coverage.

const CHECKLIST = "docs/ops/GO-LIVE-CHECKLIST.md";

/**
 * §1077 — the number of sweeps riding the agents worker's single cron, DERIVED from the containment calls.
 *
 * Added because this figure drifted for ~800 sections in the way §1076 caught: `watchtower-snapshots` became
 * the eighth sweep, §248 corrected the count in `sla-sweep.ts`, and the SIBLING copy in `do/sequencer.ts` kept
 * saying "seven". The corrected file even carried a note about having been corrected — and nothing connected
 * the two. That is §797's pin-the-siblings rule failing in its usual direction, and a roster gate is the only
 * thing that makes the copies unable to disagree.
 *
 * MATCHER: `[^"]+`, NOT `[a-z-]+`. Measured at §1077 — the first version used a lowercase-and-hyphen class,
 * and a planted ninth sweep named `probe9` was INVISIBLE to it: the gate stayed GREEN while the comments
 * were stale. That is §1064's character-class bug reproduced in a gate written ONE PHASE after documenting
 * it — a class chosen from the names that exist today, excluding one the generator can emit.
 *
 * The count matters beyond tidiness: two open rows (the 4h SLA policed by a daily tick, and the unbackstopped
 * booking trigger) both argue FROM it — "all N sweeps ride this one cron" is the cost side of the cadence
 * decision, and "none of the N crons reconciles bookings" is the completeness claim.
 */
function containedSweeps(root: string): number {
  // §1278 — comments STRIPPED before matching. This counted raw text, so a commented-out `contain("…")` still
  // counted: measured by commenting one out, the derived count stayed at 8 and this gate stayed GREEN while
  // that sweep no longer rode the cron. The number is not cosmetic — two open GO-LIVE rows argue FROM it
  // ("all N sweeps ride this one cron" is the cadence cost; "none of the N reconciles bookings" is the
  // completeness claim), so an inflated N weakens both arguments silently. Same defect §1277 fixed in the
  // acceptance floor; the rule is that an UNANCHORED source-text count must strip comments, while a
  // line-anchored one (`/^\s+it\(/m`, isolation-suite) is immune by construction.
  const src = readFileSync(`${root}/workers/agents/src/index.ts`, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/gm, "$1");
  return new Set([...src.matchAll(/contain\("([^"]+)"/g)].map((m) => m[1] as string)).size;
}

/** Every file that STATES the sweep count in prose. A copy not listed here is the next §1076. */
const SWEEP_COUNT_FILES = [
  "workers/agents/src/sla-sweep.ts",
  "workers/api/src/do/sequencer.ts",
] as const;
// SOURCE FILES ONLY, and the checklist is EXCLUDED deliberately — measured at §1077, not assumed. Including it
// produced 2 hits and BOTH were false: a closed row saying "10 of 11 sweeps" (a different population — the
// repo-wide count, which itself says "the eight in workers/agents/src/index.ts"), and §1076's own stamp
// QUOTING the corrected-away "seven" to document the fix. That is the irreducible semantic floor a
// count-matcher hits on prose: a record that preserves its history necessarily contains its own wrong numbers,
// and no filter distinguishes a stale claim from a quoted one. A gate at a 50% false-positive rate is a gate
// people silence (§1053), so this one is scoped to where the count is a LIVE assertion rather than a citation.
//
// §1341 — A DERIVED COMPLETENESS CHECK WAS TRIED HERE AND REVERTED, WITH THE RESULT.
// `r2-before-row.test.ts` solves the same hand-kept-roster problem correctly: it DERIVES the population
// (every R2 write), subtracts the declared subset, names each exemption with a reason, and asserts the
// remainder is empty — so its roster cannot go stale. Applying that shape here fired immediately, on
// `workers/translator/src/sweep-214.ts`, whose text reads *"MEASURED by driving two sweeps concurrently"*.
// That is two INVOCATIONS, not a population of two — a semantic false positive on the first file it found.
// The difference is the predicate: *an R2 write* is MECHANICAL, while *a file stating the sweep count* is
// SEMANTIC, and only the mechanical one can be derived. The roster above is therefore deliberate, not an
// oversight, and the note about a 50% false-positive rate is the measurement that justifies it.

// §1313 — ONE THROUGH TWELVE, not "the words that appear today".
//
// This table began at six–ten, and that ceiling was a live blind spot twice over: `eleven` is the number two
// files actually state, so the matcher could not see the claim at all. I then extended it to twelve and wrote
// a WORKER-count check against it — and PLANTING §1312's original defect (`across four workers`) left the gate
// GREEN, because `four` was still missing. That is verbatim the §1077 lesson recorded forty lines above ("a
// class chosen from the names that exist today, excluding one the generator can emit"), reproduced in the
// gate written to enforce it. The fix is not to add `four`; it is to stop curating the range.
const WORD: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

// §1313 — STRUCK TEXT IS HISTORY, NEVER A LIVE CLAIM.
//
// This repo corrects a number by STRIKING it and writing the new one beside it (`~~four~~ THREE`), so every
// corrected count leaves its own wrong value in the file forever. Line 118 already works around that with a
// hand-written `~~\*\*\d+\*\*~~` alternation at one site; this generalises it, because the alternative is a
// new bespoke alternation at every future site. Mechanical, not semantic: `~~…~~` is a syntactic marker the
// convention already assigns exactly this meaning, which is why it can be filtered where prose cannot (the
// irreducible false-positive floor the SWEEP_COUNT_FILES note describes is about UNMARKED historical quotes).
function stripStruck(text: string): string {
  return text.replace(/~~[\s\S]*?~~/g, " ");
}

/**
 * §1313 — the repo-wide per-tenant orchestrator population, derived by the SAME rule
 * `sweep-containment-coverage.test.ts` uses: a function whose body reaches `allTenantSlugs`.
 *
 * This is a DIFFERENT population from `containedSweeps()` above — that one counts the `contain("…")` calls in
 * the agents cron (8); this one counts per-tenant sweeps across the repo (11). The two were conflated in the
 * SWEEP_COUNT_FILES note ("a different population — the repo-wide count"), and only the first had a gate.
 */
function perTenantOrchestrators(root: string): { total: number; workers: string[] } {
  const files = execSync('git ls-files "workers/*/src/*.ts" "workers/*/src/**/*.ts"', { cwd: root, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((f) => f !== "" && !f.includes(".test."));
  const byWorker = new Map<string, Set<string>>();
  for (const f of files) {
    const src = readFileSync(`${root}/${f}`, "utf8");
    for (const m of src.matchAll(/export async function (\w+)\s*\(/g)) {
      if (m[1] === "allTenantSlugs") continue;
      // §1339/§1340 — the fallback is END OF FILE, not a fixed 3000 chars.
      //
      // When a function is the LAST export in its file there is no next `\nexport ` to bound it, and the
      // function IS the remainder of the file — so truncating at 3000 characters invents a blind zone for no
      // benefit. MEASURED 2026-08-13: **ten** last-in-file exports already exceed 3000 characters, the largest
      // at 31,972 (`concierge.ts@handleMessageReceived`), so a future orchestrator whose `allTenantSlugs` call
      // sits past that offset would be silently uncounted — the §1313 under-detection this gate exists to
      // prevent, reproduced inside it. No orchestrator is missed TODAY (the true-body count and the
      // fallback count both yield 11), which is why this is a widening with no behaviour change rather than a
      // fix to a live defect.
      const next = src.indexOf("\nexport ", m.index + 10);
      if (!/allTenantSlugs\s*\(/.test(src.slice(m.index, next > 0 ? next : src.length))) continue;
      const w = f.split("/")[1]!;
      if (!byWorker.has(w)) byWorker.set(w, new Set());
      byWorker.get(w)!.add(m[1]!);
    }
  }
  return { total: [...byWorker.values()].reduce((n, s) => n + s.size, 0), workers: [...byWorker.keys()].sort() };
}

// RESIDUAL, stated so it is a known limit rather than a discovered one (§1318): both claim-readers below
// anchor on the literal phrase `per-tenant sweep`. Rewording THAT — "tenant-scoped sweeps", "per-tenant crons"
// — silently removes a file from this gate's view, exactly as hard-coding `across` did before §1318 widened
// it. The anchor is not widened here because it is what makes the window specific enough to read a bare
// `<N> workers` safely; loosening both the anchor and the pattern would trade a silent miss for a noisy gate,
// which §1053 records as the failure that gets a gate deleted. A phrase rename must update this file.
/** Every file that states the PER-TENANT sweep population, derived rather than hand-kept. */
function perTenantCountClaims(root: string): { file: string; stated: number }[] {
  const files = execSync('git ls-files "workers/**/*.ts" "packages/**/*.ts" "tools/**/*.ts"', { cwd: root, encoding: "utf8" })
    .trim()
    .split("\n")
    // This gate necessarily CONTAINS the vocabulary it matches (the WORD table, the probe strings), so it
    // cannot be its own subject. Everything else in the three source trees is in scope — the hand-kept list
    // above is exactly the shape that let §1312's wrong count survive unseen.
    .filter((f) => f !== "" && !f.endsWith("tools/checks/checklist-figures.test.ts"));
  const N = `(${Object.keys(WORD).join("|")}|\\d+)`;
  const out: { file: string; stated: number }[] = [];
  for (const f of files) {
    const text = stripStruck(readFileSync(`${root}/${f}`, "utf8"));
    if (!/per-tenant sweep/i.test(text)) continue;
    // SHAPE A — self-anchoring: "Eleven per-tenant sweeps across …". The phrase is in the match, so this is
    // safe to run over the whole file.
    for (const m of text.matchAll(new RegExp(`\\b${N}\\s+per-tenant\\s+sweeps?`, "gi"))) {
      const n = WORD[m[1]!.toLowerCase()] ?? Number(m[1]);
      if (Number.isFinite(n)) out.push({ file: f, stated: n });
    }
    // SHAPE B — "Every per-tenant sweep in this system — eleven of them …". WINDOW-SCOPED, and that is not
    // fastidiousness: run file-wide with a complete WORD table it matches the ordinary English "one of them",
    // which produced three false positives across two workers the moment the vocabulary was completed. A
    // count only means THIS population when it sits beside the phrase naming it — the same discipline the
    // worker check below needs, for the same reason, and independent of which number words exist.
    for (const anchor of text.matchAll(/per-tenant sweep/gi)) {
      for (const m of text.slice(anchor.index, anchor.index + 120).matchAll(new RegExp(`\\b${N}\\s+of\\s+them\\b`, "gi"))) {
        const n = WORD[m[1]!.toLowerCase()] ?? Number(m[1]);
        if (Number.isFinite(n)) out.push({ file: f, stated: n });
      }
    }
  }
  return out;
}

/**
 * §1313 — the WORKER count stated alongside that population.
 *
 * This is the half that matters most, and the reason is uncomfortable: §1312's actual defect was here, not in
 * the sweep count. Both files said "eleven per-tenant sweeps across FOUR workers" — the eleven was right, the
 * four was wrong (three: `api` carries tenant bindings but iterates no roster). A gate checking only the
 * population would have stayed green through the exact drift that motivated it.
 *
 * SCOPED TO THE SENTENCE, because "four workers" is a TRUE and common statement elsewhere in this repo — four
 * workers do carry tenant bindings. Only a worker count bound to the per-tenant-sweep phrase is a claim about
 * THIS population, so the match is taken from a window around that phrase rather than from the file.
 */
function perTenantWorkerClaims(root: string): { file: string; stated: number }[] {
  const files = execSync('git ls-files "workers/**/*.ts" "packages/**/*.ts" "tools/**/*.ts"', { cwd: root, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((f) => f !== "" && !f.endsWith("tools/checks/checklist-figures.test.ts"));
  const N = `(${Object.keys(WORD).join("|")}|\\d+)`;
  const out: { file: string; stated: number }[] = [];
  for (const f of files) {
    const text = stripStruck(readFileSync(`${root}/${f}`, "utf8"));
    for (const anchor of text.matchAll(/per-tenant sweep/gi)) {
      const window = text.slice(anchor.index, anchor.index + 200);
      // NO PREPOSITION IN THE PATTERN. §1318 probed this matcher with nine rewordings: it survived digits,
      // capitals, a comma before the preposition and a struck number, and went BLIND on two — "spanning four
      // workers" and "in four workers" — because the first cut hard-coded `across`. A count check that a
      // synonym silently disables is the §1077 curated-vocabulary bug wearing a different hat, so the
      // preposition is gone entirely: inside a window that already names the population, `<N> workers` IS the
      // claim regardless of what precedes it. The window is what keeps this specific (a bare `N workers`
      // anywhere in the file would be far too loose).
      for (const m of window.matchAll(new RegExp(`\\b${N}\\s+workers\\b`, "gi"))) {
        const n = WORD[m[1]!.toLowerCase()] ?? Number(m[1]);
        if (Number.isFinite(n)) out.push({ file: f, stated: n });
      }
    }
  }
  return out;
}

/** Stated counts of the form "EIGHT sweeps" / "seven crons" / "8 contained sweeps". */
function statedSweepCounts(root: string, rel: string): number[] {
  // §1319 — the alternation is BUILT FROM `WORD`, not written beside it. It read
  // `(six|seven|eight|nine|ten|\d+)` while its own `.map` already looked the match up in `WORD` — so the table
  // and the pattern were two copies of one list, and extending the table at §1313 did not extend this. The
  // count it guards is 8 today; the day a ninth, tenth and eleventh sweep land, a file stating "eleven sweeps"
  // becomes INVISIBLE here, which is precisely the defect §1313 was written to close, surviving one function
  // away in the same file. Struck text is stripped for the same reason it is everywhere else in this file.
  const text = stripStruck(readFileSync(`${root}/${rel}`, "utf8"));
  const re = new RegExp(`\\b(${Object.keys(WORD).join("|")}|\\d+)\\s+(?:contained\\s+)?(?:sweeps|crons)\\b`, "gi");
  return [...text.matchAll(re)].map((m) => WORD[(m[1] as string).toLowerCase()] ?? Number(m[1])).filter((n) => Number.isFinite(n));
}

/** Count `CONFIRM-GATED` rows in the register — the authority, not a copy of it. */
function confirmGatedRows(root: string): number {
  const csv = readFileSync(`${root}/genesis/09-REQUIREMENTS-REGISTER.csv`, "utf8");
  return csv.split("\n").filter((l) => l.includes("CONFIRM-GATED")).length;
}

/** The canonical-view roster and its ceiling, parsed from the registry that declares them. */
function canonicalViews(root: string): { declared: number; max: number } {
  const src = readFileSync(`${root}/apps/command/src/views/registry.ts`, "utf8");
  const arr = /CANONICAL_VIEWS = \[(.*?)\]\s*as const/s.exec(src);
  const max = /MAX_CANONICAL_VIEWS = (\d+)/.exec(src);
  return {
    declared: arr === null ? -1 : [...(arr[1] as string).matchAll(/"([a-z_]+)"/g)].length,
    max: max === null ? -1 : Number(max[1]),
  };
}

describe("§1313: the PER-TENANT sweep population is re-derived, not remembered", () => {
  const root = repoRoot();
  const derived = perTenantOrchestrators(root);
  const claims = perTenantCountClaims(root);

  it("the derivation and the corpus are both real (non-vacuity)", () => {
    // A renamed roster helper yields 0 orchestrators, and "every stated count matches" would hold over nothing
    // — the exact shape §487/§554/§572 met. And a broken glob yields no claims, which passes just as quietly.
    expect(derived.total, "no tenant-iterating orchestrators found — the derivation is stale, not the tree").toBeGreaterThanOrEqual(8);
    expect(derived.workers, "the orchestrator workers changed — update the claims, not this expectation").toEqual(["agents", "billing", "translator"]);
    expect(claims.length, "no file states the per-tenant sweep population — this gate has no subject").toBeGreaterThanOrEqual(2);
  });

  it("every stated per-tenant sweep count equals the derived population", () => {
    // §1312 corrected two files by hand that stated this population. NOTHING would have caught them: the
    // hand-kept SWEEP_COUNT_FILES lists neither, and `eleven` was absent from WORD, so the matcher was blind
    // to the very number in use. Both holes are closed here — the file list is derived, and the vocabulary
    // reaches twelve.
    const wrong = claims.filter((c) => c.stated !== derived.total).map((c) => `${c.file} states ${c.stated}, derived ${derived.total}`);
    expect(
      wrong,
      `per-tenant sweep count(s) out of date. The population is derived from the code (a body reaching ` +
        `allTenantSlugs), so the prose is what drifted:\n  ${wrong.join("\n  ")}\n\nCorrect by STRIKING the old ` +
        "number and writing the new one beside it — struck text is ignored by this gate on purpose.",
    ).toEqual([]);
  });

  it("every stated WORKER count equals the derived one — the drift §1312 actually made", () => {
    // Replaying the real defect: both files read "eleven per-tenant sweeps across FOUR workers", and the
    // eleven was correct. A gate on the population alone would have been green through it.
    const wrong = perTenantWorkerClaims(root)
      .filter((c) => c.stated !== derived.workers.length)
      .map((c) => `${c.file} states ${c.stated} workers, derived ${derived.workers.length} (${derived.workers.join(", ")})`);
    expect(
      wrong,
      `per-tenant sweep WORKER count(s) out of date:\n  ${wrong.join("\n  ")}\n\nNote that "four workers" is ` +
        "TRUE elsewhere — four workers carry tenant bindings — which is why this reads only a count bound to " +
        "the per-tenant-sweep phrase.",
    ).toEqual([]);
  });

  it("struck numbers are ignored — the repo's own correction convention cannot trip this gate", () => {
    // Positive control in BOTH directions: without stripStruck, `~~four~~ THREE` reads as a live "four".
    expect(stripStruck("across ~~four~~ THREE workers")).not.toContain("four");
    expect(stripStruck("across ~~four~~ THREE workers")).toContain("THREE");
    // …and the stripper must not eat live text either.
    expect(stripStruck("eleven per-tenant sweeps")).toContain("eleven per-tenant sweeps");
  });
});

describe("§933: the checklist's numeric claims are re-derived, not remembered", () => {
  const root = repoRoot();
  const checklist = readFileSync(`${root}/${CHECKLIST}`, "utf8");

  it("both derivations produce real values (non-vacuity — two broken parses agree about nothing)", () => {
    // A renamed register column, a restructured registry, or a broken read yields -1/0 and every comparison
    // below passes over nothing — the failure this repo met in four gates (§487/§554/§572).
    expect(confirmGatedRows(root), "no CONFIRM-GATED rows parsed from the register — the scan is broken, not the register").toBeGreaterThan(5);
    const v = canonicalViews(root);
    expect(v.declared, "CANONICAL_VIEWS did not parse — the scan is broken, not the registry").toBeGreaterThan(5);
    expect(v.max, "MAX_CANONICAL_VIEWS did not parse").toBeGreaterThan(0);
  });

  it("the CONFIRM-GATED count the checklist states equals what the register carries", () => {
    // The row's argument (CLAUDE.md names three, the register has many) survives a drift of one — but the
    // row's OWN expiry trigger is "when the count changes materially", so the figure must stay honest.
    const stated = /the register carries ~~\*\*\d+\*\*~~ \*\*(\d+)\*\*|the register carries \*\*(\d+)\*\*/.exec(checklist);
    expect(stated, `${CHECKLIST} no longer states a CONFIRM-GATED count where this gate reads it`).not.toBeNull();
    const n = Number(stated?.[1] ?? stated?.[2]);
    expect(
      n,
      `the checklist states ${n} CONFIRM-GATED rows; the register carries ${confirmGatedRows(root)}. §932 found this ` +
        "figure had drifted 14 → 15 unnoticed. Update the row (striking the old number, not deleting it) so the " +
        "next reader sees the question was asked and answered.",
    ).toBe(confirmGatedRows(root));
  });

  it("the canonical-view usage the checklist states equals the registry (11 declared under a ceiling of 12)", () => {
    const v = canonicalViews(root);
    // The row's whole point is that a ceiling and a usage read alike. If either moves, the row's example
    // stops being true and its argument stops landing.
    expect(checklist, `the checklist's canonical-views row no longer states ${v.declared} declared`).toContain(`declares **${v.declared}**`);
    expect(checklist, `the checklist's canonical-views row no longer states the ceiling ${v.max}`).toContain(`MAX_CANONICAL_VIEWS = ${v.max}`);
  });

  it("§932's correction stands: a routes tolerance DOES exist, so the row may not re-assert otherwise", () => {
    // The row originally claimed "no tolerance implementation in tools/ or packages/". It is false, and the
    // correction is struck-through rather than deleted. If someone reinstates the claim, or the constant it
    // was corrected against disappears, one of these two fails.
    const parity = readFileSync(`${root}/packages/ledger/src/parity.ts`, "utf8");
    // The COLON is load-bearing, and its absence was a defect in this file for one mutation round: a bare
    // `toContain("export const PARITY_TOLERANCE_BPS")` is satisfied by `…_BPS_X`, so renaming the constant away
    // left this GREEN. Second time this session I wrote that exact prefix bug into a tripwire (§920 was the
    // first), which is why it is spelled out here rather than fixed silently. A prefix is not an identifier.
    expect(parity, "PARITY_TOLERANCE_BPS is gone — §932's correction to the routes row rested on it").toContain("export const PARITY_TOLERANCE_BPS:");
    expect(parity, "the rating tolerance is no longer 1_000 bps (±10%) — the routes-gate claim rested on that number").toContain("rating: 1_000");
    expect(
      checklist,
      "the checklist's routes row no longer carries §932's correction. The claim 'no tolerance implementation' " +
        "is FALSE — parity.ts carries one and says it IS rule 6's routes gate. Do not re-assert it without " +
        "resolving whether that comment is right or over-claims.",
    ).toContain("EVIDENCE CORRECTED 2026-08-10 (audit §932)");
  });

  it("§1077: every stated sweep count equals the containment calls that produce it", () => {
    const derived = containedSweeps(root);
    // Non-vacuity first: a broken matcher would derive 0 and then agree with nothing, silently.
    expect(derived, "no contain(...) calls parsed from the agents worker — the scan broke, not the worker").toBeGreaterThanOrEqual(5);

    const wrong: string[] = [];
    let stated = 0;
    for (const rel of SWEEP_COUNT_FILES) {
      for (const n of statedSweepCounts(root, rel)) {
        stated += 1;
        if (n !== derived) wrong.push(`${rel} states ${n}`);
      }
    }
    // The roster must actually FIND statements — otherwise a reworded comment silently empties this gate.
    expect(stated, `no sweep-count statements found across the ${SWEEP_COUNT_FILES.length} rostered SOURCE files — the phrasing changed and this gate went blind`).toBeGreaterThanOrEqual(2);
    expect(
      wrong,
      `file(s) stating a sweep count that disagrees with the ${derived} contain(...) calls in ` +
        "workers/agents/src/index.ts:\n  " +
        wrong.join("\n  ") +
        "\n\n§1076 found exactly this: §248 corrected the figure in sla-sweep.ts and the sibling copy in " +
        "do/sequencer.ts kept saying seven, with the corrected file carrying a note about being corrected and " +
        "nothing connecting the two. Update every copy, or add a newly-stating file to SWEEP_COUNT_FILES.",
    ).toEqual([]);
  });
});
