import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";
import { packageDirs } from "../acceptance/run.js";

// §1049 — REQ-024's BAN IS DIRECT-IMPORT-ONLY; THE LEDGER'S DEPENDENCY CLOSURE IS WHAT IT MUST COVER.
//
// `no-restricted-imports` matches SPECIFIERS. It is direct-import-only by construction and can see no
// transitive reach — which is not a defect in ESLint, it is the shape of the tool. §985 and §986 already
// closed the other two routes into `packages/ledger` (dynamic `import()`, the `fetch` global), so the
// remaining reach is through a package the ledger DEPENDS on.
//
// MEASURED AT §1049: `packages/ledger` declares exactly ONE first-party dependency — `@shuddl/contracts` —
// and that package carried no LLM ban. A static `@anthropic-ai/sdk` import planted there left eslint,
// `check:invariants`, `rater-purity` and `lint-guards` ALL FOUR GREEN, giving the ledger LLM reach with no
// banned specifier anywhere under `packages/ledger`.
//
// The assumption was already written down: `tools/checks/rater-purity.ts` states the guarantee *"RELIES on
// @shuddl/contracts staying a pure type/schema boundary (Zod shapes only — no logic, no LLM)"*. A lockstep
// comment is a missing test. Widening the eslint block was the fix; this file is why the fix stays true.
//
// WHAT THIS ASSERTS, AND WHY IT IS COMPUTED RATHER THAN LISTED. Naming `contracts` in a second list would
// re-create the defect one dependency later: adding `@shuddl/foo` to the ledger's deps would widen the hole
// silently, and nothing would say so. So this READS the ledger's package.json, walks the first-party closure
// transitively, and COMPUTES which globs the REQ-024 block must carry. Read one side, compute the other —
// §1048's rule, applied to the law one over.
//
// SCOPE, STATED: this asserts the ban's SCOPE covers the closure, never that the ban's PATTERN list is
// complete. A new LLM vendor under a specifier matching none of the eight globs is invisible here and is the
// eslint block's own business — two halves of one question, deliberately separate.

const ESLINT = "eslint.config.mjs";
/** The comment that opens the REQ-024 block. Anchoring on it means a rename fails loudly, not silently. */
const BLOCK_MARKER = "REQ-024: LLMs never write ledger truth — statically banned from the ledger package.";

/** The `files:` globs of the REQ-024 block. Throws rather than returning empty — an unfound block is a defect. */
export function req024Globs(config: string): string[] {
  const at = config.indexOf(BLOCK_MARKER);
  if (at < 0) {
    throw new Error(
      `${ESLINT}: the REQ-024 block marker was not found. Either the comment was reworded (re-anchor this ` +
        `test) or the block was deleted (that is the finding). This throws rather than reporting an empty ` +
        `glob list, because a scan over nothing reports clean — §1041's lesson, in the gate that guards the ledger.`,
    );
  }
  const filesAt = config.indexOf("files:", at);
  const open = config.indexOf("[", filesAt);
  const close = config.indexOf("]", open);
  if (filesAt < 0 || open < 0 || close < 0) throw new Error(`${ESLINT}: REQ-024 block has no parseable files: [...] array`);
  return [...config.slice(open, close).matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
}

/** Every first-party package reachable from `start` through `dependencies`, including `start` itself. */
export function firstPartyClosure(start: string, manifestOf: (pkg: string) => Record<string, string>): string[] {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const pkg = queue.shift() as string;
    if (seen.has(pkg)) continue;
    seen.add(pkg);
    for (const dep of Object.keys(manifestOf(pkg))) {
      if (dep.startsWith("@shuddl/") && !seen.has(dep)) queue.push(dep);
    }
  }
  return [...seen];
}

describe("§1049: REQ-024's ban covers the ledger's whole first-party closure", () => {
  const root = repoRoot();
  const config = readFileSync(`${root}/${ESLINT}`, "utf8");
  const dirs = packageDirs(root);
  const deps = (pkg: string): Record<string, string> => {
    const dir = dirs.get(pkg);
    if (dir === undefined) return {};
    return (JSON.parse(readFileSync(`${root}/${dir}/package.json`, "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {};
  };

  const closure = firstPartyClosure("@shuddl/ledger", deps);
  const globs = req024Globs(config);

  it("the closure walk and the glob parse both find something (non-vacuity — §968's rule)", () => {
    // Both floors fail differently. An empty closure means the workspace resolution broke, so every
    // assertion below would pass over nothing; an empty glob list means the block was gutted.
    expect(closure, "the ledger's first-party closure is empty — packageDirs or the manifest read is broken")
      .toContain("@shuddl/ledger");
    expect(globs.length, `no globs parsed from the REQ-024 block in ${ESLINT}`).toBeGreaterThanOrEqual(1);
    // The measured shape at §1049, stamped rather than pinned: the closure is exactly ledger + contracts.
    // If this grows, the assertion below is what must hold — this line is only the record of what was true.
    expect(closure.length, `closure changed since §1049 (was 2: ledger + contracts) — now ${closure.join(", ")}`)
      .toBeGreaterThanOrEqual(2);
  });

  it("every package the ledger can reach carries the REQ-024 ban", () => {
    const uncovered = closure
      .filter((pkg) => dirs.has(pkg))
      .map((pkg) => ({ pkg, dir: dirs.get(pkg) as string }))
      .filter(({ dir }) => !globs.some((g) => g === `${dir}/**/*.ts` || g === `${dir}/**`))
      .map(({ pkg, dir }) => `${pkg}  (${dir}) — add "${dir}/**/*.ts" to the REQ-024 block's files array`);
    expect(
      uncovered,
      `package(s) the ledger DEPENDS ON that REQ-024's ban does not cover:\n  ` +
        uncovered.join("\n  ") +
        `\n\n\`no-restricted-imports\` matches specifiers, so it cannot see a transitive reach: an LLM import ` +
        `in any of these gives the ledger LLM reach with NO banned specifier under packages/ledger. MEASURED ` +
        `AT §1049 with a planted \`@anthropic-ai/sdk\` import in packages/contracts — eslint, check:invariants, ` +
        `rater-purity and lint-guards were all four GREEN.\n` +
        `Widen the EXISTING block's \`files\` array rather than adding a new block: ESLint flat config is ` +
        `last-writer-wins per rule name, so a second block naming \`no-restricted-imports\` REPLACES these ` +
        `options instead of merging (audit §874).`,
    ).toEqual([]);
  });
});
