import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./repo-root.js";

// WP-15 Task 2 (REQ-030 / Ten Laws L8) — the ANTI-SILENT-BYPASS coverage lint. A compute path that emits /
// prices / invoices / settles WITHOUT consulting the authority read-seam is a SILENT authority bypass — the
// exact bug class workers/api/src/gate-context.ts (and its parity discipline) exist to prevent, the 2026-07-15
// audit's C-1 lesson: a bypass path silently dropped a gate the main path enforced. This is a STATIC SOURCE
// SCAN (mirroring tools/checks/rater-purity.ts, which scans for forbidden LLM imports): it asserts that each
// registered (module, file) pair calls `resolveAuthority(<db>, '<module>')`, so a future edit that drops the
// consultation — or wires the WRONG module's authority — fails the merge LOUDLY. A static scan is robust,
// behavior-neutral, and matches the codebase's lint-as-test convention — far better than a fragile runtime spy.
//
// MODULE-AWARE: the check is per (module, file), keyed off the MODULE STRING argument, so a file that is
// authoritative for MORE THAN ONE module must consult EACH. The Concierge auto-reply is the motivating case —
// it emits message.sent (comms) AND independently prices + appends quote.priced (rating), so concierge.ts is
// registered under BOTH `comms` and `rating` and must call resolveAuthority(db,'comms') AND (db,'rating').
// A file-granular "consults SOME authority" scan would have missed the rating half (the file already had a
// comms consult) — exactly the reviewer-flagged bypass.
//
// SEMANTIC LIMITATION (the honest boundary this lint does NOT cover; checked by the Task-10 exit audit):
//   1. It proves "this file consults the registered module's authority SOMEWHERE," NOT "every authoritative
//      sub-path in the file reaches that consult." A file could gain a SECOND authoritative function that skips
//      the seam and still pass (the first function's call satisfies the regex).
//   2. Registration is MANUAL: a NEW authoritative function added to an already-registered file, or a NEW
//      emitter in a NEW file, passes for free until a human adds it to AUTHORITATIVE_FILES below.
//   3. Regex over source, not a TS parser (shared with rater-purity.ts): a `resolveAuthority(db,'rating')`
//      written inside a comment/string would false-SATISFY. For a POSITIVE requirement that only risks a false
//      PASS on a hand-crafted comment (a reviewer catches it); the fail-LOUD direction — a real consultation
//      dropped from live code — is the one that matters and is caught.
// The WP-15 Task-10 exit audit owns the SEMANTIC coverage (every authoritative sub-path reaches the RIGHT
// module's authority, and the registry is complete) that this fast static lint deliberately does not.
//
// DISPATCH's authoritative point is the sequencer DO gate: appointment.set / dispatch.assigned have no
// native-compute SERVICE seam distinct from the generic events append, so — by the orchestrator's WP-15 Task 2
// decision — the consult lives in workers/api/src/do/sequencer.ts #enforceTransitionGate, SCOPED to ONLY those
// two rare gated kinds (one indexed SELECT on the 5-row authority_map, never the generic/every-kind append
// path), feeding a dormant branch only. All 5 overlay modules are registered here.

export type CoverageModule = "rating" | "invoicing" | "settlement" | "comms" | "dispatch";

export interface AuthorityModuleFiles {
  module: CoverageModule;
  files: readonly string[];
}

// The authoritative-output file(s) per overlay module that MUST consult resolveAuthority(db,'<module>'). Paths
// are cwd-relative (matching rater-purity.ts + the CLI output). rating has FOUR authoritative surfaces (the
// authed /v1/rate route, the public guest quote, the Concierge auto-reply which independently prices, and the
// EDI 204 inbound handler which prices a partner load tender — the same authoritative-emitter class as the
// Concierge); comms has TWO emitters of message.sent (the Concierge auto-reply and the dunning human-send).
// concierge.ts therefore appears under BOTH rating and comms. Shrinking this registry is itself a red flag —
// the coverage test guards its shape.
export const AUTHORITATIVE_FILES: readonly AuthorityModuleFiles[] = [
  { module: "rating", files: ["workers/api/src/routes/rate.ts", "workers/api/src/pub/quote.ts", "workers/agents/src/concierge.ts", "workers/translator/src/inbound.ts"] },
  { module: "invoicing", files: ["workers/agents/src/biller.ts"] },
  { module: "settlement", files: ["workers/agents/src/interline-split.ts"] },
  { module: "comms", files: ["workers/agents/src/concierge.ts", "workers/api/src/routes/dunning.ts"] },
  { module: "dispatch", files: ["workers/api/src/do/sequencer.ts"] },
] as const;

