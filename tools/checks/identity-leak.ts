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
  if (!terms) {
    console.warn(
      "REQ-167: no denylist available (set IDENTITY_DENYLIST secret or .identity-denylist.local). Lint SKIPPED — wire the secret before external contributions.",
    );
    return;
  }
  const leaks = scanForIdentityLeaks(terms, trackedFiles());
  if (leaks.length > 0) {
    for (const l of leaks) console.error(`FAIL REQ-167 identity leak in ${l.file}: ${l.masked}`);
    process.exit(1);
  }
  console.log(`identity-leak lint: clean (${terms.length} terms checked)`);
}
if (process.argv[1]?.endsWith("identity-leak.ts")) main();
