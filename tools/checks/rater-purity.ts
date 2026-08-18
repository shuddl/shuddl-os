import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./repo-root.js";

// REQ-004 + REQ-024 (mirrored for the rater). Two static purity rules over packages/rater/src:
//   • class_as_foundation — the adapter subtree (packages/rater/src/adapters/**) is the SOLE class-aware
//     region: class is an ISOLATED edge adapter, never the engine foundation, and no SMC3/NMFC table may
//     be baked in. What this rule ENFORCES, concretely: no NON-exempt src file may import a class/adapter/
//     SMC3 module BY PATH (./adapters/*, a `class`-segment specifier, or an smc3/nmfc specifier) NOR reach
//     the adapter through the package's own barrel (./index, @shuddl/rater). Exemptions: adapters/** (the
//     adapter itself) and the public barrel index.ts (which may re-export the adapter for external callers).
//     It is a denylist with two exemptions, NOT an allowlist of named core files — so a class/adapter
//     import in ANY non-adapter helper (e.g. types.ts, which the engine imports) is caught, not just the
//     eight core modules. LIMITATION / SCOPE: this is a PATH+BARREL guarantee, not a type-flow analysis.
//     It does NOT (and need not) stop the erased `ClassAdapter` TYPE flowing in from @shuddl/contracts —
//     that is a config SHAPE, not class logic (price.ts legitimately holds a `class_adapter?: ClassAdapter`
//     field, imported as `import type`, fully erased). The guarantee therefore RELIES on @shuddl/contracts
//     staying a pure type/schema boundary (Zod shapes only — no logic, no LLM); class *behavior* lives
//     solely in adapters/**, and no engine module has a path or barrel route to it.
//   • llm_in_rater — no file under packages/rater/src may import an LLM/agent SDK. The rater is a pure
//     deterministic engine; LLMs never write pricing truth (mirrors the ledger REQ-024 ban).
// This is a STATIC lint: it parses import specifiers with regexes, not a full TS parser. LIMITATION —
// a specifier written inside a comment or string literal of the form `from "…"` / `import("…")` can
// false-match, and only these three import forms are recognized: `… from "spec"`, `import "spec"`
// (side-effect), and `import("spec")` (dynamic). That is sufficient for a source tree of plain ES imports.

export interface PurityViolation {
  file: string;
  rule: "class_as_foundation" | "llm_in_rater";
  detail: string;
}

// LLM/agent import globs, mirroring the ledger REQ-024 no-restricted-imports patterns in eslint.config.mjs.
// `*` matches any run of characters; each glob is anchored to the whole specifier.
const LLM_IMPORT_GLOBS = [
  "@anthropic-ai/*",
  "anthropic*",
  "openai*",
  "@openai/*",
  "ai",
  "@ai-sdk/*",
  "@shuddl/agents*",
  "*agents*",
] as const;

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}
const LLM_IMPORT_REGEXPS: readonly RegExp[] = LLM_IMPORT_GLOBS.map(globToRegExp);

function posix(path: string): string {
  return path.replace(/\\/g, "/");
}

