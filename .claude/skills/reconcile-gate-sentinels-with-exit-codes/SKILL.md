---
name: reconcile-gate-sentinels-with-exit-codes
description: Use when a gate harness parses a structured sentinel (##SHUDDL-GATE##) out of child output, when a wrapper gate relays nested children's stdout, when adding a field/browser gate to package.json, or when a gate can run in a non-blocking "local" mode. Symptoms — a PASS recorded for a command that exited non-zero, an all-skipped suite exiting 0, a runbook command missing its --mode flag.
---

# Reconcile Gate Sentinels With Exit Codes

## Overview
A gate has two mouths: its structured sentinel and its exit code. When they disagree, the
PESSIMISTIC one is the verdict. A sentinel may degrade a clean exit; it may never upgrade a failing
one. And a gate with no advisory use case (a field gate, a promotion gate) bakes its blocking mode
into the package script — a mode left to the caller is a mode that gets dropped.

## When to Use
- Writing or reviewing anything that parses `##SHUDDL-GATE##` lines (`tools/release/run-gate.ts`,
  `tools/harness/playwright-guard.ts`).
- Adding a gate script to `package.json` — decide there whether it has any legitimate non-blocking
  invocation.
- A wrapper gate spawns commands that themselves emit sentinels (the `unit-tests` gate captures
  every workspace run's output).
- Reviewing a runbook/CI command that invokes a gate — does it carry the mode the spec assumes?
- NOT for tools that only ever synthesize from exit codes — there is nothing to reconcile.

## The RED this closes (two real defects, 2026-08-01 audit)
**1. The last sentinel won outright.** `run-gate.ts` runCmd preferred the last sentinel found
anywhere in combined stdout+stderr over the child's exit code. Wrapper gates relay NESTED output, so
a nested child's PASS printed before the wrapper failed recorded PASS — a false green in the one
artifact promotion reads. Fixed by `reconcileSentinel` (`tools/release/run-gate.ts:108@reconcileSentinel`):
exit 1/null + PASS ⇒ FAIL; exit 2 + PASS ⇒ BLOCKED; each names the disagreement in `detail`.

**2. The documented invocation could not fail.** `pnpm test:surfaces` carried no `--mode`, so
playwright-guard ran in its `local` default where an all-skipped run (PROD_SURFACE_BASE unset or
typo'd) exits 0 and suppresses the sentinel — while the spec's own header claimed "an all-skipped
run is BLOCKED, never a green exit 0." No documented path ran the gate in a blocking mode. Fixed by
baking `--mode release` into the package script: a field gate has no advisory use.

## The pattern
```ts
// A sentinel may degrade, never upgrade. Pessimistic wins on disagreement.
export function reconcileSentinel(gate: string, sentinel: GateResult | undefined, exitCode: number | null) {
  if (sentinel === undefined) return undefined;          // caller synthesizes from exit code
  const own = { ...sentinel, gate };
  if (exitCode === 0 || own.status !== "PASS") return own; // agreement, or already pessimistic
  const status = exitCode === EVIDENCE_EXIT.PREREQ_BLOCKED ? "BLOCKED" : "FAIL";
  return { ...own, status, detail: `sentinel said PASS but the command exited ${exitCode ?? "null"} — the exit code wins: ${own.detail}` };
}
```

```jsonc
// package.json — the mode is part of the gate's identity, not the caller's choice:
"test:surfaces": "tsx tools/harness/playwright-guard.ts surfaces playwright.prod.config.ts --mode release"
```

## Guard tests
- Every disagreement quadrant pinned: exit 0+PASS, exit 1+PASS, exit 2+PASS, null+PASS, exit 0+BLOCKED
  (`tools/release/run-gate.test.ts`).
- Per-step CI assertions: every strict browser step individually carries `--mode merge`
  (`tools/release/ci-contract.test.ts`) — one global `/--mode merge/` match let three steps lose
  their flag silently.
- Behavioral proof for a baked mode: run the script with its prerequisite absent and assert exit 2.

## Red flags
- "The sentinel is more structured, prefer it" — structure is not truth; provenance is uncontrolled.
- "The caller always passes --mode" — the one documented caller didn't.
- A spec header claiming fail-closed semantics the documented invocation never engages.
