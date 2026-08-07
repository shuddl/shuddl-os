import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
// V1 remediation Task 3 (REQ-288): an ABSENT denylist is a missing prerequisite — advisory (PENDING)
// locally, non-promotable (BLOCKED) under merge/release; an actual leak is a FAIL. run-gate consumes the
// structured GateResult, never this file's prose.
import { parseMode, unavailableStatus, formatGateResult, type GateMode, type GateResult } from "../release/evidence.js";
import { repoRoot } from "./repo-root.js";

// REQ-167 (doc 13 §02): identity-leak lint. The denylist (tenant names, person names,
// incumbent-vendor names, customer names) is maintained CLIENT-SIDE:
//   1. env IDENTITY_DENYLIST (CI secret), else
//   2. .identity-denylist.local (gitignored).
// The names never enter version control — including via this tool's output (masked).

export type Leak = { file: string; masked: string };

export function parseDenylist(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("#"));
}

function mask(term: string): string {
  return term.length <= 1 ? "*" : term[0] + "*".repeat(term.length - 1);
}

export function scanForIdentityLeaks(terms: string[], files: Map<string, string>): Leak[] {
  const leaks: Leak[] = [];
  for (const [file, content] of files) {
    const lower = content.toLowerCase();
    for (const term of terms) {
      if (lower.includes(term.toLowerCase())) leaks.push({ file, masked: mask(term) });
    }
  }
  return leaks;
}

export type IdentityLeakOutcome = { code: number; message: string; level: "fail" | "warn" | "ok" };

// The one DISPOSITION decision this gate makes, extracted as a pure function so it is unit-testable
// without process.exit. REQ-167 (WP-16): an ABSENT denylist was the last fail-OPEN gate in the build —
// it now fails CLOSED in CI / at a WP-exit run (`ci` or `requireDenylist`), and preserves the documented
// warn-and-skip ONLY for local dev without the secret. The scanner logic is untouched; only this changes.
export function resolveIdentityLeakOutcome(input: {
  terms: string[] | null;
  ci: boolean;
  requireDenylist: boolean;
  leaks: Leak[];
}): IdentityLeakOutcome {
  const { terms, ci, requireDenylist, leaks } = input;
  if (!terms) {
    if (ci || requireDenylist) {
      return {
        code: 1,
        level: "fail",
        message:
          "FAIL REQ-167: no denylist available (set IDENTITY_DENYLIST secret or .identity-denylist.local). " +
          "The identity-leak gate fails CLOSED in CI / at a WP-exit run — it will not pass without a denylist. " +
          "Wire the secret (or set the file) before this run.",
      };
    }
    return {
      code: 0,
      level: "warn",
      message:
        "REQ-167: no denylist available (set IDENTITY_DENYLIST secret or .identity-denylist.local). " +
        "Lint SKIPPED — wire the secret before external contributions. " +
        "NOTE: this gate fails CLOSED in CI (or when REQUIRE_DENYLIST is set); the skip is local-dev only.",
    };
  }
  if (leaks.length > 0) {
    return {
      code: 1,
      level: "fail",
      message: leaks.map((l) => `FAIL REQ-167 identity leak in ${l.file}: ${l.masked}`).join("\n"),
    };
  }
  return { code: 0, level: "ok", message: `identity-leak lint: clean (${terms.length} terms checked)` };
}

// The mode-aware disposition as a PURE GateResult (REQ-288). An absent/empty denylist is a MISSING
// prerequisite (PENDING local / BLOCKED merge-release), a found leak is a FAIL, a clean scan is a PASS
// whose assertions = files scanned. This never leaks a name (only masked leaks / counts appear).
export function identityGateResult(input: { terms: string[] | null; mode: GateMode; leaks: Leak[]; filesScanned: number }): GateResult {
  const { terms, mode, leaks, filesScanned } = input;
  if (!terms || terms.length === 0) {
    const { status } = unavailableStatus(mode);
    return { gate: "identity-leak", status, executed: false, assertions: 0, detail: "no denylist (set IDENTITY_DENYLIST secret or .identity-denylist.local)" };
  }
  if (leaks.length > 0) {
    return { gate: "identity-leak", status: "FAIL", executed: true, assertions: filesScanned, detail: `${leaks.length} identity leak(s): ${leaks.map((l) => `${l.file}:${l.masked}`).join(", ")}` };
  }
  return { gate: "identity-leak", status: "PASS", executed: true, assertions: filesScanned, detail: `${filesScanned} files scanned against ${terms.length} denylist term(s)` };
}

// Treat empty / "0" / "false" as unset so a stray CI="" or CI=0 doesn't spuriously fail a local run.
function envFlag(v: string | undefined): boolean {
  return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

function loadDenylist(): string[] | null {
  const env = process.env["IDENTITY_DENYLIST"];
  if (env && env.trim().length > 0) return parseDenylist(env);
  if (existsSync(".identity-denylist.local")) return parseDenylist(readFileSync(".identity-denylist.local", "utf8"));
  return null;
}

function trackedFiles(): Map<string, string> {
  // §489 — REPO-ROOTED. REQ-167 forbids an identity in ANY repo artifact, and with a bare
  // `git ls-files` the word "any" silently meant "any under the caller's directory". Masked today
  // only because the denylist is a secret and the lint SKIPS without it — the scope defect would
  // have arrived with the secret, i.e. exactly when the gate started mattering.
  const out = execSync("git ls-files", { cwd: repoRoot(), encoding: "utf8" }).split("\n").filter(Boolean);
  const map = new Map<string, string>();
  for (const f of out) {
    try {
      map.set(f, readFileSync(f, "utf8"));
    } catch {
      /* binary or unreadable — vendored fixture bytes are hash-pinned, skip */
    }
  }
  return map;
}

function main(): void {
  const terms = loadDenylist();
  const argv = process.argv.slice(2);
  const files = terms ? trackedFiles() : new Map<string, string>();
  const leaks = terms ? scanForIdentityLeaks(terms, files) : [];

  // NEW (REQ-288): explicit --mode local|merge|release path emits a structured GateResult so run-gate
  // records BLOCKED (not a masquerading green) for an absent denylist. Callers that pass no --mode keep
  // the exact legacy CI disposition below (REQUIRE_DENYLIST/CI fail-closed), unchanged.
  if (argv.includes("--mode")) {
    const mode = parseMode(argv);
    const g = identityGateResult({ terms, mode, leaks, filesScanned: files.size });
    const sink = g.status === "PASS" ? console.log : g.status === "FAIL" ? console.error : console.warn;
    sink(g.detail ?? g.status);
    console.log(formatGateResult(g));
    process.exit(g.status === "FAIL" ? 1 : g.status === "BLOCKED" ? 2 : 0);
  }

  const ci = envFlag(process.env["CI"]);
  const requireDenylist = envFlag(process.env["REQUIRE_DENYLIST"]);
  const outcome = resolveIdentityLeakOutcome({ terms, ci, requireDenylist, leaks });
  const sink = outcome.level === "ok" ? console.log : outcome.level === "warn" ? console.warn : console.error;
  sink(outcome.message);
  process.exit(outcome.code);
}
if (process.argv[1]?.endsWith("identity-leak.ts")) main();
