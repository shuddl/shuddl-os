import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../checks/repo-root.js";

// §1081 — `pnpm delta` — WHICH FAILURES ARE **NEW**?
//
// Written because a rule failed twice at the same step. §1062: *"a delta is not explained until it is
// reproduced."* §1080 reproduced it — three runs, four failures against a baseline of three — and committed
// anyway, because reproducing a number is not the same as IDENTIFYING it. The missing step was never
// discipline; it was that identifying a delta costs a `grep -v` of three remembered titles against 1,249
// results, and remembering is the part that fails at 2am.
//
// The concept is everywhere in this record — "baseline" appears in **128 prior verdicts** — and NOTHING
// mechanised it. That gap is the whole justification for this file (§1068: when a discipline fails
// repeatedly, price it; do not restate it).
//
// WHAT IT IS NOT: a replacement for reading failures. It answers exactly one question — *is anything failing
// that was not already failing?* — and answers it in one line. Whether a baseline failure is ACCEPTABLE is a
// separate judgement, made when the entry was added, and re-made when its `until` condition fires.

/**
 * Failures that are known, explained, and not this session's business. Keyed by (file, title) — not by count,
 * because a count cannot tell you WHICH three, which is the confusion that produced §1080.
 *
 * Every entry carries `until`: the condition that should make it disappear. An entry whose condition has
 * fired but which still fails is a REGRESSION wearing a baseline's clothes, and the "unexpectedly passing"
 * report below is what catches the opposite — a baseline that silently healed.
 */
interface Known { readonly file: string; readonly title: string; readonly why: string; readonly until: string }

const BASELINE: readonly Known[] = [
  // §1355 — EMPTY, and that is a measurement rather than an omission.
  //
  // This list held three entries, all blaming the owner's uncommitted REQ-289 register row. Re-run 2026-08-13:
  // `tools/traceability/coverage.test.ts` and `traceability.test.ts` are **34/34 GREEN**, and the merge board
  // reports `coverage` and `traceability` as PASS. All three HEALED — the register now classifies that row
  // (292 rows, 100% accounted). §1081 reports healed entries precisely because "a silently-fixed entry is news
  // too", and leaving them here would have let a genuine future regression in those files read as expected.
  //
  // THE ONE LIVE FAILURE IS DELIBERATELY NOT LISTED. `citation-links.test.ts` fails on a rot into another
  // workstream's uncommitted `coverage.ts` (valid at HEAD, proved at §1314/§1354). Baselining it would make
  // §1354's defect PERMANENT rather than fix it: that test asserts an ARRAY of rotted citations, so marking it
  // expected-failing absorbs every FUTURE rot into the same green-looking line — which is exactly how a
  // dangling path of mine survived ~25 phases. **`delta` is TEST-granular; that failure is SUB-test.** The
  // right instrument for it is the gate's own printed count ("N rotted citation(s) of M checked"), not this
  // baseline.
];

export interface Failure { readonly file: string; readonly title: string }

/** Failing assertions from a vitest JSON report. */
export function failuresFrom(report: string, root: string): Failure[] {
  const parsed = JSON.parse(report) as {
    testResults?: { name?: string; assertionResults?: { status?: string; title?: string }[] }[];
  };
  const out: Failure[] = [];
  for (const f of parsed.testResults ?? []) {
    const file = (f.name ?? "").replace(`${root}/`, "");
    for (const a of f.assertionResults ?? []) {
      if (a.status === "failed") out.push({ file, title: a.title ?? "" });
    }
  }
  return out;
}

// JSON, not a delimiter: a path and a title can both contain any printable character, and the first version
// used a literal NUL as the separator — unambiguous, and it made this file BINARY to git, which
// `section-refs` refused (audit §1082). A key must be collision-free AND plain text.
const key = (f: { file: string; title: string }): string => JSON.stringify([f.file, f.title]);

/** New failures (not in BASELINE) and baseline entries that unexpectedly PASSED. Both are news. */
export function classify(failures: readonly Failure[], baseline: readonly Known[] = BASELINE): {
  unexpected: Failure[];
  healed: Known[];
} {
  const failing = new Set(failures.map(key));
  const known = new Set(baseline.map(key));
  return {
    unexpected: failures.filter((f) => !known.has(key(f))),
    healed: baseline.filter((b) => !failing.has(key(b))),
  };
}

function main(): void {
  const root = repoRoot();
  const out = join(tmpdir(), `shuddl-delta-${String(process.pid)}.json`);
  try {
    execFileSync("pnpm", ["exec", "vitest", "run", "--config", "vitest.tools.config.ts", "--reporter=json", `--outputFile=${out}`], {
      cwd: root,
      stdio: "ignore",
    });
  } catch {
    // vitest exits non-zero WHENEVER anything failed — including the baseline. That is expected, and the
    // report is still written. Only an unreadable report is fatal (below).
  }
  let report: string;
  try {
    report = readFileSync(out, "utf8");
  } catch {
    console.error("delta: vitest produced no JSON report — the run did not complete. This is NOT a clean tree.");
    process.exit(2);
  } finally {
    rmSync(out, { force: true });
  }

  const failures = failuresFrom(report, root);
  const { unexpected, healed } = classify(failures);

  for (const h of healed) {
    console.log(`delta: BASELINE HEALED — ${h.file}\n  “${h.title}”\n  was: ${h.why}\n  Remove it from BASELINE (its condition: ${h.until}).`);
  }
  if (unexpected.length === 0) {
    console.log(`delta: no new failures. ${String(failures.length)} failing, all ${String(BASELINE.length)} explained by BASELINE.`);
    if (healed.length > 0) process.exit(1);
    return;
  }
  console.error(`delta: ${String(unexpected.length)} NEW failure(s) — not in BASELINE:\n`);
  for (const u of unexpected) console.error(`  ${u.file}\n    “${u.title}”\n`);
  console.error(
    "Identify each before committing. §1080 reproduced a 4-vs-3 delta three times and committed anyway: " +
      "reproducing a count is not identifying it, and a count cannot tell you WHICH assertion moved.",
  );
  process.exit(1);
}

if (process.argv[1]?.endsWith("delta.ts")) main();
