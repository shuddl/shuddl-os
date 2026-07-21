import { readFileSync } from "node:fs";
import { join } from "node:path";

// WP-15 Task 2 (REQ-030 / Ten Laws L8) — the ANTI-SILENT-BYPASS coverage lint. A compute path that emits /
// prices / invoices / settles WITHOUT consulting the authority read-seam is a SILENT authority bypass — the
// exact bug class workers/api/src/gate-context.ts (and its parity discipline) exist to prevent, the 2026-07-15
// audit's C-1 lesson: a bypass path silently dropped a gate the main path enforced. This is a STATIC SOURCE
// SCAN (mirroring tools/checks/rater-purity.ts, which scans for forbidden LLM imports): it asserts that EACH
// registered module's authoritative-output file calls `resolveAuthority(`, so a future edit that drops the
// consultation on one path fails the merge LOUDLY. A static scan is robust, behavior-neutral, and matches the
// codebase's lint-as-test convention — far better than a fragile runtime spy.
//
// LIMITATION (shared with rater-purity.ts): this is a regex over source, not a TS parser — a `resolveAuthority(`
// written inside a comment/string would false-SATISFY the requirement. For a POSITIVE requirement (must be
// present) that only risks a false PASS on a hand-crafted comment, which a reviewer catches; the fail-LOUD
// direction (a real consultation dropped from live code) is the one that matters and is caught.
//
// DISPATCH's authoritative point is the sequencer DO gate: appointment.set / dispatch.assigned have no
// native-compute SERVICE seam distinct from the generic events append, so — by the orchestrator's WP-15 Task 2
// decision — the consult lives in workers/api/src/do/sequencer.ts #enforceTransitionGate, SCOPED to ONLY those
// two rare gated kinds (one indexed SELECT on the 5-row authority_map, never the generic/every-kind append
// path), feeding a dormant branch only. All 5 overlay modules are now registered here.

export type CoverageModule = "rating" | "invoicing" | "settlement" | "comms" | "dispatch";

export interface AuthorityModuleFiles {
  module: CoverageModule;
  files: readonly string[];
}

// The authoritative-output file(s) per overlay module that MUST consult resolveAuthority. Paths are
// cwd-relative (matching rater-purity.ts + the CLI output). rating has TWO surfaces (the authed /v1/rate route
// and the public guest quote); comms has TWO emitters of message.sent (the Concierge auto-reply and the
// dunning human-send). Shrinking this registry is itself a red flag — the coverage test guards its shape.
export const AUTHORITATIVE_FILES: readonly AuthorityModuleFiles[] = [
  { module: "rating", files: ["workers/api/src/routes/rate.ts", "workers/api/src/pub/quote.ts"] },
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

// A REAL call to the seam: the name immediately followed by `(` (optional whitespace). A bare mention (e.g. an
// import with no call) does NOT satisfy it — the point is a live consultation, not a dangling import.
const CALL_RE = /\bresolveAuthority\s*\(/;

// Pure analyzer: given each authoritative file's (module, path, content), return every file that fails to
// consult the seam. Empty ⇒ every registered authoritative path consults resolveAuthority.
export function analyzeAuthorityCoverage(files: readonly { module: CoverageModule; file: string; content: string }[]): CoverageViolation[] {
  const violations: CoverageViolation[] = [];
  for (const { module, file, content } of files) {
    if (!CALL_RE.test(content)) {
      violations.push({
        module,
        file,
        detail: `does not call resolveAuthority(...) — every ${module} authoritative-output path MUST consult the authority seam (REQ-030/L8) or it is a SILENT authority bypass.`,
      });
    }
  }
  return violations;
}

// Read every registered authoritative file (paths cwd-relative, matching the analyzer + CLI output). Shared by
// the CLI and the "real wired files consult" test.
export function collectAuthoritativeFiles(cwd: string = process.cwd()): { module: CoverageModule; file: string; content: string }[] {
  const out: { module: CoverageModule; file: string; content: string }[] = [];
  for (const { module, files } of AUTHORITATIVE_FILES) {
    for (const file of files) out.push({ module, file, content: readFileSync(join(cwd, file), "utf8") });
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
  console.log(
    `authority-coverage OK — all ${scanned.length} registered authoritative files across ${AUTHORITATIVE_FILES.length} modules ` +
      `(rating/invoicing/settlement/comms/dispatch) consult resolveAuthority (REQ-030/L8). dispatch's consult is ` +
      `the sequencer DO gate, scoped to appointment.set/dispatch.assigned only.`,
  );
}

if (process.argv[1]?.endsWith("authority-coverage.ts")) main();