// The class_as_foundation rule applies to EVERY file under packages/rater/src EXCEPT the two exemptions (below):
//   • the adapter subtree (packages/rater/src/adapters/**) — the sole class-aware region, and
//   • the public barrel (packages/rater/src/index.ts) — may re-export the adapter for external callers.
// A denylist-with-exemptions, NOT an allowlist of named core files: a class import in ANY other src file
// (e.g. types.ts, which the engine imports) would make the engine transitively class-aware — forbidden.
// The barrel match is precise (only the src-root index.ts): a nested foo/index.ts is NOT exempt.
function isExempt(path: string): boolean {
  const norm = posix(path);
  if (/(^|\/)adapters\//.test(norm)) return true;
  if (norm === "index.ts" || norm.endsWith("/src/index.ts")) return true;
  return false;
}

// Extract module specifiers from `… from "spec"`, `import "spec"` (side-effect), and `import("spec")`
// (dynamic). Returns each distinct specifier once. See the module-level LIMITATION note.
export function extractImportSpecifiers(content: string): string[] {
  const specs = new Set<string>();
  // `from "spec"` requires a string literal (backticks are a syntax error there), so only ["']. The
  // dynamic import() argument and a side-effect `import "spec"` DO accept a template literal, so those
  // two matchers also honor a backtick delimiter — a false-negative on a merge gate is the worse failure.
  const fromRe = /\bfrom\s*["']([^"']+)["']/g; // import … from "spec"  AND  export … from "spec"
  const dynRe = /\bimport\s*\(\s*["'`]([^"'`]+)["'`]/g; // import("spec") / import(`spec`)
  const bareRe = /\bimport\s+["'`]([^"'`]+)["'`]/g; // import "spec" / import `spec` (side-effect only)
  for (const re of [fromRe, dynRe, bareRe]) {
    for (const m of content.matchAll(re)) if (m[1]) specs.add(m[1]);
  }
  return [...specs];
}

// A self-import of the package's own entry point: `./index`, `../index` (with or without a `.js` ext) or
// the package name `@shuddl/rater`. The barrel re-exports the adapter, so a non-exempt module reaching it
// this way pulls class logic in through the back door (and importing your own barrel is a circular-import
// smell — the engine modules deliberately import siblings directly). NOT matched: `@shuddl/rater/engine`
// or a nested `./sub/index.js`, which resolve to a specific module, not the class-re-exporting entry.
function isOwnBarrelImport(spec: string): boolean {
  return /^\.\.?\/index(\.js)?$/.test(spec) || spec === "@shuddl/rater";
}

function classFoundationReason(spec: string): string | null {
  if (/(^|\/)adapters(\/|$)/.test(spec)) return "the core pricing logic may not import ./adapters/*";
  if (/smc3|nmfc/i.test(spec)) return "no SMC3/NMFC table may be baked into the engine";
  // "class" as a leading path SEGMENT only: class.js / class-map.js / class_thing.js match; classify.js,
  // first-class.js, classroom.js, the `classnames` package do NOT (they are not class-adapter modules).
  if (/(^|\/)class([._-]|$)/i.test(spec)) return "the core pricing logic may not depend on class logic";
  if (isOwnBarrelImport(spec)) return "the core pricing logic may not import the package's own barrel (it re-exports the adapter; also a circular-import smell)";
  return null;
}

// Pure analyzer: given the rater source files (path + content), return every purity violation.
export function analyzeRaterPurity(files: readonly { path: string; content: string }[]): PurityViolation[] {
  const violations: PurityViolation[] = [];
  for (const { path, content } of files) {
    const exempt = isExempt(path);
    for (const spec of extractImportSpecifiers(content)) {
      // llm_in_rater applies to EVERY file under packages/rater/src (the barrel and adapters included).
      if (LLM_IMPORT_REGEXPS.some((re) => re.test(spec))) {
        violations.push({
          file: path,
          rule: "llm_in_rater",
          detail: `imports "${spec}" — REQ-024: LLMs never write pricing truth; no LLM/agent imports in packages/rater/src.`,
        });
      }
      // class_as_foundation applies to every src file EXCEPT adapters/** and the barrel index.ts.
      if (!exempt) {
        const reason = classFoundationReason(spec);
        if (reason) {
          violations.push({
            file: path,
            rule: "class_as_foundation",
            detail: `imports "${spec}" — ${reason} (REQ-004: class is an isolated edge adapter — only packages/rater/src/adapters/** may touch class).`,
          });
        }
      }
    }
  }
  return violations;
}

// Read all TypeScript sources under packages/rater/src (paths are cwd-relative, matching the CLI output
// and the analyzer's core/exempt path checks). Shared by the CLI and the "real src is pure" test.
export function collectRaterSourceFiles(cwd: string = repoRoot()): { path: string; content: string }[] {
  return globSync("packages/rater/src/**/*.{ts,tsx}", { cwd }).map((p) => ({ path: posix(p), content: readFileSync(join(cwd, p), "utf8") }));
}

function main(): void {
  // NON-VACUITY (audit §467). This is a VIOLATION SCAN, and one that scans nothing reports clean — §466
  // measured exactly that on the sibling append-chokepoint gate, which sat at exit 0 with its globs pointed
  // at a missing directory. Here the population is a single glob over packages/rater/src, so the rule is the
  // simplest form of §466's per-glob check: if it matches nothing, the REQ-024 LLM ban and the REQ-004
  // class-as-foundation ban are being enforced over zero files and the gate would still print OK.
  const files = collectRaterSourceFiles();
  if (files.length === 0) {
    console.error(
      "FAIL rater-purity [scan] packages/rater/src/**/*.ts matched ZERO files — the scan is broken, not the code. " +
        "A renamed package or a moved src/ silently disarms the REQ-024 LLM ban and the REQ-004 class ban (audit §467).",
    );
    process.exit(1);
  }
  const violations = analyzeRaterPurity(files);
  if (violations.length > 0) {
    for (const v of violations) console.error(`FAIL rater-purity [${v.rule}] ${v.file}: ${v.detail}`);
    process.exit(1);
  }
  console.log("rater-purity OK — no class-as-foundation, no LLM/agent imports in packages/rater/src (REQ-004/REQ-024)");
}

if (process.argv[1]?.endsWith("rater-purity.ts")) main();
