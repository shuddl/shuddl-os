import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EVIDENCE_EXIT,
  evaluateEvidence,
  parseGateResults,
  type EvidenceRecord,
  type GateResult,
  type PromotionContext,
} from "./evidence.js";

// V1 remediation Task 3 (REQ-288). The promotion gate. Runs the complete merge/release surface from a
// clean checkout, records a STRUCTURED GateResult for each gate (a sentinel line when the gate emits one,
// otherwise synthesized from its stable exit code — never parsed from prose), writes a single evidence
// record under artifacts/release/<commit>/<environment>/, and exits with the aggregate promotion code:
//   0 PASS · 1 an executed assertion failed · 2 a prerequisite is BLOCKED/PENDING · 3 malformed/stale.
// A skip, an advisory, a pending private fixture, or an absent browser can NEVER be a green here.

type Profile = "merge" | "release";

// A gate is either a spawned command (its exit code / sentinel decides) or a statically-declared external
// hold that this repo cannot execute (release-only infra needing prod creds / Task-15 tooling).
type GateSpec =
  | { kind: "cmd"; gate: string; script: string; modeArg?: boolean }
  | { kind: "external"; gate: string; detail: string };

function parseProfile(argv: string[]): Profile {
  const i = argv.indexOf("--profile");
  const v = i >= 0 ? argv[i + 1] : undefined;
  if (v === "merge" || v === "release") return v;
  console.error("run-gate: --profile merge|release is required");
  process.exit(EVIDENCE_EXIT.MALFORMED);
}

// The complete merge surface (design §5 WP0). Skippable gates carry modeArg so they receive --mode <profile>
// and BLOCK instead of skipping. The heavy build/acceptance/browser jobs are ALSO wired into CI (Task 4);
// here the browser jobs BLOCK without a browser, which is the whole point.
export function gatesFor(profile: Profile): GateSpec[] {
  const plain: GateSpec[] = [
    { kind: "cmd", gate: "runtime", script: "check:runtime" },
    { kind: "cmd", gate: "typecheck", script: "typecheck" },
    { kind: "cmd", gate: "lint", script: "lint" },
    { kind: "cmd", gate: "unit-tests", script: "test" },
    { kind: "cmd", gate: "invariants", script: "check:invariants" },
    { kind: "cmd", gate: "rater-purity", script: "check:rater-purity" },
    // REQ-030/I3 (audit §56): the events table has exactly one application writer. The DB triggers fire on
    // COLLISIONS, so a direct insert with a fresh id is accepted and skips every gate — nothing else catches it.
    { kind: "cmd", gate: "append-chokepoint", script: "check:chokepoint" },
    { kind: "cmd", gate: "authority-coverage", script: "check:authority-coverage" },
    { kind: "cmd", gate: "traceability", script: "check:traceability" },
    { kind: "cmd", gate: "coverage", script: "check:coverage" },
    { kind: "cmd", gate: "seed", script: "check:seed" },
    // Doc-integrity gates. Both existed as hand-run tools and were enforced by NOTHING — audit §50 found
    // `check:citations` cited in five documents and wired into no gate, after it had caught four citation-rot
    // defects in one session purely because someone typed it. `check:tables` is new in that section: a markdown
    // row wider than its header renders with the extra cells DROPPED, which silently deleted a mitigation row
    // and three residual-risk statements from the threat model. A record gate nobody runs is not a gate.
    { kind: "cmd", gate: "citations", script: "check:citations" },
    { kind: "cmd", gate: "table-shape", script: "check:tables" },
    // Bundle ratchet (audit §483). Added HERE rather than as a bare CI step — §482 wired it straight into
    // ci.yml, which ran it but left it outside the gate envelope every other check reports through. It
    // still follows the build: CI builds before verify:merge. Depends on apps/*/dist existing.
    { kind: "cmd", gate: "bundle-ratchet", script: "check:bundles" },
    { kind: "cmd", gate: "acceptance", script: "test:acceptance" },
    { kind: "cmd", gate: "design-audit", script: "audit:design" },
  ];
  const skippable: GateSpec[] = [
    { kind: "cmd", gate: "identity-leak", script: "check:identity", modeArg: true },
    { kind: "cmd", gate: "fixtures", script: "check:fixtures", modeArg: true },
    { kind: "cmd", gate: "rater-parity", script: "check:rater-parity", modeArg: true },
    { kind: "cmd", gate: "invoice-parity", script: "check:invoice-parity", modeArg: true },
    { kind: "cmd", gate: "concierge-parse", script: "check:concierge-parity", modeArg: true },
    { kind: "cmd", gate: "perf", script: "perf:map", modeArg: true },
    { kind: "cmd", gate: "visual", script: "test:visual", modeArg: true },
    { kind: "cmd", gate: "a11y", script: "test:a11y", modeArg: true },
    { kind: "cmd", gate: "e2e", script: "test:e2e", modeArg: true },
  ];
  if (profile === "merge") return [...plain, ...skippable];
  // Release adds the infra evidence. Task 15 turned three of these from hardcoded "external" declarations
  // into REAL commands: each now runs, inspects what it can actually see, and returns its own structured
  // verdict — PASS when the environment genuinely satisfies it, BLOCKED (exit 2) when a prerequisite is
  // absent. That is strictly stronger than a hardcoded BLOCKED, which could never become a pass and so
  // could never tell you the environment had been fixed.
  const releaseInfra: GateSpec[] = [
    { kind: "cmd", gate: "deploy-preflight", script: "preflight", modeArg: true },
    { kind: "cmd", gate: "restore-verify", script: "restore:verify", modeArg: true },
    { kind: "cmd", gate: "staging-smoke", script: "smoke:staging", modeArg: true },
    // 2026-08-01 (audit, iteration 2): the deployed-surface proof enters the release record. The package
    // script bakes --mode release (no modeArg needed); without PROD_SURFACE_BASE it returns BLOCKED
    // (exit 2) with its own sentinel — the same env-guarded field posture as staging-smoke. It hits the
    // public internet, so it deliberately does NOT run under the merge profile.
    { kind: "cmd", gate: "surfaces", script: "test:surfaces" },
    // The backup manifest is produced by the nightly workflow against external credentials; nothing in a
    // release run can synthesize one, so it stays a declared hold.
    { kind: "external", gate: "backup-manifest", detail: "OIDC/external backup credentials (.github/workflows/nightly.yml) — absent in-repo" },
  ];
  return [...plain, ...skippable, ...releaseInfra];
}

