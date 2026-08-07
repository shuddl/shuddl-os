import { execSync } from "node:child_process";

// THE REPO ROOT, RESOLVED ONCE (audit §487/§489).
//
// Three gates written by different hands at different times shared one defect, and a fourth already had the
// fix: `check:tables` reported *"OK (0 markdown files)"*, `check:invariants` reported *"OK — 0/22 tables,
// events append-only (0 migration files)"* — certifying CLAUDE.md rule 2 and the table budget against an
// empty set — and `check:citations` reported *"OK — 0 path:line citations resolve"*, while `rater-purity`
// and `check:chokepoint` failed loudly with *"matched ZERO files"*. Every one of those verdicts was a
// function of the directory the gate happened to be started from.
//
// **The defect was in the convention, not in any gate.** Resolving inputs against `process.cwd()` is the
// Node default everywhere, and it silently makes a scan's SCOPE depend on the caller's location. A gate
// must resolve its own universe: `cwd` is an argument about LOCATION, never about SCOPE.
//
// This module exists so the answer is written once. §487 fixed two gates by writing `repoRoot` twice — two
// copies of one rule, which is the drift `.claude/skills/share-lint-matchers-with-parity-tests` exists to
// prevent, committed while closing a defect about conventions not propagating.

/**
 * The git toplevel as seen from `cwd`.
 *
 * Throws when `cwd` is not inside a git work tree. That is deliberate and is the FAIL-CLOSED choice: a gate
 * that cannot locate the repo must stop, not fall back to `process.cwd()` and scan whatever is there. The
 * standing rule is that fail-closed is about the fallback VALUE — a permissive default here would recreate
 * exactly the vacuity this module exists to remove, and would do it invisibly.
 */
export function repoRoot(cwd: string = process.cwd()): string {
  return execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf8" }).trim();
}
