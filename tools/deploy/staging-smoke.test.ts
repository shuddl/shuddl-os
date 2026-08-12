import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { EVIDENCE_EXIT } from "../release/evidence.js";
import { repoRoot } from "../checks/repo-root.js";

// §1192 (REQ-031/288) — THE ONLY PATH THIS GATE EVER TAKES, AND NOTHING PINNED IT.
//
// `staging-smoke` is a RELEASE-profile gate. Every other tool in `tools/deploy/` has a sibling test; this one
// had none — measured at §1192, it was the single exception. The two files that mention it
// (`gate-wiring.test.ts`, `run-gate.test.ts`) check that it is REGISTERED and REACHABLE, which is a different
// property from what it does when it runs.
//
// WHY THAT MATTERS MORE HERE THAN IT WOULD ELSEWHERE. Its real work needs a deployed environment, and nothing
// supplies one: `SMOKE_API_BASE` appears in NO workflow and `smoke:staging` is invoked by no CI job (measured
// §1192 — zero references under `.github/`). So the ONLY path this gate can take, on every machine and in
// every pipeline that exists today, is the prerequisite-absent path. That path is its entire observable
// behaviour, and it was untested.
//
// The regression this closes is one character wide and completely silent: an edit that turns
// `EVIDENCE_EXIT.PREREQ_BLOCKED` into `OK` converts a release blocker into a green light, on a gate whose
// green nobody can distinguish from a real smoke run without reading the JSON. `evidence.ts` refuses to
// promote a PASS with `executed: false`, so the record would still be honest — but the GATE's own exit code
// is what `run-gate.ts` reads first, and that is what this pins.
//
// Spawned rather than imported, deliberately: the file exports nothing and reads its environment at module
// scope, so importing it would evaluate the very inputs under test. Spawning also exercises it exactly as
// `run-gate.ts` does, which is the property a release depends on.

const GATE = "tools/deploy/staging-smoke.ts";

/** Run the gate with the deployed-environment prerequisites explicitly ABSENT, whatever the developer has set. */
function runUnconfigured(): { code: number; out: string } {
  const env = { ...process.env };
  // Deleted, not blanked: an empty string and an unset variable are different inputs, and the gate reads `??`.
  for (const k of ["SMOKE_API_BASE", "SMOKE_JWT_SECRET", "SMOKE_CONTROL_DB"]) delete env[k];
  const r = spawnSync("npx", ["tsx", GATE, "--mode", "release"], {
    cwd: repoRoot(),
    encoding: "utf8",
    env,
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

interface GateLine {
  readonly gate: string;
  readonly status: string;
  readonly executed: boolean;
  readonly assertions: number;
  readonly detail: string;
}

/** The `##SHUDDL-GATE##` evidence line, parsed. Absent ⇒ undefined, which the non-vacuity test rejects. */
function gateLine(out: string): GateLine | undefined {
  const m = /##SHUDDL-GATE##\s*(\{.*\})/.exec(out);
  return m === null ? undefined : (JSON.parse(m[1] as string) as GateLine);
}

describe("§1192 REQ-031/288: staging-smoke fails CLOSED when there is no deployed environment", () => {
  const run = runUnconfigured();

  it("emits an evidence line at all (non-vacuity — a silent run must not satisfy the parse)", () => {
    expect(gateLine(run.out), `no ##SHUDDL-GATE## line in the output:\n${run.out.slice(0, 400)}`).toBeDefined();
  }, 60_000);

  it("exits PREREQ_BLOCKED — never 0, which would read as a passed smoke test", () => {
    // The whole point. `run-gate.ts` reads the exit code before it reads anything else.
    expect(run.code, "a release gate with no environment must not exit 0").toBe(EVIDENCE_EXIT.PREREQ_BLOCKED);
    expect(run.code).not.toBe(EVIDENCE_EXIT.OK);
  }, 60_000);

  it("reports BLOCKED with executed:false and ZERO assertions — a skip may not wear a green coat", () => {
    const line = gateLine(run.out)!;
    expect(line.gate).toBe("staging-smoke");
    expect(line.status).toBe("BLOCKED");
    expect(line.executed, "nothing ran, so `executed` must say so").toBe(false);
    expect(line.assertions, "no assertion held, and evidence.ts refuses to promote a PASS with zero").toBe(0);
  }, 60_000);

  it("names the ABSENT PREREQUISITE, so an operator knows what to supply", () => {
    // A BLOCKED verdict is only actionable if it says what is missing (RELEASE-EVIDENCE rule 4: "read its
    // `detail`; it names the absent prerequisite").
    expect(gateLine(run.out)!.detail).toMatch(/SMOKE_API_BASE/);
  }, 60_000);

  it("says in prose that nothing was exercised — the operator-facing half of the same claim", () => {
    expect(run.out).toMatch(/nothing was exercised|not a pass/i);
  }, 60_000);
});