function synthesize(gate: string, exitCode: number | null): GateResult {
  if (exitCode === 0) return { gate, status: "PASS", executed: true, assertions: 1, detail: "command exited 0 (non-skippable command ran to completion)" };
  if (exitCode === EVIDENCE_EXIT.PREREQ_BLOCKED) return { gate, status: "BLOCKED", executed: false, assertions: 0, detail: "prerequisite blocked (exit 2)" };
  return { gate, status: "FAIL", executed: true, assertions: 1, detail: `command exited ${exitCode ?? "null"}` };
}

// 2026-08-01 audit (test-debt): a sentinel may DEGRADE an exit-0 run but may never UPGRADE a failing one.
// The last ##SHUDDL-GATE## line in a child's combined output used to win outright — but wrapper gates
// (unit-tests captures the full output of every workspace run) relay NESTED children's sentinels, so a
// nested PASS printed before the wrapper failed recorded PASS. Where sentinel and exit code disagree, the
// pessimistic verdict wins: exit 1/null ⇒ FAIL, exit 2 ⇒ BLOCKED, each naming the disagreement.
// Exported for its unit test; returns undefined when there is no sentinel (caller synthesizes).
export function reconcileSentinel(gate: string, sentinel: GateResult | undefined, exitCode: number | null): GateResult | undefined {
  if (sentinel === undefined) return undefined;
  const own = { ...sentinel, gate };
  if (exitCode === 0 || own.status !== "PASS") return own;
  const status = exitCode === EVIDENCE_EXIT.PREREQ_BLOCKED ? "BLOCKED" : "FAIL";
  return { ...own, status, detail: `sentinel said PASS but the command exited ${exitCode ?? "null"} — the exit code wins (the PASS may be a nested child's): ${own.detail}` };
}

function runCmd(spec: Extract<GateSpec, { kind: "cmd" }>, profile: Profile): GateResult {
  const args = ["-s", spec.script];
  if (spec.modeArg) args.push("--", "--mode", profile);
  console.log(`\n── gate: ${spec.gate} (pnpm ${args.join(" ")}) ──`);
  const res = spawnSync("pnpm", args, { encoding: "utf8", timeout: 15 * 60_000 });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  if (out.trim()) process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
  if (res.error) return { gate: spec.gate, status: "FAIL", executed: false, assertions: 0, detail: `spawn error: ${res.error.message}` };
  // Prefer the gate's own structured result (last sentinel wins), reconciled against the exit code so a
  // nested sentinel can never out-green a failing command; else synthesize from the stable exit code.
  const own = parseGateResults(out);
  return reconcileSentinel(spec.gate, own.length > 0 ? own[own.length - 1] : undefined, res.status) ?? synthesize(spec.gate, res.status);
}

function gitHead(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown-commit";
  }
}

