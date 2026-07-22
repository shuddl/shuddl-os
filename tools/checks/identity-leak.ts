import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

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
  const out = execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean);
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
  const ci = envFlag(process.env["CI"]);
  const requireDenylist = envFlag(process.env["REQUIRE_DENYLIST"]);
  // Only scan when a denylist exists (the scan reads every tracked file); the absent-denylist
  // disposition below is what fails CLOSED in CI.
  const leaks = terms ? scanForIdentityLeaks(terms, trackedFiles()) : [];
  const outcome = resolveIdentityLeakOutcome({ terms, ci, requireDenylist, leaks });
  const sink = outcome.level === "ok" ? console.log : outcome.level === "warn" ? console.warn : console.error;
  sink(outcome.message);
  process.exit(outcome.code);
}
if (process.argv[1]?.endsWith("identity-leak.ts")) main();
