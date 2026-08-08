import { execSync } from "node:child_process";

// REQ-118 §624 — ASK FOR A CORPUS, GET NON-VACUITY FREE.
//
// `append-chokepoint.ts` established at audit §466 that a multi-glob corpus needs a floor PER GLOB:
//
//   "THE FIRST FIX WAS AN AGGREGATE COUNT, and it did not work ... SCAN_GLOBS has EIGHT entries; breaking the
//    six product ones still left tools/**/*.ts matching 72 files, over a floor of 50, and the gate stayed
//    green with the entire product tree unscanned. A total says nothing about which member contributed it."
//
// §624 swept for that shape and found three gates using two globs behind one aggregate floor. **The sweep's
// premise turned out to be WRONG, and the measurement is what said so.** In git pathspec `*` CROSSES `/`, so
// `workers/api/src/*.ts` already matches `workers/api/src/routes/rate.ts`. Measured: the flat glob returns 49
// files, the nested `**` glob returns 38, and their union is 49 — the nested glob adds ZERO. It was decorative
// in all three gates, and breaking it left them green because nothing was in fact unscanned.
//
// The error that produced the false finding is worth more than the finding would have been: the corpus size
// was derived by ADDING 49 + 38 as if the globs were disjoint, rather than measuring the union. That is
// §"compare artifacts, don't reason about them" — and the arithmetic looked authoritative enough to survive a
// mutation, because breaking a redundant glob produces exactly the green a masked gate would.
//
// What survives is smaller and real: the redundant glob is gone from all three, and each corpus is now built
// through a helper that FAILS when its glob matches nothing. §466's per-glob rule still holds wherever globs
// are genuinely disjoint (append-chokepoint's eight are) — this helper is how the next such gate gets it
// without re-deriving it.

export interface CorpusOptions {
  /** Globs that are ALLOWED to match nothing, by exact string — a package with no nested dirs, say. */
  readonly mayBeEmpty?: ReadonlySet<string>;
  /** Drop test files from the result (most source scanners want this). */
  readonly excludeTests?: boolean;
}

export class EmptyGlobError extends Error {
  constructor(readonly glob: string) {
    super(
      `scan glob matched ZERO files: ${glob}\n` +
        "A violation scan that scans nothing reports clean, and an AGGREGATE floor cannot see this — a " +
        "sibling glob's matches carry the total over the line while this subtree goes unread (audit §466/§624). " +
        "Fix the pattern, or pass it in `mayBeEmpty` with a reason.",
    );
  }
}

/**
 * Tracked files matching ANY of `globs`, with EVERY glob required to match at least one file.
 *
 * The per-glob requirement is the whole point: a total is satisfiable by one member, so it says nothing about
 * which member contributed it.
 */
export function scanCorpus(globs: readonly string[], cwd: string, opts: CorpusOptions = {}): string[] {
  const seen = new Set<string>();
  for (const glob of globs) {
    const out = execSync(`git ls-files ${JSON.stringify(glob)}`, { cwd, encoding: "utf8" })
      .trim()
      .split("\n")
      .filter((f) => f !== "")
      .filter((f) => !(opts.excludeTests === true && f.includes(".test.")));
    // Emptiness is judged BEFORE the test filter would hide it — a glob matching only test files has still
    // matched, and reporting it empty would send the reader after the wrong defect.
    const matchedAnything = execSync(`git ls-files ${JSON.stringify(glob)}`, { cwd, encoding: "utf8" }).trim() !== "";
    if (!matchedAnything && opts.mayBeEmpty?.has(glob) !== true) throw new EmptyGlobError(glob);
    for (const f of out) seen.add(f);
  }
  return [...seen].sort();
}
