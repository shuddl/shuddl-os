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
function gatesFor(profile: Profile): GateSpec[] {
  const plain: GateSpec[] = [
    { kind: "cmd", gate: "runtime", script: "check:runtime" },
    { kind: "cmd", gate: "typecheck", script: "typecheck" },
    { kind: "cmd", gate: "lint", script: "lint" },
    { kind: "cmd", gate: "unit-tests", script: "test" },
    { kind: "cmd", gate: "invariants", script: "check:invariants" },
    { kind: "cmd", gate: "rater-purity", script: "check:rater-purity" },
    { kind: "cmd", gate: "authority-coverage", script: "check:authority-coverage" },
    { kind: "cmd", gate: "traceability", script: "check:traceability" },
    { kind: "cmd", gate: "coverage", script: "check:coverage" },
    { kind: "cmd", gate: "seed", script: "check:seed" },
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
  ];
  if (profile === "merge") return [...plain, ...skippable];
  // release adds the infra evidence that this repo cannot produce without prod creds / Task-15 tooling —
  // declared BLOCKED, never faked green. These are the named external HOLDs.
  const releaseExternal: GateSpec[] = [
    { kind: "external", gate: "deploy-preflight", detail: "tools/deploy/preflight.ts (Task 15) + prod D1/R2/KV/queue/DO bindings, secrets, routes" },
    { kind: "external", gate: "restore-verify", detail: "tools/deploy/restore-verify.ts (Task 15) + a backup artifact to reconcile" },
    { kind: "external", gate: "staging-smoke", detail: "a deployed environment + JWT secret (tools/deploy/staging-smoke.ts)" },
    { kind: "external", gate: "backup-manifest", detail: "OIDC/external backup credentials (nightly export) — absent in-repo" },
  ];
  return [...plain, ...skippable, ...releaseExternal];
}

function synthesize(gate: string, exitCode: number | null): GateResult {
  if (exitCode === 0) return { gate, status: "PASS", executed: true, assertions: 1, detail: "command exited 0 (non-skippable command ran to completion)" };
  if (exitCode === EVIDENCE_EXIT.PREREQ_BLOCKED) return { gate, status: "BLOCKED", executed: false, assertions: 0, detail: "prerequisite blocked (exit 2)" };
  return { gate, status: "FAIL", executed: true, assertions: 1, detail: `command exited ${exitCode ?? "null"}` };
}

function runCmd(spec: Extract<GateSpec, { kind: "cmd" }>, profile: Profile): GateResult {
  const args = ["-s", spec.script];
  if (spec.modeArg) args.push("--", "--mode", profile);
  console.log(`\n── gate: ${spec.gate} (pnpm ${args.join(" ")}) ──`);
  const res = spawnSync("pnpm", args, { encoding: "utf8", timeout: 15 * 60_000 });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  if (out.trim()) process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
  if (res.error) return { gate: spec.gate, status: "FAIL", executed: false, assertions: 0, detail: `spawn error: ${res.error.message}` };
  // Prefer the gate's own structured result (last sentinel wins); else synthesize from the stable exit code.
  const own = parseGateResults(out);
  const last = own.length > 0 ? own[own.length - 1] : undefined;
  return last ? { ...last, gate: spec.gate } : synthesize(spec.gate, res.status);
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
  const context: PromotionContext = { commit, environment, fixturesHash: record.fixturesHash, deployment };
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

main();
