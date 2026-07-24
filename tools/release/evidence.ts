// V1 remediation Task 3 (REQ-288). Release promotion consumes ONLY complete evidence records tied to the
// exact commit, environment, fixtures, deployment, and EXECUTED assertions. A skip, a pending, an advisory,
// a stub, a stale record, or any mismatch must NEVER promote. This module is the single, PURE source of
// that state machine (no process, no I/O) so it is unit-testable; run-gate.ts and any promote consumer
// wrap it. The gate CLIs return structured results — this never parses human prose.

export type GateStatus = "PASS" | "FAIL" | "BLOCKED" | "PENDING" | "NOT_APPLICABLE";
export type GateMode = "local" | "merge" | "release";

// Stable process exit codes (design §4). Promotion tooling depends on these being fixed.
export const EVIDENCE_EXIT = {
  OK: 0, // a valid PASS record
  ASSERTIONS_FAILED: 1, // an executed assertion set failed
  PREREQ_BLOCKED: 2, // a prerequisite is BLOCKED/PENDING (browser, denylist, private fixtures, …)
  MALFORMED: 3, // malformed / stale / mismatched evidence
} as const;

// Thrown for a structurally malformed evidence artifact — carries the dedicated exit code so the CLI can
// exit deterministically without re-deriving it.
export class EvidenceError extends Error {
  readonly exitCode = EVIDENCE_EXIT.MALFORMED;
  constructor(message: string) {
    super(message);
    this.name = "EvidenceError";
  }
}

export type GateResult = {
  gate: string;
  status: GateStatus;
  executed: boolean;
  assertions: number;
  detail?: string;
};

export type EvidenceRecord = {
  commit: string;
  environment: string;
  profile: "merge" | "release";
  generatedAt: string; // ISO 8601
  expiresAt: string; // ISO 8601
  fixturesHash: string;
  deployment: string; // deployment version/SHA; "n/a" for a pre-deploy merge gate
  gates: GateResult[];
};

export type PromotionContext = {
  commit: string;
  environment: string;
  fixturesHash: string;
  deployment: string;
};

export type EvidenceEvaluation = {
  ok: boolean;
  exitCode: number;
  status: GateStatus; // the aggregate disposition of the record
  reasons: string[];
};

const STATUSES: readonly GateStatus[] = ["PASS", "FAIL", "BLOCKED", "PENDING", "NOT_APPLICABLE"];

// A single gate result is well-formed iff a PASS is backed by real execution + at least one assertion, and
// the numeric/boolean fields are sane. Returns a human reason, or null when clean.
export function gateResultProblem(g: GateResult): string | null {
  if (!g || typeof g.gate !== "string" || g.gate.length === 0) return "gate name missing";
  if (!STATUSES.includes(g.status)) return `unknown status ${String(g.status)}`;
  if (typeof g.executed !== "boolean") return "executed must be boolean";
  if (!Number.isInteger(g.assertions) || g.assertions < 0) return "assertions must be a non-negative integer";
  if (g.status === "PASS" && !g.executed) return `${g.gate}: PASS requires executed=true (a PASS that never ran is fabricated)`;
  if (g.status === "PASS" && g.assertions <= 0) return `${g.gate}: PASS requires assertions>0 (a PASS asserting nothing is a skip in disguise)`;
  return null;
}

function recordProblems(record: EvidenceRecord): string[] {
  const problems: string[] = [];
  const required: [string, unknown][] = [
    ["commit", record?.commit],
    ["environment", record?.environment],
    ["generatedAt", record?.generatedAt],
    ["expiresAt", record?.expiresAt],
    ["fixturesHash", record?.fixturesHash],
    ["deployment", record?.deployment],
  ];
  for (const [k, v] of required) if (typeof v !== "string" || v.length === 0) problems.push(`missing ${k}`);
  if (record?.profile !== "merge" && record?.profile !== "release") problems.push("profile must be 'merge' or 'release'");
  if (!Array.isArray(record?.gates) || record.gates.length === 0) {
    problems.push("gates missing or empty — a record that asserted nothing proves nothing");
    return problems;
  }
  for (const g of record.gates) {
    const p = gateResultProblem(g);
    if (p) problems.push(p);
  }
  return problems;
}

function contextMismatches(record: EvidenceRecord, ctx: PromotionContext): string[] {
  const out: string[] = [];
  if (record.commit !== ctx.commit) out.push(`commit mismatch (record ${record.commit} vs context ${ctx.commit})`);
  if (record.environment !== ctx.environment) out.push(`environment mismatch (record ${record.environment} vs context ${ctx.environment})`);
  if (record.fixturesHash !== ctx.fixturesHash) out.push(`fixtures-hash mismatch (record ${record.fixturesHash.slice(0, 12)}… vs context ${ctx.fixturesHash.slice(0, 12)}…)`);
  if (record.deployment !== ctx.deployment) out.push(`deployment mismatch (record ${record.deployment} vs context ${ctx.deployment})`);
  return out;
}

