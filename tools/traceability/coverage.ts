import { existsSync, readFileSync } from "node:fs";
import { parseRegister, type ReqRow } from "./register.js";
import { scanSourceAnnotations } from "./orphans.js";
import { repoRoot } from "../checks/repo-root.js";

// REQ-118/119: the machine-checked 100%-register-coverage gate. WP-16's DoD is
// "register coverage 100%" (genesis/08:70). `check:traceability` only gates rows whose
// wp names an ACTIVE build WP and whose status is buildable — 34 rows (WP-all, WP-16,
// process, F1, every vNEXT/CONFIRM-GATED/deploy-note) are SILENTLY EXEMPT there. This gate
// closes that hole: EVERY register row is classified by a pure disposition function keyed on
// (status, wp), and each disposition carries an explicit accounting requirement, so a deferral
// is RECORDED, never silent. Append-only-aware: 100% must keep holding as the register grows.

// ── The 8 dispositions (+ an "unclassified" sentinel for genuinely-unaccounted rows) ─────────
export type Disposition =
  | "built-annotated" // 1: buildable status, active build WP — require a source annotation
  | "wp-all-always-on" // 2: wp=WP-all cross-cutting (REQ-024/039/119/133/163) — require an annotation
  | "vnext" // 3: named-future defer — require a recorded home
  | "confirm-gated" // 4: do-not-build-until-CONFIRM — require a recorded home
  | "deploy-note" // 5: infra/deploy prerequisite — require a recorded home
  | "launch-gate" // 6: WP-16 launch gate — require an annotation OR a recorded home
  | "ongoing-process" // 7: standing ritual (REQ-120) — require a recorded home
  | "foundation-f1" // 8: F1 foundation (REQ-144) — require a recorded home
  | "unclassified"; // sentinel: unknown/empty status, or a buildable row whose wp names no active WP

// Ordered for the report; "unclassified" last so a fully-covered register prints 0 there.
export const DISPOSITIONS = [
  "built-annotated",
  "wp-all-always-on",
  "vnext",
  "confirm-gated",
  "deploy-note",
  "launch-gate",
  "ongoing-process",
  "foundation-f1",
  "unclassified",
] as const satisfies readonly Disposition[];

const BUILT: ReadonlySet<Disposition> = new Set<Disposition>(["built-annotated", "wp-all-always-on"]);
const DEFERRED: ReadonlySet<Disposition> = new Set<Disposition>([
  "vnext",
  "confirm-gated",
  "deploy-note",
  "ongoing-process",
  "foundation-f1",
]);

// A "*-DISCOVERED" status is an audit-discovered-but-BUILT requirement (WP06/07/08-DISCOVERED …).
const DISCOVERED_RE = /^WP\d{2}-DISCOVERED$/;

function isBuildableStatus(status: string): boolean {
  return status === "F0-SPEC'D" || status === "F0.2-SPEC'D" || DISCOVERED_RE.test(status);
}

// Pure + total: every (status, wp) maps to exactly one Disposition. Status-keyed deferrals win
// first (a vNEXT/CONFIRM/deploy-note row defers regardless of which wp column it names); the
// remaining buildable rows are refined by their wp field.
export function disposition(row: ReqRow, activeWps: readonly string[]): Disposition {
  const status = row.status.trim();
  const wp = row.wp.trim();

  if (status === "vNEXT") return "vnext";
  if (status === "CONFIRM-GATED") return "confirm-gated";
  if (status === "F0-DEPLOY-NOTE") return "deploy-note";

  if (isBuildableStatus(status)) {
    if (wp === "WP-all") return "wp-all-always-on";
    if (wp.includes("WP-16")) return "launch-gate";
    if (wp === "ongoing") return "ongoing-process";
    if (wp === "F1") return "foundation-f1";
    if (activeWps.some((w) => wp.includes(w))) return "built-annotated";
    // Buildable, but its wp names no active/known home (e.g. scope added for a WP not yet opened
    // and not annotated): a genuine gap — fail loudly rather than silently exempt it.
    return "unclassified";
  }

  // Unknown or empty status — unaccounted scope entering the wrong door.
  return "unclassified";
}

export type CoverageResult = {
  total: number;
  perBucket: Record<Disposition, string[]>;
  unaccounted: { req_id: string; reason: string }[];
  drift: string[]; // vNEXT/*-DISCOVERED rows whose code HAS shipped (annotation exists) — advise advancing the tag
};

