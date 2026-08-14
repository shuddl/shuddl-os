import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
// V1 remediation Task 3 (REQ-288): pending private fixtures are advisory locally but a non-promotable
// BLOCKED under merge/release. run-gate consumes the structured GateResult, never this file's prose.
import { parseMode, unavailableStatus, formatGateResult, type GateMode, type GateResult } from "../release/evidence.js";
import { repoRoot } from "../checks/repo-root.js";

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
export function hashPath(p: string, root?: string): string {
  const h = createHash("sha256");
  const frame = (bytes: Buffer | string): void => {
    const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
    h.update(`${buf.length}:`); // length prefix — the delimiter that makes the stream injective
    h.update(buf);
  };
  // The PATH is framed as well as the bytes, so a rename is a digest change (that is the point). It must
  // therefore stay exactly as the caller wrote it — repo-relative for manifest rows — while the I/O resolves
  // against `root`. Framing the resolved path instead would make every pinned sha256 depend on where the
  // repo is checked out, which is how a first pass at §559 turned six vendored fixtures into hash mismatches.
  const walk = (rel: string): void => {
    const abs = root === undefined ? rel : join(root, rel);
    if (statSync(abs).isDirectory()) {
      for (const child of readdirSync(abs).sort()) walk(join(rel, child));
    } else {
      frame(rel);
      frame(readFileSync(abs));
    }
  };
  walk(p);
  return h.digest("hex");
}

export function verifyManifest(manifest: Manifest, root: string = repoRoot()): { ok: boolean; failures: string[]; pending: string[] } {
  const failures: string[] = [];
  const pending: string[] = [];
  for (const e of manifest.fixtures) {
    // e.path is repo-relative BY DESIGN (it is what the manifest and every message should show);
    // resolve it for the filesystem so the gate does not depend on the caller's cwd (§559).
    const abs = `${root}/${e.path}`;
    if (e.status === "in-repo-test") {
      // A git-tracked, CI-executed test (not byte-frozen data): presence-checked, never hash-pinned.
      // It legitimately churns (every edit would trip a hash pin and erode the tripwire for the real
      // frozen-data fixtures), so we guard only that it still EXISTS — deleting it turns CI red.
      if (!existsSync(abs)) failures.push(`${e.id}: in-repo-test missing at ${e.path}`);
      continue;
    }
    if (e.status !== "vendored") {
      pending.push(e.id);
      continue;
    }
    if (!existsSync(abs)) {
      failures.push(`${e.id}: vendored but file missing at ${e.path}`);
      continue;
    }
    if (!e.sha256) {
      failures.push(`${e.id}: vendored without a pinned sha256`);
      continue;
    }
    const actual = hashPath(e.path, root);
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
  const manifest = JSON.parse(readFileSync(`${repoRoot()}/fixtures/manifest.json`, "utf8")) as Manifest;
  
  // §1387 — THE MANIFEST IS THE CORPUS, SO ITS EMPTINESS IS A BROKEN GATE, NEVER A CLEAN ONE.
  //
  // MEASURED 2026-08-13: with the 17 fixtures present, `--mode merge` exits 2 (BLOCKED, five unvendored
  // private fixtures). With `fixtures: []` it exits **0** — nothing pending, nothing failing, so the gate
  // reports PASS. Emptying this file therefore REMOVES one of the five BLOCKs from the merge board and
  // disables every hash pin at the same time, while the board reads closer to promotable.
  //
  // §1148's rule, on a constitutional gate whose PASS path has never run in anger: a floor must bound the
  // corpus the gate READ, not the violations it found. The named ids are the two CLAUDE.md rule 4 calls out
  // by name, so if the law's own examples vanish from the manifest this fails loudly rather than quietly.
  const REQUIRED_IDS = ["rater-504-sweep", "rater-48-tests"] as const;
  if (manifest.fixtures.length < 10) {
    console.error(
      `fixtures: BROKEN — the manifest lists ${manifest.fixtures.length} fixture(s); there were 17 at §1387. ` +
        "An empty or truncated manifest reports PASS because nothing is pending and nothing mismatches, which " +
        "silently clears a merge BLOCK and disables every hash pin. Restore the manifest.",
    );
    process.exit(1);
  }
  const missing = REQUIRED_IDS.filter((id) => !manifest.fixtures.some((f) => f.id === id));
  if (missing.length > 0) {
    console.error(
      `fixtures: BROKEN — CLAUDE.md rule 4 names ${missing.join(", ")} as the private-fixture holds, and the ` +
        "manifest no longer lists them. Either the law changed and this list must follow, or the manifest lost " +
        "an entry the build claims to be waiting on.",
    );
    process.exit(1);
  }
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
