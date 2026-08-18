import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";
import { stripComments } from "./source-corpus.js";

// REQ-278 §582 — EVERY TENANT-ITERATING SWEEP IS NAMED BY ITS WORKER'S TESTS.
//
// §581 proved that all eight orchestrators contain a per-tenant failure, and that all three workers have a
// containment test (M50–M52 each RED). It then claimed the agents test "asserts this for every sweep in that
// worker". **That claim came from the test's NAME.** Its mechanism is a hand-kept `SWEEPS` array — a list a
// new sweep does not join by itself.
//
// The hand-kept callers are DELIBERATE and should stay: the signatures genuinely differ (`now` is a Date for
// `runAllTenants`, a number elsewhere, absent on `runCreditReconSweep`), and the file says why — an `it.each`
// over one shared caller would silently skip a sweep whose signature drifted. That is the right trade.
//
// What was missing is a check that the LIST IS COMPLETE. This derives the true set from the code — a function
// is a tenant-iterating orchestrator iff its body reaches `allTenantSlugs` — and requires each to be named in
// its own worker's test corpus.
//
// STATED LIMIT, so nobody reads more into a green than it carries: this proves a sweep is MENTIONED by its
// worker's tests, not that the mention is a containment assertion. It catches the realistic failure — a new
// orchestrator shipping with no test at all — and deliberately does not try to judge test quality, which
// §577 showed a name-based heuristic cannot do.

/** A function is a tenant-iterating orchestrator iff its body reaches the roster. */
function orchestratorsByWorker(root: string): Map<string, Set<string>> {
  const files = execSync('git ls-files "workers/*/src/*.ts" "workers/*/src/*.tsx" "workers/*/src/**/*.ts" "workers/*/src/**/*.tsx"', { cwd: root, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((f) => f && !f.includes(".test."));
  const out = new Map<string, Set<string>>();
  for (const f of files) {
    const worker = f.split("/")[1]!;
    const src = stripComments(readFileSync(`${root}/${f}`, "utf8"));
    for (const m of src.matchAll(/export async function (\w+)\s*\(/g)) {
      const start = m.index;
      const next = src.indexOf("\nexport ", start + 10);
      const body = src.slice(start, next > 0 ? next : start + 3000);
      // `allTenantSlugs` is the roster helper itself — it iterates nothing.
      if (m[1] === "allTenantSlugs") continue;
      if (!/allTenantSlugs\s*\(/.test(body)) continue;
      if (!out.has(worker)) out.set(worker, new Set());
      out.get(worker)!.add(m[1]!);
    }
  }
  return out;
}

/** The whole test corpus of one worker, concatenated. */
function workerTestText(root: string, worker: string): string {
  const files = execSync(`git ls-files "workers/${worker}/test/*.ts" "workers/${worker}/test/*.tsx" "workers/${worker}/test/**/*.ts" "workers/${worker}/test/**/*.tsx"`, {
    cwd: root,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
  return files.map((f) => readFileSync(`${root}/${f}`, "utf8")).join("\n");
}

describe("REQ-278 §582: no tenant-iterating sweep ships untested", () => {
  const root = repoRoot();
  const byWorker = orchestratorsByWorker(root);

  it("derives orchestrators from at least three workers (non-vacuity)", () => {
    // A renamed roster helper or a changed export shape would yield an empty map, and the assertion below
    // would pass over it — the class this repo met in four gates (§487/§554/§572).
    expect([...byWorker.keys()].sort(), "the derivation is stale, not the tree").toEqual(["agents", "billing", "translator"]);
    const total = [...byWorker.values()].reduce((n, s) => n + s.size, 0);
    expect(total, "too few orchestrators found — the body scan is broken").toBeGreaterThan(8);
  });

  it("every derived orchestrator is named somewhere in its own worker's tests", () => {
    const missing: string[] = [];
    for (const [worker, fns] of byWorker) {
      const tests = workerTestText(root, worker);
      for (const fn of fns) if (!tests.includes(fn)) missing.push(`${worker}: ${fn}`);
    }
    expect(
      missing,
      "a tenant-iterating sweep no test in its worker mentions. It needs a containment case — one tenant's " +
        "D1 throws, the sweep RESOLVES, and the failing tenant is named in the error log (the non-vacuity " +
        "half, which caught a weekly-gated sweep that returned before its loop at §410):\n  " +
        missing.join("\n  "),
    ).toEqual([]);
  });
});