export interface CoverageViolation {
  module: CoverageModule;
  file: string;
  detail: string;
}

// A REAL, MODULE-SPECIFIC consult: `resolveAuthority(<first-arg>, '<module>')`. The first arg is any non-comma/
// paren token run (the tenant db handle in every call site); the SECOND arg must be the exact module string.
// A bare `resolveAuthority` mention (a dangling import) does NOT satisfy it, and neither does consulting a
// DIFFERENT module — that is the module-aware property the concierge bypass needs.
function moduleCallRe(module: CoverageModule): RegExp {
  return new RegExp(`\\bresolveAuthority\\s*\\(\\s*[^,()]+,\\s*["']${module}["']`);
}

// Pure analyzer: given each (module, path, content), return every pair whose file fails to consult THAT
// module's authority. Empty ⇒ every registered authoritative path consults its module's resolveAuthority.
export function analyzeAuthorityCoverage(files: readonly { module: CoverageModule; file: string; content: string }[]): CoverageViolation[] {
  const violations: CoverageViolation[] = [];
  for (const { module, file, content } of files) {
    if (!moduleCallRe(module).test(content)) {
      violations.push({
        module,
        file,
        detail: `does not call resolveAuthority(db, '${module}') — this file is authoritative for the ${module} module and MUST consult its authority (REQ-030/L8) or it is a SILENT authority bypass.`,
      });
    }
  }
  return violations;
}

// Read every registered (module, file) pair (paths cwd-relative, matching the analyzer + CLI output). A file
// registered under two modules is read once per registration (concierge.ts under rating AND comms). Shared by
// the CLI and the "real wired files consult" test.
// §489 — repo-anchored default; see tools/checks/repo-root.ts for why cwd is a location, not a scope.
export function collectAuthoritativeFiles(cwd: string = repoRoot()): { module: CoverageModule; file: string; content: string }[] {
  const out: { module: CoverageModule; file: string; content: string }[] = [];
  for (const { module, files } of AUTHORITATIVE_FILES) {
    for (const file of files) {
      const path = join(cwd, file);
      // §608 — a REGISTERED file that no longer exists already failed closed, but as a raw ENOENT stack
      // trace from node:fs. The registry/filesystem divergence is a real event (a rename, a move), and the
      // reader needs to know which module lost its authoritative file, not which line of fs.js threw.
      // §607 found the same divergence in the acceptance runner, where it did NOT fail closed.
      if (!existsSync(path)) {
        throw new Error(
          `authority-coverage: the ${module} module registers ${file}, which does not exist. Either the file ` +
            `moved (update AUTHORITATIVE_FILES) or the authoritative path for ${module} was deleted, which ` +
            `means nothing consults its authority any more (REQ-030/L8).`,
        );
      }
      out.push({ module, file, content: readFileSync(path, "utf8") });
    }
  }
  return out;
}

function main(): void {
  const scanned = collectAuthoritativeFiles();
  const violations = analyzeAuthorityCoverage(scanned);
  if (violations.length > 0) {
    for (const v of violations) console.error(`FAIL authority-coverage [${v.module}] ${v.file}: ${v.detail}`);
    process.exit(1);
  }
  const distinctFiles = new Set(scanned.map((s) => s.file)).size;
  console.log(
    `authority-coverage OK — all ${scanned.length} (module, file) consults across ${AUTHORITATIVE_FILES.length} modules ` +
      `(rating/invoicing/settlement/comms/dispatch), ${distinctFiles} distinct files, each call resolveAuthority(db,'<module>') ` +
      `(REQ-030/L8). concierge.ts consults BOTH rating (it prices) and comms; dispatch's consult is the sequencer DO ` +
      `gate, scoped to appointment.set/dispatch.assigned only.`,
  );
}

if (process.argv[1]?.endsWith("authority-coverage.ts")) main();