export function computeCoverage(input: {
  rows: readonly ReqRow[];
  annotations: ReadonlySet<string>;
  recordedHomes: ReadonlySet<string>;
  activeWps: readonly string[];
}): CoverageResult {
  const perBucket = Object.fromEntries(DISPOSITIONS.map((d) => [d, [] as string[]])) as Record<Disposition, string[]>;
  const unaccounted: { req_id: string; reason: string }[] = [];
  const drift: string[] = [];

  for (const row of input.rows) {
    const d = disposition(row, input.activeWps);
    perBucket[d].push(row.req_id);

    const annotated = input.annotations.has(row.req_id);
    const recorded = input.recordedHomes.has(row.req_id);

    if (d === "unclassified") {
      unaccounted.push({ req_id: row.req_id, reason: `unknown/empty status "${row.status.trim()}" or buildable row whose wp "${row.wp.trim()}" names no active WP` });
    } else if (BUILT.has(d)) {
      if (!annotated) unaccounted.push({ req_id: row.req_id, reason: `built disposition (${d}) with zero source annotations` });
    } else if (d === "launch-gate") {
      if (!annotated && !recorded) unaccounted.push({ req_id: row.req_id, reason: "launch-gate row with neither a source annotation nor a recorded disposition" });
    } else if (DEFERRED.has(d)) {
      if (!recorded) unaccounted.push({ req_id: row.req_id, reason: `deferred disposition (${d}) with no recorded home (GO-LIVE-CHECKLIST or coverage-manifest)` });
    }

    const status = row.status.trim();
    if ((status === "vNEXT" || DISCOVERED_RE.test(status)) && annotated) drift.push(row.req_id);
  }

  return { total: input.rows.length, perBucket, unaccounted, drift };
}

// A deferred row's "recorded home" is a REQ-\d{3} citation in the human coverage ledger
// (docs/ops/GO-LIVE-CHECKLIST.md) OR an entry in the coverage-manifest (for any deferral not yet
// threaded into the checklist). Same REQ-\d{3} matcher the annotation scan uses.
// §489 — repo-ANCHORED, not cwd-relative: an unhandled ENOENT off-root was this gate's only
// protection against scanning nothing, and that safety was incidental (see tools/checks/repo-root.ts).
const CHECKLIST_PATH = () => `${repoRoot()}/docs/ops/GO-LIVE-CHECKLIST.md`;
const MANIFEST_PATH = () => `${repoRoot()}/tools/traceability/coverage-manifest.json`;

type CoverageManifest = { dispositions?: Record<string, string> };

function readManifest(): CoverageManifest {
  if (!existsSync(MANIFEST_PATH())) return {};
  return JSON.parse(readFileSync(MANIFEST_PATH(), "utf8")) as CoverageManifest;
}

export function scanRecordedHomes(): Set<string> {
  const out = new Set<string>();
  if (existsSync(CHECKLIST_PATH())) {
    for (const m of readFileSync(CHECKLIST_PATH(), "utf8").matchAll(/REQ-\d{3}/g)) out.add(m[0]);
  }
  for (const id of Object.keys(readManifest().dispositions ?? {})) out.add(id);
  return out;
}

export function formatReport(res: CoverageResult): string {
  const classified = res.total - res.perBucket["unclassified"].length;
  const lines: string[] = [];
  lines.push(`check:coverage — register coverage report (${res.total} rows)`);
  for (const d of DISPOSITIONS) lines.push(`  ${d.padEnd(18)} : ${String(res.perBucket[d].length).padStart(3)}`);
  lines.push(`  ${"-".repeat(30)}`);
  lines.push(`  classified         : ${classified}/${res.total}  (unaccounted: ${res.unaccounted.length})`);
  return lines.join("\n");
}

function main(): void {
  const rows = parseRegister();
  const known = new Set(rows.map((r) => r.req_id));
  const activeWps = (JSON.parse(readFileSync(`${repoRoot()}/tools/traceability/active-wps.json`, "utf8")) as { active: string[] }).active;

  // Integrity: a coverage-manifest entry citing a non-existent register row is stale scope —
  // fail loudly (parallels the orphan detector's built-but-unspec'd direction).
  const staleManifest = Object.keys(readManifest().dispositions ?? {}).filter((id) => !known.has(id));

  const res = computeCoverage({
    rows,
    annotations: scanSourceAnnotations(),
    recordedHomes: scanRecordedHomes(),
    activeWps,
  });

  console.log(formatReport(res));

  if (res.drift.length > 0) {
    // 2026-08-01 audit: this line used to assert "code has shipped … advance at register review" — but a
    // drift row only proves a CITATION exists, and for some rows (REQ-184, REQ-276) every citation is a
    // fail-closed deferral marker, not an implementation. Following the old advice would mark unbuilt
    // scope as built. The message now says what the detector actually knows.
    console.log(`\ncoverage: ${res.drift.length} status-drift row(s) — a source citation exists while the register tag reads *-DISCOVERED/vNEXT. Per row, VERIFY whether the citation is an implementation or a deferral marker before advancing anything (the coverage-manifest NOTE pattern records the verdict): ${res.drift.join(", ")}`);
  }

  let failed = false;
  if (staleManifest.length > 0) {
    console.error(`\nFAIL coverage-manifest cites unregistered REQ-IDs: ${staleManifest.join(", ")}`);
    failed = true;
  }
  if (res.unaccounted.length > 0) {
    console.error(`\nFAIL ${res.unaccounted.length} unaccounted register row(s) — every row must be built+annotated or recorded-deferred:`);
    for (const u of res.unaccounted) console.error(`  ${u.req_id}: ${u.reason}`);
    failed = true;
  }
  if (failed) process.exit(1);

  console.log(`\ncoverage: 100% — all ${res.total} register rows accounted for (0 unaccounted).`);
}
if (process.argv[1]?.endsWith("coverage.ts")) main();
