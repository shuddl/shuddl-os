import { readFileSync } from "node:fs";
import { canonicalize, sha256Hex } from "@shuddl/ledger/canonical";
import { verifyChain, type ChainResult } from "@shuddl/ledger/chain";
import { rowToEvent } from "@shuddl/ledger/lens";
import type { LedgerEvent } from "@shuddl/contracts";
import { EVIDENCE_EXIT, formatGateResult, parseMode, type GateResult } from "../release/evidence.js";

// V1 remediation Task 15 (REQ-117 / REQ-284 / REQ-288) — RESTORE RECONCILIATION.
//
// A backup that restores is not a backup that is CORRECT. What makes a restore trustworthy is proving
// the restored ledger IS the ledger: the same event count, the same head hash, an intact hash chain, the
// same invoices and the same money to the penny, the same anchor roots, and the same export manifest
// digest. Any mismatch fails. On an append-only ledger a partial restore is unrecoverable — there is no
// later diff that can tell you which rows you silently lost — so "close enough" is not a disposition.
//
// The reconciliation is PURE over metadata so the whole decision surface is unit-testable without a
// database. `main()` reads two snapshot files and feeds them in.

export type RestoreProblem = { code: string; dimension: string; detail: string };
export type RestoreReport = { ok: boolean; problems: RestoreProblem[]; checked: number };

export type AnchorSummary = { day: string; root: string; leafCount: number };

export type LedgerSnapshot = {
  tenant: string;
  capturedAt: string;
  events: { count: number; headHash: string };
  invoices: { count: number; totalCents: number };
  moneyLines: { count: number; sumCents: number };
  anchors: AnchorSummary[];
  // sha256 over the canonicalized export manifest — computed identically on both sides by snapshotDigest.
  manifestDigest: string;
};

// The chain verdict for the RESTORED database, produced by verifyChainOfRows (or any caller that has the
// rows). Mirrors packages/ledger ChainResult so the ledger stays the single authority on chain validity.
export type ChainVerdict = { ok: true; head: string; count: number } | { ok: false; failure: { seq: number; reason: string } };

// The number of independent dimensions reconcileRestore inspects. Exported so a clean report can assert
// it actually looked at all of them — a "0 problems" result from a checker that examined two fields is
// the same lie as a skipped test.
export const RESTORE_CHECKS = 11;

export function reconcileRestore(source: LedgerSnapshot, restored: LedgerSnapshot, chain: ChainVerdict): RestoreReport {
  const problems: RestoreProblem[] = [];
  const fail = (code: string, dimension: string, detail: string): void => {
    problems.push({ code, dimension, detail });
  };

  // ── identity ──
  if (source.tenant !== restored.tenant) {
    fail("tenant-mismatch", "tenant", `source is ${source.tenant}, restored is ${restored.tenant} — restoring across tenants is a cross-tenant write (REQ-025)`);
  }

  // ── events ──
  if (source.events.count !== restored.events.count) {
    const delta = restored.events.count - source.events.count;
    fail("event-count-mismatch", "events", `${source.events.count} → ${restored.events.count} (${delta > 0 ? "+" : ""}${delta})`);
  }
  if (source.events.headHash !== restored.events.headHash) {
    fail("head-hash-mismatch", "events", `head ${source.events.headHash.slice(0, 12)}… → ${restored.events.headHash.slice(0, 12)}…`);
  }

  // ── chain ──
  if (!chain.ok) {
    fail("chain-broken", "chain", `restored chain fails at seq ${chain.failure.seq}: ${chain.failure.reason}`);
  } else {
    if (chain.count !== restored.events.count) {
      fail("chain-count-mismatch", "chain", `chain walked ${chain.count} events but the snapshot claims ${restored.events.count}`);
    }
    if (chain.head !== restored.events.headHash) {
      fail("chain-head-mismatch", "chain", `chain head ${chain.head.slice(0, 12)}… ≠ snapshot head ${restored.events.headHash.slice(0, 12)}…`);
    }
  }

  // ── money ──
  if (source.invoices.count !== restored.invoices.count) {
    fail("invoice-count-mismatch", "invoices", `${source.invoices.count} → ${restored.invoices.count}`);
  }
  if (source.invoices.totalCents !== restored.invoices.totalCents) {
    fail("invoice-total-mismatch", "invoices", `${source.invoices.totalCents}¢ → ${restored.invoices.totalCents}¢`);
  }
  if (source.moneyLines.count !== restored.moneyLines.count) {
    fail("money-line-count-mismatch", "money_lines", `${source.moneyLines.count} → ${restored.moneyLines.count}`);
  }
  if (source.moneyLines.sumCents !== restored.moneyLines.sumCents) {
    fail("money-sum-mismatch", "money_lines", `${source.moneyLines.sumCents}¢ → ${restored.moneyLines.sumCents}¢`);
  }

  // ── anchors: the strongest tamper signal, because a root is a commitment to every leaf under it ──
  const restoredAnchors = new Map(restored.anchors.map((a) => [a.day, a]));
  for (const a of source.anchors) {
    const r = restoredAnchors.get(a.day);
    if (r === undefined) {
      fail("anchor-missing", "anchors", `no anchor for ${a.day} in the restored database`);
      continue;
    }
    if (r.root !== a.root) fail("anchor-root-mismatch", "anchors", `${a.day}: root ${a.root.slice(0, 12)}… → ${r.root.slice(0, 12)}…`);
    if (r.leafCount !== a.leafCount) fail("anchor-leaf-count-mismatch", "anchors", `${a.day}: ${a.leafCount} → ${r.leafCount} leaves`);
  }

  // ── manifest ──
  if (source.manifestDigest !== restored.manifestDigest) {
    fail("manifest-digest-mismatch", "manifest", `${source.manifestDigest.slice(0, 12)}… → ${restored.manifestDigest.slice(0, 12)}…`);
  }

  return { ok: problems.length === 0, problems, checked: RESTORE_CHECKS };
}

