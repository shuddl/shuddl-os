import { execFileSync } from "node:child_process";

// V1 remediation Task 2 (build contract). The 1,131-test suite, the D1 append-only trigger semantics,
// and the vitest-pool-workers/chai chain were all verified under ONE runtime: Node 22.15.0 + pnpm 11.10.0.
// Node 20 mis-resolves that chain and changes D1 trigger behaviour, so a green run under Node 20 is not
// evidence of anything. This module is the single source of that contract and a fail-closed preflight.
//
// checkRuntime is PURE (no process, no spawn) so the contract is unit-testable; the CLI at the bottom
// reads the ACTUAL installed versions and exits non-zero on any mismatch.

export const RUNTIME_CONTRACT = {
  node: {
    version: "22.15.0", // .node-version — the exact verified Node
    engines: ">=22.15.0 <23", // package.json engines.node
    display: "22.15", // human line used in violation messages
    min: "22.15.0",
    maxExclusive: "23.0.0",
  },
  pnpm: {
    version: "11.10.0", // package.json engines.pnpm
    packageManager: "pnpm@11.10.0", // package.json packageManager (Corepack pin)
  },
} as const;

export type RuntimeCheck = { ok: boolean; violations: string[] };
type Semver = [number, number, number];

function parseSemver(raw: string): Semver {
  const core = raw.trim().replace(/^v/i, "").split(/[-+]/, 1)[0] ?? "";
  const parts = core.split(".").map((n) => Number.parseInt(n, 10));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function compare(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i += 1) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai !== bi) return ai < bi ? -1 : 1;
  }
  return 0;
}

// Pure contract check. `installed` are the raw version strings (a leading `v` is tolerated so
// process.version can be passed straight through).
export function checkRuntime(installed: { node: string; pnpm: string }): RuntimeCheck {
  const violations: string[] = [];

  const node = parseSemver(installed.node);
  const min = parseSemver(RUNTIME_CONTRACT.node.min);
  const maxExclusive = parseSemver(RUNTIME_CONTRACT.node.maxExclusive);
  if (compare(node, min) < 0 || compare(node, maxExclusive) >= 0) {
    violations.push(
      `Node ${RUNTIME_CONTRACT.node.display} required (${RUNTIME_CONTRACT.node.engines}); installed ${installed.node.trim()}`,
    );
  }

  if (installed.pnpm.trim() !== RUNTIME_CONTRACT.pnpm.version) {
    violations.push(
      `pnpm ${RUNTIME_CONTRACT.pnpm.version} required; installed ${installed.pnpm.trim()}`,
    );
  }

  return { ok: violations.length === 0, violations };
}

function installedPnpm(): string {
  try {
    return execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return "unavailable";
  }
}

function main(): void {
  const installed = { node: process.version, pnpm: installedPnpm() };
  const result = checkRuntime(installed);
  if (result.ok) {
    console.log(
      `runtime contract OK — Node ${installed.node} (${RUNTIME_CONTRACT.node.engines}), pnpm ${installed.pnpm}`,
    );
    process.exit(0);
  }
  console.error("FAIL runtime contract — the build is only verified under the pinned runtime:");
  console.error(`  required: Node ${RUNTIME_CONTRACT.node.engines}, pnpm ${RUNTIME_CONTRACT.pnpm.version}`);
  console.error(`  installed: Node ${installed.node}, pnpm ${installed.pnpm}`);
  for (const v of result.violations) console.error(`  - ${v}`);
  console.error("  activate it: `nvm use 22.15.0` (or read .node-version) and `corepack use pnpm@11.10.0`.");
  process.exit(1);
}

if (process.argv[1]?.endsWith("runtime-contract.ts")) main();