// THE decision. Precedence: malformed/stale/mismatched (3) → executed failure (1) → blocked prereq (2) → OK.
// A real assertion FAILURE (1) outranks a BLOCKED prerequisite (2): a broken build is worse than an absent one.
export function evaluateEvidence(record: EvidenceRecord, ctx: PromotionContext, nowIso: string): EvidenceEvaluation {
  const shape = recordProblems(record);
  if (shape.length > 0) return { ok: false, exitCode: EVIDENCE_EXIT.MALFORMED, status: "FAIL", reasons: shape };

  const now = Date.parse(nowIso);
  const expires = Date.parse(record.expiresAt);
  const generated = Date.parse(record.generatedAt);
  if (Number.isNaN(now) || Number.isNaN(expires) || Number.isNaN(generated)) {
    return { ok: false, exitCode: EVIDENCE_EXIT.MALFORMED, status: "FAIL", reasons: ["unparseable generatedAt/expiresAt/now timestamp"] };
  }
  if (now > expires) {
    return { ok: false, exitCode: EVIDENCE_EXIT.MALFORMED, status: "FAIL", reasons: [`evidence expired at ${record.expiresAt} (now ${nowIso})`] };
  }

  const mismatches = contextMismatches(record, ctx);
  if (mismatches.length > 0) return { ok: false, exitCode: EVIDENCE_EXIT.MALFORMED, status: "FAIL", reasons: mismatches };

  const failed = record.gates.filter((g) => g.status === "FAIL");
  if (failed.length > 0) {
    return { ok: false, exitCode: EVIDENCE_EXIT.ASSERTIONS_FAILED, status: "FAIL", reasons: failed.map((g) => `${g.gate}: FAIL${g.detail ? ` — ${g.detail}` : ""}`) };
  }
  const blocked = record.gates.filter((g) => g.status === "BLOCKED" || g.status === "PENDING");
  if (blocked.length > 0) {
    return { ok: false, exitCode: EVIDENCE_EXIT.PREREQ_BLOCKED, status: "BLOCKED", reasons: blocked.map((g) => `${g.gate}: ${g.status}${g.detail ? ` — ${g.detail}` : ""}`) };
  }
  return { ok: true, exitCode: EVIDENCE_EXIT.OK, status: "PASS", reasons: [] };
}

// ── Gate mode + missing-prerequisite disposition ─────────────────────────────────────────────────────────

export function parseMode(argv: string[]): GateMode {
  const i = argv.indexOf("--mode");
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v === "merge" || v === "release" || v === "local" ? v : "local";
}

// The one disposition rule the skippable gates share: a MISSING external prerequisite (no browser, no
// denylist, unvendored private fixtures) is a developer-convenience PENDING locally (exit 0) but a
// non-negotiable BLOCKED (exit 2) under merge/release — never a green.
export function unavailableStatus(mode: GateMode): { status: GateStatus; exitCode: number } {
  if (mode === "local") return { status: "PENDING", exitCode: EVIDENCE_EXIT.OK };
  return { status: "BLOCKED", exitCode: EVIDENCE_EXIT.PREREQ_BLOCKED };
}

// ── Structured gate-result wire protocol (run-gate ⇄ gate CLI) ────────────────────────────────────────────
// A single machine-readable line a gate CLI prints so run-gate reads a STRUCTURED result, never its prose.

const SENTINEL = "##SHUDDL-GATE##";

export function formatGateResult(g: GateResult): string {
  return `${SENTINEL} ${JSON.stringify(g)}`;
}

export function parseGateResults(output: string): GateResult[] {
  const out: GateResult[] = [];
  for (const line of output.split(/\r?\n/)) {
    const idx = line.indexOf(SENTINEL);
    if (idx < 0) continue;
    try {
      const parsed = JSON.parse(line.slice(idx + SENTINEL.length).trim()) as GateResult;
      if (!gateResultProblem(parsed)) out.push(parsed);
      else out.push(parsed); // keep even if imperfect so run-gate can surface it; evaluate() re-validates
    } catch {
      /* not a well-formed sentinel — ignore */
    }
  }
  return out;
}

// Convenience for a gate CLI: print the human line AND the machine sentinel, then return the exit code.
export function reportGate(g: GateResult, human: string): number {
  const sink = g.status === "PASS" || g.status === "NOT_APPLICABLE" ? console.log : g.status === "FAIL" ? console.error : console.warn;
  sink(human);
  console.log(formatGateResult(g));
  if (g.status === "FAIL") return EVIDENCE_EXIT.ASSERTIONS_FAILED;
  if (g.status === "BLOCKED") return EVIDENCE_EXIT.PREREQ_BLOCKED;
  return EVIDENCE_EXIT.OK; // PASS, PENDING (local), NOT_APPLICABLE
}
