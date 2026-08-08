import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";
import { execSync } from "node:child_process";
import { repoRoot } from "./repo-root.js";

// REQ-061 §730 — THE ONE SHIPPED FILE WITH NO STATIC ANALYSIS, AND THE TWO WAYS THAT SILENTLY COMES BACK.
//
// `apps/driver/public/sw.js` is the driver's offline shell. It is neither typechecked (it is `.js`; no tsconfig
// include reaches it — §729 mapped that surface) nor, until this phase, linted: `apps/*/public/**` sat in
// eslint's global ignores, the only entry in that list with no stated reason. §717 found a REAL defect in this
// exact file — an unretained `caches.put()` that dropped the offline cache write — and fixed the bug without
// making the file analysable, so the next one would have been just as invisible.
//
// TWO THINGS HAD TO LAND TOGETHER, and this gate pins both because either alone is a false assurance:
//
//   1. the file must not be IGNORED, and
//   2. rules must actually APPLY to it.
//
// (2) is not pedantry. MEASURED with the ignore removed and no rules block: `const x = 1` unused, a reassigned
// `var`, and `1 == "1"` produced **zero findings** — only `tseslint.configs.recommended` is spread and it
// targets TypeScript. A green lint over this file would have certified nothing. That is §726's vacuous-pass
// shape arrived at by WIDENING A CORPUS, which is exactly what §714 warns a config edit can disguise.
//
// It asks ESLint rather than reading `eslint.config.mjs` — `isPathIgnored` and `calculateConfigForFile` are the
// authoritative answers to "is this file linted" and "by what", the same way §727 asks playwright what it
// would collect instead of re-deriving `testMatch`.
//
// LIMIT, STATED: §717's own defect class — a floating promise — needs TYPE-AWARE linting, unavailable for
// plain `.js`. This gate does not close that. What it does close is the failure a service worker is most
// exposed to: a typo'd global (`cahces.open`) is a ReferenceError inside an event handler, which reaches a
// driver as "the app doesn't open offline" and CI as nothing at all. `no-undef` is the rule that catches it,
// and it is load-bearing enough to be named individually below rather than counted.

const SW = "apps/driver/public/sw.js";

/** Rules that must be ERROR for the service worker, each with what it actually prevents. */
const REQUIRED: readonly (readonly [rule: string, prevents: string])[] = [
  ["no-undef", "a typo'd global (`cahces.open`) — a ReferenceError inside an event handler, silent in CI"],
  ["no-unused-vars", "a binding left behind by a refactor, the usual sign a code path was half-removed"],
  ["eqeqeq", "`==` coercion in cache-key and URL comparisons"],
  ["no-var", "`var` hoisting inside the install/fetch handlers"],
];

function isError(setting: unknown): boolean {
  return setting === "error" || setting === 2 || (Array.isArray(setting) && (setting[0] === "error" || setting[0] === 2));
}

describe("REQ-061 §730: the driver service worker is actually linted", () => {
  const root = repoRoot();

  it("the file still exists and is still tracked (non-vacuity — a moved file must not read as clean)", () => {
    // Without this, renaming or deleting sw.js makes every assertion below either throw confusingly or, worse,
    // describe a file that no longer ships. The gate must name its own subject.
    const tracked = execSync(`git ls-files "${SW}"`, { cwd: root, encoding: "utf8" }).trim();
    expect(tracked, `${SW} is not tracked. If the service worker moved, point this gate at it; if it was removed, delete this file and say so in the audit`).toBe(SW);
  });

  it("is NOT ignored by eslint", async () => {
    const eslint = new ESLint({ cwd: root });
    expect(
      await eslint.isPathIgnored(SW),
      `${SW} is ignored by eslint again. It is SHIPPED code (REQ-061 offline durability) with no typecheck ` +
        "either, so an ignore here means the file has zero static analysis — the state §717 found a real defect in",
    ).toBe(false);
  });

  it.each(REQUIRED)("`%s` applies to it as an error — %s", async (rule) => {
    // Not-ignored is only half. A file can be in the corpus and have no rule reach it, which is how this would
    // come back looking fixed: the `files:` glob narrows, or the block is dropped, and lint stays green.
    const eslint = new ESLint({ cwd: root });
    const cfg = (await eslint.calculateConfigForFile(SW)) as { rules?: Record<string, unknown> };
    expect(
      isError(cfg.rules?.[rule]),
      `\`${rule}\` is not an error for ${SW}. The file may still be in the lint corpus — but rules that do not ` +
        "reach it make its green meaningless, which is the measured state this phase found (three planted " +
        "violations, zero findings). Restore the `apps/*/public/**/*.js` block in eslint.config.mjs",
    ).toBe(true);
  });
});