function fixturesHash(): string {
  try {
    return createHash("sha256").update(readFileSync("fixtures/manifest.json")).digest("hex");
  } catch {
    return "0".repeat(64);
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const profile = parseProfile(argv);
  const commit = gitHead();
  const environment = profile === "merge" ? "merge" : process.env["RELEASE_ENVIRONMENT"] ?? "staging";
  const deployment = profile === "merge" ? "n/a" : process.env["DEPLOYMENT_VERSION"] ?? "unresolved";
  const generatedAt = new Date().toISOString();
  const ttlMs = (profile === "merge" ? 24 : 72) * 60 * 60_000;
  const expiresAt = new Date(Date.parse(generatedAt) + ttlMs).toISOString();

  console.log(`run-gate: profile=${profile} commit=${commit.slice(0, 12)} environment=${environment} deployment=${deployment}`);

  const gates: GateResult[] = [];
  for (const spec of gatesFor(profile)) {
    if (spec.kind === "external") {
      console.log(`\n── gate: ${spec.gate} (external HOLD) ──\n${spec.gate}: BLOCKED — ${spec.detail}`);
      gates.push({ gate: spec.gate, status: "BLOCKED", executed: false, assertions: 0, detail: spec.detail });
      continue;
    }
    gates.push(runCmd(spec, profile)); // continue-through: every gate runs so the record is complete
  }

  const record: EvidenceRecord = { commit, environment, profile, generatedAt, expiresAt, fixturesHash: fixturesHash(), deployment, gates };

  // 2026-08-02 §16 — THE CONTEXT IS RE-OBSERVED, NOT COPIED (REQ-288).
  //
  // This used to read `{ commit, environment, fixturesHash: record.fixturesHash, deployment }` — the very
  // variables `record` was just built from — so every comparison in evaluateEvidence compared a value with
  // itself and the SHA/environment/fixtures/deployment mismatch checks could never fire. The detection
  // logic is real and unit-tested in evidence.test.ts; only this wiring made it inert in its one live
  // consumer. That is the same "the gate could not fail" defect class this audit has been closing all
  // session, and it was ledgered Low only because no separate promote step exists yet.
  //
  // Re-reading the world AFTER the gates ran turns the checks into a genuine STALENESS guard, which is
  // what a record spanning a multi-minute gate run actually needs: if a commit lands, the fixtures manifest
  // changes, or the environment/deployment variables move WHILE the gates are running, the record no
  // longer describes the tree it claims to describe — and that is now caught rather than certified. In CI
  // the checkout is fixed, so these re-reads are stable and a mismatch is always a true positive.
  const context: PromotionContext = {
    commit: gitHead(),
    environment: profile === "merge" ? "merge" : process.env["RELEASE_ENVIRONMENT"] ?? "staging",
    fixturesHash: fixturesHash(),
    deployment: profile === "merge" ? "n/a" : process.env["DEPLOYMENT_VERSION"] ?? "unresolved",
  };
  const evaluation = evaluateEvidence(record, context, new Date().toISOString());

  // Write the evidence artifact even when a gate fails (design §5 exit). artifacts/ is gitignored.
  const dir = join("artifacts", "release", commit, environment);
  mkdirSync(dir, { recursive: true });
  const artifactPath = join(dir, `gate-${profile}-${generatedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(artifactPath, `${JSON.stringify({ record, evaluation }, null, 2)}\n`);

  // Summary.
  console.log("\n════ merge/release evidence ════");
  for (const g of gates) console.log(`  ${g.status.padEnd(14)} ${g.gate}${g.detail ? ` — ${g.detail}` : ""}`);
  console.log(`\nartifact: ${artifactPath}`);
  console.log(`aggregate: ${evaluation.status} (exit ${evaluation.exitCode})`);
  if (evaluation.reasons.length > 0) {
    console.log("blocking reasons:");
    for (const r of evaluation.reasons) console.log(`  - ${r}`);
  }
  if (evaluation.exitCode === EVIDENCE_EXIT.PREREQ_BLOCKED) {
    console.log("\nNOT PROMOTABLE — a prerequisite is BLOCKED (absent denylist / browser / private fixtures / release infra). This is NOT a green.");
  } else if (evaluation.exitCode === EVIDENCE_EXIT.OK) {
    console.log("\nPROMOTABLE — every gate executed with assertions and passed.");
  }
  process.exit(evaluation.exitCode);
}

// Guarded (playwright-guard precedent) so the reconcileSentinel unit test can import this module without
// executing a full gate run. Both verify scripts invoke this file directly, so the guard always passes there.
if (process.argv[1] !== undefined && /run-gate\.ts$/.test(process.argv[1])) main();
