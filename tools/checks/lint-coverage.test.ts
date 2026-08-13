import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";
import { execSync } from "node:child_process";
import { repoRoot } from "./repo-root.js";

// §1251 (REQ-024/163/118) — EVERY SHIPPED SOURCE FILE IS COVERED BY THE CONSTITUTIONAL LINT RULES.
//
// §1250 named the gap this closes. `lint-guards.test.ts` proves the bans FIRE — it plants an LLM import in the
// ledger and asserts ESLint flags it. That is the stronger check for a rule it tests, and it is structurally
// silent about COVERAGE: a rule nobody thought to plant a violation against is a rule nobody notices missing.
//
// MEASURED, and this is why the gate exists rather than being a nicety: `@typescript-eslint/no-floating-promises`
// was configured `"error"` with type-aware parsing and was ABSENT for all 50 `tools/` sources (§1249) — the
// files that implement every other gate. `apps/` had the identical hole until §705. Both were found by asking
// ESLint what it resolves for a PATH, which no fire-test does. Twice is a pattern; this makes it mechanical.
//
// THE THREE RULES ARE NOT ARBITRARY. Each is named by CLAUDE.md as constitutional and enforced by lint alone:
//   · no-restricted-imports  — REQ-024 (no LLM in the ledger) and REQ-163 (no prior-codebase merge)
//   · no-explicit-any        — the stack rule ("TypeScript strict, no `any`")
//   · no-floating-promises   — silent work-loss; §1248's class, where the failure has no observable symptom
//
// TESTS ARE DELIBERATELY OUT OF SCOPE for the promise rules — the config says so ("tests legitimately float
// promises in fixtures") — so this gate reads NON-TEST sources only. That exclusion is asserted below rather
// than assumed, so a future widening of the rules to tests does not silently make this gate's scope a lie.

const CONSTITUTIONAL = ["no-restricted-imports", "@typescript-eslint/no-explicit-any", "@typescript-eslint/no-floating-promises"] as const;

const GLOBS = [
  "packages/*/src/**/*.ts",
  "packages/*/src/*.ts",
  "workers/*/src/**/*.ts",
  "workers/*/src/*.ts",
  "apps/*/src/**/*.ts",
  "apps/*/src/**/*.tsx",
  "apps/*/src/*.ts",
  "apps/*/src/*.tsx",
  "tools/**/*.ts",
  "tools/*.ts",
];

function shippedSources(root: string): string[] {
  const out = execSync(`git ls-files ${GLOBS.map((g) => `"${g}"`).join(" ")}`, { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => f !== "" && !f.includes(".test.") && !f.includes(".spec."));
  return [...new Set(out)];
}

/** Severity of each constitutional rule as ESLint RESOLVES it for a path — not as the config file reads. */
async function severities(eslint: ESLint, file: string): Promise<Record<string, number>> {
  const cfg = (await eslint.calculateConfigForFile(file)) as { rules?: Record<string, unknown[]> };
  const rules = cfg.rules ?? {};
  const out: Record<string, number> = {};
  for (const r of CONSTITUTIONAL) {
    const entry = rules[r];
    out[r] = Array.isArray(entry) ? Number(entry[0]) : 0;
  }
  return out;
}

describe("§1251 REQ-024/163: the constitutional lint rules cover every shipped source", () => {
  const root = repoRoot();
  const files = shippedSources(root);
  const eslint = new ESLint({ cwd: root });

  it("finds every source tree (non-vacuity — a shrunken corpus would make the sweep below hold trivially)", () => {
    // Floor the INPUT. A broken glob yields few files and "all covered" over a handful is a false clean.
    expect(files.length, "too few shipped sources found — the glob is broken, not the tree").toBeGreaterThanOrEqual(250);
    for (const tree of ["packages/", "workers/", "apps/", "tools/"]) {
      expect(files.some((f) => f.startsWith(tree)), `no sources found under ${tree} — this gate would not see a hole there`).toBe(true);
    }
  });

  it("every non-test shipped source resolves all three constitutional rules to ERROR", async () => {
    const gaps: string[] = [];
    for (const f of files) {
      const sev = await severities(eslint, f);
      for (const r of CONSTITUTIONAL) {
        if (sev[r] !== 2) gaps.push(`${f}  ${r} = ${sev[r] === 0 ? "ABSENT" : String(sev[r])}`);
      }
    }
    expect(
      gaps.slice(0, 25),
      `${gaps.length} shipped source/rule pair(s) not covered by a constitutional lint rule. A rule that does ` +
        "not APPLY to a path is not enforced there, however loudly it is configured elsewhere — this is the " +
        "hole §1249 found in `tools/` and §705 found in `apps/`:\n  " +
        gaps.slice(0, 25).join("\n  "),
    ).toEqual([]);
  }, 60_000);

  it("the exclusion of TEST files from the promise rules is the documented one, not an accident", async () => {
    // The config scopes the type-aware promise rules to src on purpose. Asserting it here means a future
    // widening cannot silently make this gate's stated scope untrue — and it proves the sweep above is
    // measuring something real, since an always-2 reader would fail this case.
    const aTest = execSync('git ls-files "workers/*/test/*.test.ts"', { cwd: root, encoding: "utf8" }).split("\n").filter((f) => f !== "")[0];
    expect(aTest, "no worker test file found — cannot verify the documented exclusion").toBeDefined();
    const sev = await severities(eslint, aTest!);
    expect(
      sev["@typescript-eslint/no-floating-promises"],
      "worker tests now carry no-floating-promises. That may be an improvement — but this gate's scope says " +
        "tests are excluded, so update the scope and this case together rather than leaving the record wrong.",
    ).toBe(0);
    // The import bans are NOT scoped to src — REQ-024/163 bind a test file exactly as they bind a source file.
    expect(sev["no-restricted-imports"], "REQ-024/163 must bind test files too — a banned import is banned anywhere").toBe(2);
  }, 30_000);
});