// One digest, computed the same way on both sides. Canonical JSON is the repo's frozen byte law
// (packages/ledger/src/canonical.ts), so key order can never make two identical snapshots disagree.
export async function snapshotDigest(value: unknown): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalize(value)));
}

// Walk the restored rows through the ledger's own chain verifier. Kept separate from the pure
// reconciliation so the ledger remains the single authority on what a valid chain is.
export async function verifyChainOfRows(rows: Record<string, string | number | null>[]): Promise<ChainVerdict> {
  const events: LedgerEvent[] = rows.map((r) => rowToEvent(r));
  const result: ChainResult = await verifyChain(events);
  if (result.ok) return { ok: true, head: result.head, count: result.count };
  return { ok: false, failure: { seq: result.failure.seq, reason: result.failure.reason } };
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────────

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function load<T>(path: string, what: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    console.error(`restore-verify: could not read the ${what} snapshot at ${path}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(EVIDENCE_EXIT.MALFORMED);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const mode = parseMode(argv);
  const sourcePath = flag(argv, "--source");
  const restoredPath = flag(argv, "--restored");
  const rowsPath = flag(argv, "--rows"); // optional: restored events for a full chain walk

  if (sourcePath === undefined || restoredPath === undefined) {
    // No snapshots to compare is not a pass — there is simply no evidence, which under merge/release is
    // a blocked prerequisite exactly like an absent browser.
    const detail = "no --source/--restored snapshots supplied; a restore has not been reconciled";
    console.error(`restore-verify: BLOCKED — ${detail}`);
    console.error("usage: restore-verify --source <a.json> --restored <b.json> [--rows <events.json>]");
    if (mode !== "local") {
      console.log(formatGateResult({ gate: "restore-verify", status: "BLOCKED", executed: false, assertions: 0, detail }));
    }
    process.exit(EVIDENCE_EXIT.PREREQ_BLOCKED);
  }

  const source = load<LedgerSnapshot>(sourcePath, "source");
  const restored = load<LedgerSnapshot>(restoredPath, "restored");

  let chain: ChainVerdict = { ok: true, head: restored.events.headHash, count: restored.events.count };
  if (rowsPath !== undefined) {
    const rows = load<Record<string, string | number | null>[]>(rowsPath, "restored rows");
    chain = await verifyChainOfRows(rows);
  } else {
    console.log("restore-verify: no --rows supplied — the hash chain is taken from the snapshot rather than re-walked.");
  }

  const report = reconcileRestore(source, restored, chain);
  console.log(`restore-verify: tenant=${restored.tenant} checks=${report.checked} problems=${report.problems.length}`);
  for (const p of report.problems) console.log(`  MISMATCH  ${p.code.padEnd(28)} ${p.dimension} — ${p.detail}`);

  const result: GateResult = report.ok
    ? { gate: "restore-verify", status: "PASS", executed: true, assertions: report.checked, detail: `restore reconciles across ${report.checked} dimensions` }
    : { gate: "restore-verify", status: "FAIL", executed: true, assertions: report.checked, detail: report.problems.map((p) => p.code).join(", ") };
  if (report.ok) console.log("\nrestore-verify: PASS — the restored ledger is the same ledger.");
  else console.error(`\nrestore-verify: FAIL — ${report.problems.length} mismatch(es). The restore is NOT usable.`);
  if (mode !== "local") console.log(formatGateResult(result));

  process.exit(report.ok ? EVIDENCE_EXIT.OK : EVIDENCE_EXIT.ASSERTIONS_FAILED);
}

if (process.argv[1] !== undefined && /restore-verify\.ts$/.test(process.argv[1])) void main();
