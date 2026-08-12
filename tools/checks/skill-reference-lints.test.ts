import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { repoRoot } from "./repo-root.js";

// §1051 — REFERENCE CODE IS WRITTEN TO BE COPIED, SO IT MUST PASS THE LINT ITS COPIER WILL FACE.
//
// The skills ship executable TypeScript: `reference-predicates.ts`, `travel-matrix.ts`,
// `stripInternalInPlace.ts`, `shared-target-matcher.ts`. Every one exists to be lifted into `packages/` or
// `workers/`, and each teaches a constitutional rule (gate parity, external routing, counterparty redaction,
// shared lint matchers). None of them was ever linted.
//
// TWO mechanisms hid them, and either alone would have been enough:
//   1. `eslint.config.mjs` global-ignores `.claude/**`.
//   2. **ESLint does not traverse dot-directories when expanding `.`**, so even deleting that ignore lints
//      nothing — MEASURED at §1051 by adding `"!.claude/skills/**"` to the ignores: 0 files linted, 0 errors.
//
// That second one is why this must be a gate with EXPLICIT PATHS rather than a config edit. A negated ignore
// looks like coverage and delivers none — the §1041 shape (a gate reporting clean over an empty corpus), in
// the files whose whole purpose is to be copied into the ledger.
//
// MEASURED AT §1051 by running eslint on the four files directly: **2 errors**, both
// `@typescript-eslint/no-unused-vars` in `reference-predicates.ts:58` — a stub whose parameters are unused
// because its body is a `throw`. Small, and exactly the kind that matters here: the repo's own convention is
// an `_` prefix (stated in eslint.config.mjs), so the reference taught a signature the repo's lint rejects.
// Fixed with `void db; void shipmentId;`, which satisfies the rule while KEEPING the parameter names — an
// `_` prefix would teach a signature the copier has to undo.
//
// SCOPE, STATED: lint only. That the code lints says nothing about whether it still matches the source it
// cites — that is the citation ratchet's job, and §1025 already found a skill naming a predicate its own
// reference did not export. Two halves of one question, deliberately separate.

const SKILLS = ".claude/skills";

/** Tracked TypeScript under the skills tree. `git ls-files` because untracked scratch must not gate merges. */
export function referenceFiles(root: string): string[] {
  return execFileSync("git", ["ls-files", `${SKILLS}/**/*.ts`, `${SKILLS}/**/*.tsx`], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => f !== "");
}

describe("§1051: skill reference code passes the lint its copier will face", () => {
  const root = repoRoot();
  const files = referenceFiles(root);

  it("finds the reference files (non-vacuity — §968's rule, and this gate's own subject)", () => {
    // This gate exists BECAUSE two mechanisms made these files invisible. It must not become a third: an
    // empty list here would report a clean skills tree over nothing, which is the failure it was written for.
    expect(files.length, `no tracked .ts/.tsx found under ${SKILLS} — the glob or the skills tree moved`).toBeGreaterThanOrEqual(4);
  });

  // §1162 — SUBPROCESS TEST: this shells out, and the suite runs at vitest's DEFAULT 5000ms. Measured
  // at 5044-7725ms under the load of consecutive full-suite runs, where it failed as a TIMEOUT —
  // indistinguishable from a real defect. A per-test allowance; the suite default stays 5000ms so nothing
  // else's ceiling moves (audit §1162).
  it("every reference file lints clean", () => {
    // `--no-ignore` is REQUIRED: `.claude/**` is globally ignored, and without this eslint exits 0 having
    // linted nothing — a pass that means "I looked at no files".
    let out = "";
    let failed = false;
    try {
      execFileSync("pnpm", ["exec", "eslint", "--no-ignore", ...files], { cwd: root, encoding: "utf8", stdio: "pipe" });
    } catch (e) {
      failed = true;
      const err = e as { stdout?: string; stderr?: string };
      out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    expect(
      failed ? out.trim() : "",
      "skill reference file(s) fail the repo's own lint. This is code written to be COPIED into packages/ or " +
        "workers/, so a violation here is a defect handed to whoever follows the skill — and it is invisible " +
        "to `pnpm lint` twice over (`.claude/**` is ignored, AND eslint does not traverse dot-directories, so " +
        "un-ignoring it lints nothing — measured at §1051).\n" +
        "Fix the reference. If a parameter is deliberately unused in a stub, prefer `void param;` over an `_` " +
        "prefix: it satisfies the rule while keeping the signature the copier should actually write.",
    ).toBe("");
  }, 30_000);
});
