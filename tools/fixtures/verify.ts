import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// REQ-112: fixture registry versioned in repo; CI references fixtures by hash.
// Pending rows print loudly on every run — no silent drops.
type Entry = { id: string; gates: string; status: "vendored" | "pending" | "planned"; path: string; sha256: string | null; source: string };
type Manifest = { fixtures: Entry[] };

function hashPath(p: string): string {
  const h = createHash("sha256");
  const walk = (f: string): void => {
    if (statSync(f).isDirectory()) {
      for (const child of readdirSync(f).sort()) walk(join(f, child));
    } else {
      h.update(f).update(readFileSync(f));
    }
  };
  walk(p);
  return h.digest("hex");
}

export function verifyManifest(manifest: Manifest): { ok: boolean; failures: string[]; pending: string[] } {
  const failures: string[] = [];
  const pending: string[] = [];
  for (const e of manifest.fixtures) {
    if (e.status !== "vendored") {
      pending.push(e.id);
      continue;
    }
    if (!existsSync(e.path)) {
      failures.push(`${e.id}: vendored but file missing at ${e.path}`);
      continue;
    }
    if (!e.sha256) {
      failures.push(`${e.id}: vendored without a pinned sha256`);
      continue;
    }
    const actual = hashPath(e.path);
    if (actual !== e.sha256) {
      failures.push(`${e.id}: hash mismatch (pinned ${e.sha256.slice(0, 12)}… actual ${actual.slice(0, 12)}…) — fixture changes require a register note`);
    }
  }
  return { ok: failures.length === 0, failures, pending };
}

function main(): void {
  const manifest = JSON.parse(readFileSync("fixtures/manifest.json", "utf8")) as Manifest;
  const r = verifyManifest(manifest);
  if (r.pending.length > 0) {
    console.warn(`PENDING FIXTURES (${r.pending.length}) — not yet vendored; sources are engagement-workspace manifest refs; legacy-export path is [CONFIRM]:`);
    for (const id of r.pending) console.warn(`  - ${id}`);
  }
  if (!r.ok) {
    for (const f of r.failures) console.error(`FAIL ${f}`);
    process.exit(1);
  }
  console.log("fixture registry verified");
}
if (process.argv[1]?.endsWith("verify.ts")) main();
