import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
// V1 remediation Task 3 (REQ-288): pending private fixtures are advisory locally but a non-promotable
// BLOCKED under merge/release. run-gate consumes the structured GateResult, never this file's prose.
import { parseMode, unavailableStatus, formatGateResult, type GateMode, type GateResult } from "../release/evidence.js";

// REQ-112: fixture registry versioned in repo; CI references fixtures by hash.
// Pending rows print loudly on every run — no silent drops.
type Entry = { id: string; gates: string; status: "vendored" | "pending" | "planned" | "in-repo-test"; path: string; sha256: string | null; source: string };
type Manifest = { fixtures: Entry[] };

/**
 * The fixture-tree digest. FRAMED (2026-08-01, audit §10): each entry contributes its path and its
 * bytes with EXPLICIT LENGTH PREFIXES, so the stream is injective over file trees. Unframed, the
 * concatenation `path₁‖bytes₁‖path₂‖bytes₂…` could in principle collide — bytes shifted between a
 * filename and its content, or across adjacent entries, produce the identical stream. The framing
 * makes that impossible rather than merely improbable.
 *
 * Changing this changes EVERY digest, which is why the audit deferred it until it could land together
 * with a re-pin of all vendored sha256s in one commit (the manifest note records the re-pin).
 */
export function hashPath(p: string): string {
  const h = createHash("sha256");
  const frame = (bytes: Buffer | string): void => {
    const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
    h.update(`${buf.length}:`); // length prefix — the delimiter that makes the stream injective
    h.update(buf);
  };
  const walk = (f: string): void => {
    if (statSync(f).isDirectory()) {
      for (const child of readdirSync(f).sort()) walk(join(f, child));
    } else {
      frame(f);
      frame(readFileSync(f));
    }
  };
  walk(p);
  return h.digest("hex");
}

export function verifyManifest(manifest: Manifest): { ok: boolean; failures: string[]; pending: string[] } {
  const failures: string[] = [];
  const pending: string[] = [];
  for (const e of manifest.fixtures) {
    if (e.status === "in-repo-test") {
      // A git-tracked, CI-executed test (not byte-frozen data): presence-checked, never hash-pinned.
      // It legitimately churns (every edit would trip a hash pin and erode the tripwire for the real
      // frozen-data fixtures), so we guard only that it still EXISTS — deleting it turns CI red.
      if (!existsSync(e.path)) failures.push(`${e.id}: in-repo-test missing at ${e.path}`);
      continue;
    }
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

// The one disposition decision the CLI wraps, as a PURE function (REQ-288). A real failure (missing/hash
// mismatch) is FAIL regardless of mode; a PENDING (unvendored private) fixture is advisory locally but
// BLOCKED under merge/release. `verifiedCount` is the number of entries actively checked (never zero on a
// real manifest) so a PASS always carries assertions>0.
export function fixtureGateResult(mode: GateMode, r: { ok: boolean; failures: string[]; pending: string[] }, verifiedCount: number): GateResult {
  if (!r.ok) return { gate: "fixtures", status: "FAIL", executed: true, assertions: verifiedCount, detail: r.failures.join("; ") };
  if (r.pending.length > 0) {
    const { status } = unavailableStatus(mode);
    return { gate: "fixtures", status, executed: false, assertions: 0, detail: `pending (not vendored): ${r.pending.join(", ")}` };
  }
  return { gate: "fixtures", status: "PASS", executed: true, assertions: verifiedCount, detail: "registry verified" };
}

function main(): void {
  const mode = parseMode(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync("fixtures/manifest.json", "utf8")) as Manifest;
  const r = verifyManifest(manifest);
  if (r.pending.length > 0) {
    console.warn(`PENDING FIXTURES (${r.pending.length}) — not yet vendored; sources are engagement-workspace manifest refs; legacy-export path is [CONFIRM]:`);
    for (const id of r.pending) console.warn(`  - ${id}`);
  }
  const verifiedCount = manifest.fixtures.length - r.pending.length;
  const g = fixtureGateResult(mode, r, verifiedCount);
  if (g.status === "FAIL") {
    for (const f of r.failures) console.error(`FAIL ${f}`);
    console.log(formatGateResult(g));
    process.exit(1);
  }
  if (g.status === "BLOCKED") {
    console.error(`fixtures: BLOCKED under --mode ${mode} — ${r.pending.length} fixture(s) not vendored; a merge/release gate does not green on absent private fixtures.`);
    console.log(formatGateResult(g));
    process.exit(2);
  }
  // PASS, or PENDING under local (advisory, exit 0) — current behaviour preserved.
  console.log("fixture registry verified");
  console.log(formatGateResult(g));
}
if (process.argv[1]?.endsWith("verify.ts")) main();
