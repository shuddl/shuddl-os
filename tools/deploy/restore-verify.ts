import { readFileSync } from "node:fs";
import { canonicalize, sha256Hex } from "@shuddl/ledger/canonical";
import { GENESIS_HASH, verifyChain, type ChainResult } from "@shuddl/ledger/chain";
import { rowToEvent } from "@shuddl/ledger/lens";
import type { LedgerEvent } from "@shuddl/contracts";
import { EVIDENCE_EXIT, formatGateResult, parseMode, unavailableStatus, type GateMode, type GateResult } from "../release/evidence.js";

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
//
// Metadata alone cannot prove a restore. Two of the eleven dimensions require a WALK of the restored rows
// (`--rows`); without it they are skipped, not assumed, and the gate reports what it actually checked and
// refuses to PASS. See RESTORE_CHECKS / CHAIN_CHECKS and restoreDisposition below.

export type RestoreProblem = { code: string; dimension: string; detail: string };
// `checked` is what actually RAN, never what the gate wishes it had run; `chainWalked` says whether the
// rows were re-derived, because that is the difference between a reconciliation and a proof.
export type RestoreReport = { ok: boolean; problems: RestoreProblem[]; checked: number; chainWalked: boolean };

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
//
// `reason` stays the BARE ledger reason token ("seq_gap", "hash_mismatch", …) — consumers match on it
// exactly. The stream rides in its own optional field instead: this ledger is chained per stream, so a
// bare `seq 0` is ambiguous across streams, and an operator reading a failed restore mid-incident needs
// to know WHICH stream broke before they can look at anything. Optional because a single-stream caller
// (and every verdict this gate constructed before) has nothing to name.
//
// `detail` is free prose for the one reason that cannot be read off the token alone — ROW_UNREADABLE,
// where the useful fact is WHICH field failed validation. It is a separate field precisely so `reason`
// stays exact-matchable.
export type ChainVerdict =
  | { ok: true; head: string; count: number }
  | { ok: false; failure: { seq: number; reason: string; stream?: string; detail?: string } };

// A row that does not parse as a LedgerEvent at all. Not one of the ledger's own ChainFailure reasons —
// `verifyChain` never sees such a row — but it IS a chain break: an event whose bytes no longer describe
// an event cannot be linked, hashed, or replayed, and a restore carrying one is not the same ledger.
export const ROW_UNREADABLE = "row_unreadable";

/** Seq/stream taken from the RAW row, because the row failed validation and there is no parsed event to
 *  ask. A row that cannot even name itself reports seq -1 and no stream rather than inventing either. */
function rowIdentity(row: Record<string, string | number | null>): { seq: number; stream?: string } {
  const seq = typeof row["seq"] === "number" && Number.isFinite(row["seq"]) ? row["seq"] : -1;
  const streamId = row["stream_id"];
  return typeof streamId === "string" && streamId.length > 0 ? { seq, stream: streamId } : { seq };
}

/** A compact, value-free summary of why the row would not parse: zod issue paths + messages, or the raw
 *  error text for a non-zod throw (malformed JSON in a payload/evidence column reaches JSON.parse first).
 *  Deliberately carries no row CONTENT — this string is printed by a gate and lands in an evidence
 *  artifact, and a tampered payload is exactly the thing not to echo. */
function unreadableDetail(err: unknown): string {
  const issues = (err as { issues?: { path?: unknown[]; message?: string }[] } | undefined)?.issues;
  const summary = Array.isArray(issues)
    ? issues.map((i) => `${(i.path ?? []).join(".") || "(root)"}: ${i.message ?? "invalid"}`).join("; ")
    : err instanceof Error
      ? `${err.name}: ${err.message}`
      : String(err);
  return summary.length > 300 ? `${summary.slice(0, 297)}…` : summary;
}

// The number of independent dimensions reconcileRestore inspects WHEN THE CHAIN WAS RE-WALKED. Exported
// so a clean report can assert it actually looked at all of them — a "0 problems" result from a checker
// that examined two fields is the same lie as a skipped test.
export const RESTORE_CHECKS = 11;

// Two of those eleven exist only because someone handed this function a walk of the restored ROWS: chain
// validity, and the walked chain's agreement with the snapshot's head + count. Without `--rows` neither
// can run, so neither may be counted.
//
// It used to be counted anyway. `main()` synthesized a verdict from the restored snapshot itself
// (`{ ok: true, head: restored.events.headHash, count: restored.events.count }`), which made
// `chain-broken`, `chain-count-mismatch` and `chain-head-mismatch` structurally unreachable — the
// checker was comparing the snapshot against itself — and then reported `assertions: RESTORE_CHECKS`
// and printed "the restored ledger is the same ledger". The corruption that walks straight through
// that: one row's `prev_hash` flipped mid-stream. The row count does not move, and neither does
// `SELECT hash … ORDER BY stream_id DESC, seq DESC LIMIT 1`, so all ten metadata dimensions match —
// and the eleventh, the only one that would have caught it, never ran.
export const CHAIN_CHECKS = 2;
export const RESTORE_CHECKS_NO_CHAIN = RESTORE_CHECKS - CHAIN_CHECKS;

/** `chain === null` means the rows were never walked: the chain dimensions are skipped, not assumed. */
export function reconcileRestore(source: LedgerSnapshot, restored: LedgerSnapshot, chain: ChainVerdict | null): RestoreReport {
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

  // ── chain (only when the rows were actually walked) ──
  if (chain !== null) {
    if (!chain.ok) {
      const where = chain.failure.stream === undefined ? "" : ` of stream ${chain.failure.stream}`;
      const why = chain.failure.detail === undefined ? "" : ` (${chain.failure.detail})`;
      fail("chain-broken", "chain", `restored chain fails at seq ${chain.failure.seq}${where}: ${chain.failure.reason}${why}`);
    } else {
      if (chain.count !== restored.events.count) {
        fail("chain-count-mismatch", "chain", `chain walked ${chain.count} events but the snapshot claims ${restored.events.count}`);
      }
      if (chain.head !== restored.events.headHash) {
        fail("chain-head-mismatch", "chain", `chain head ${chain.head.slice(0, 12)}… ≠ snapshot head ${restored.events.headHash.slice(0, 12)}…`);
      }
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

  const chainWalked = chain !== null;
  return { ok: problems.length === 0, problems, checked: chainWalked ? RESTORE_CHECKS : RESTORE_CHECKS_NO_CHAIN, chainWalked };
}

/**
 * The gate's disposition, and the exit code that must accompany it. Pure, so the SENTINEL is unit-tested
 * rather than eyeballed: `run-gate` reads the `##SHUDDL-GATE##` line and nothing else, so any weakening
 * of the claim has to live there, not in the prose above it.
 *
 * THE THREE OUTCOMES, and why they rank this way:
 *
 *   FAIL     — a mismatch was FOUND. It outranks everything, walked or not: `evaluateEvidence` already
 *              ranks an executed failure above a blocked prerequisite ("a broken build is worse than an
 *              absent one"), and a nine-dimension run that caught a money drift caught it for real.
 *
 *   BLOCKED  — every dimension that ran came back clean, but the chain was never re-walked. NOT a PASS.
 *   /PENDING   This gate's whole promise is "the restored ledger IS the ledger"; without the walk it has
 *              not tested that, and the corruption class it misses (a mid-stream `prev_hash` flip) is
 *              invisible to all nine of the dimensions that did run. Honest counting alone would not fix
 *              it: `assertions: 9` inside a PASS is still a PASS to `evaluateEvidence`, which is the only
 *              consumer that decides anything. A missing `--rows` is a missing EVIDENCE INPUT — the same
 *              species as the missing `--source`/`--restored` case below it, one dimension narrower — so
 *              it takes the repo's shared disposition for that species: `unavailableStatus(mode)`,
 *              PENDING locally (exit 0, a dev metadata reconcile stays usable) and BLOCKED under
 *              merge/release (exit 2, never green). This does not newly redden CI: `run-gate` passes this
 *              gate no snapshots at all, so its release verdict is already BLOCKED.
 *
 *   PASS     — clean AND walked, which is the run the DR runbook now prescribes (`docs/ops/dr-backups.md`).
 *
 * `executed: true` and a real `assertions` count ride on the BLOCKED too: work WAS done, and saying how
 * much of it is the difference between "we could not check" and "we checked nine of eleven".
 */
export function restoreDisposition(report: RestoreReport, mode: GateMode): { result: GateResult; exitCode: number } {
  const gate = "restore-verify";
  if (!report.ok) {
    const codes = report.problems.map((p) => p.code).join(", ");
    const detail = report.chainWalked ? codes : `${codes} (and the chain was NOT re-walked — no --rows)`;
    return { result: { gate, status: "FAIL", executed: true, assertions: report.checked, detail }, exitCode: EVIDENCE_EXIT.ASSERTIONS_FAILED };
  }
  if (!report.chainWalked) {
    const { status, exitCode } = unavailableStatus(mode);
    const detail =
      `chain NOT re-walked (no --rows): ${report.checked} of ${RESTORE_CHECKS} dimensions checked, ` +
      "chain validity and chain/snapshot head+count agreement were not exercised";
    return { result: { gate, status, executed: true, assertions: report.checked, detail }, exitCode };
  }
  return {
    result: { gate, status: "PASS", executed: true, assertions: report.checked, detail: `restore reconciles across ${report.checked} dimensions, chain re-walked from the restored rows` },
    exitCode: EVIDENCE_EXIT.OK,
  };
}

// One digest, computed the same way on both sides. Canonical JSON is the repo's frozen byte law
// (packages/ledger/src/canonical.ts), so key order can never make two identical snapshots disagree.
export async function snapshotDigest(value: unknown): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalize(value)));
}

/**
 * Walk the restored rows through the ledger's own chain verifier — ONE WALK PER STREAM.
 *
 * SHUDDL chains PER STREAM: `events` is `PRIMARY KEY (stream_id, seq)`, so every stream restarts at
 * seq 0 with `prev_hash = GENESIS_HASH`. `verifyChain` walks a SINGLE monotonic chain by contract
 * (expectedSeq from `fromSeq ?? 0`, expectedPrev from genesis) — exactly right for one stream, and it
 * returns `seq_gap` the moment it meets the second stream's first event. Handing it every row of a
 * tenant database therefore made the one dimension that RE-DERIVES the chain from the restored rows
 * unpassable on any real tenant, and it cried data loss where there was none (observed in the
 * 2026-07-31 staging drill: 40 events, 5 streams, data intact, `seq_gap at seq 0`). A DR gate that
 * false-alarms is worse than one that is absent — it trains the operator to ignore it during the exact
 * incident it exists for.
 *
 * The ledger stays the single authority on validity: `chain.ts` is unchanged and knows nothing about
 * streams. This function only groups, orders and aggregates; `verifyChain` still decides.
 *
 * ORDERING — grouped by `stream_id`, ordered by `seq` within a stream. Nothing here trusts the order the
 * caller supplied: a `.sql` export's row order is not a contract.
 *
 * HEAD — `ChainVerdict` carries ONE head, and `reconcileRestore` compares it against the snapshot's
 * `events.headHash`, which `tools/deploy/snapshot-ledger.ts` defines as
 * `SELECT hash FROM events ORDER BY stream_id DESC, seq DESC LIMIT 1`: the last event under the total
 * order `(stream_id, seq)` — the same total order the daily anchor uses for leaf ordering. So the
 * aggregate head is the head of the LEXICOGRAPHICALLY-LAST stream, and matching that definition exactly
 * is what keeps this fix from trading a false `chain-broken` for a false `chain-head-mismatch`. Streams
 * are sorted with JS's default (UTF-16 code-unit) comparison, which is byte-identical to D1's BINARY
 * collation here because a stream_id is ASCII by contract (`^(s:[\w-]+|q:[\w-]+|t:root)$`,
 * packages/contracts/src/events.ts) — the same convention `surveyStreamChains` sorts by.
 *
 * COUNT — every event in every stream.
 *
 * EMPTY — zero rows is a valid chain of length zero whose head IS genesis, which is precisely what
 * `captureSnapshot` records for a 0-event database, so the two sides agree on a real value instead of
 * comparing two absences. Deliberately NOT a failure: the prod ledgers are empty today, and a gate
 * permanently red on a true fact is the same trained-to-ignore failure this function was fixed for.
 * What zero rows does not prove is that anything was RESTORED — `main()` says so out loud, and a walk of
 * zero against a snapshot claiming events still fails as `chain-count-mismatch` / `chain-head-mismatch`.
 */
export async function verifyChainOfRows(rows: Record<string, string | number | null>[]): Promise<ChainVerdict> {
  const byStream = new Map<string, LedgerEvent[]>();
  for (const row of rows) {
    // rowToEvent validates through the LedgerEvent schema, so a row with no usable stream_id is rejected
    // here rather than being silently bucketed under some default and walked as if it belonged.
    //
    // UNREADABLE ⇒ A VERDICT, NOT A CRASH. It used to be a bare `rowToEvent(row)`, and a tampered payload
    // therefore escaped as a raw ZodError (or a SyntaxError from JSON.parse, for bytes that are not JSON
    // at all): the process died on a stack trace with no ##SHUDDL-GATE## sentinel, so under --mode
    // release run-gate recorded this gate from a bare exit code with no structured result. Never a false
    // pass — but a stack trace is not a verdict, and the structured record is how an operator reads a
    // release. The walk stops at the first such row: the row cannot be attributed to a stream with any
    // confidence, so continuing would be walking a chain we cannot claim is the chain.
    let e: LedgerEvent;
    try {
      e = rowToEvent(row);
    } catch (err) {
      const { seq, ...where } = rowIdentity(row);
      return { ok: false, failure: { seq, reason: ROW_UNREADABLE, ...where, detail: unreadableDetail(err) } };
    }
    const found = byStream.get(e.stream_id);
    if (found === undefined) byStream.set(e.stream_id, [e]);
    else found.push(e);
  }

  let head = GENESIS_HASH;
  let count = 0;
  for (const streamId of [...byStream.keys()].sort()) {
    const events = (byStream.get(streamId) ?? []).sort((a, b) => a.seq - b.seq);
    const result: ChainResult = await verifyChain(events);
    if (!result.ok) return { ok: false, failure: { seq: result.failure.seq, reason: result.failure.reason, stream: streamId } };
    // The last stream walked is the lexicographically last one, so its head is the head of the whole
    // database under (stream_id, seq) — the snapshot's definition.
    head = result.head;
    count += result.count;
  }
  return { ok: true, head, count };
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

  // null until something actually walks the rows. It used to be seeded from the restored snapshot itself,
  // which reconciled the snapshot against a copy of its own two fields and counted that as two dimensions.
  let chain: ChainVerdict | null = null;
  if (rowsPath !== undefined) {
    const rows = load<Record<string, string | number | null>[]>(rowsPath, "restored rows");
    chain = await verifyChainOfRows(rows);
    if (rows.length === 0) {
      // An empty chain is valid (head = genesis) and cannot fail this dimension — so say plainly that
      // it also proves nothing. "0 == 0, PASS" is reachable on today's empty prod ledgers, and an
      // operator must not read it as evidence that a restore carried anything.
      console.warn("restore-verify: --rows contained ZERO event rows. An empty chain is valid at genesis, so the chain dimension cannot fail here — it also proves nothing was restored. Read the event counts below, not this line.");
    } else if (chain.ok) {
      console.log(`restore-verify: chain re-walked per stream from ${rows.length} restored row(s) — ${chain.count} event(s) intact, head ${chain.head.slice(0, 12)}….`);
    }
  } else {
    console.warn("restore-verify: no --rows supplied — the hash chain is NOT re-walked. The chain dimensions are neither checked nor counted, and this run cannot PASS.");
  }

  const report = reconcileRestore(source, restored, chain);
  console.log(`restore-verify: tenant=${restored.tenant} checks=${report.checked}/${RESTORE_CHECKS} problems=${report.problems.length}`);
  for (const p of report.problems) console.log(`  MISMATCH  ${p.code.padEnd(28)} ${p.dimension} — ${p.detail}`);

  const { result, exitCode } = restoreDisposition(report, mode);
  if (result.status === "FAIL") console.error(`\nrestore-verify: FAIL — ${report.problems.length} mismatch(es). The restore is NOT usable.`);
  else if (result.status === "PASS") console.log("\nrestore-verify: PASS — the restored ledger is the same ledger.");
  else {
    console.error(
      `\nrestore-verify: ${result.status} — ${report.checked} of ${RESTORE_CHECKS} dimensions reconciled clean, but the chain was never re-walked, so this is NOT proof the restored ledger is the same ledger. ` +
        "A mid-stream prev_hash flip leaves the event count and the head hash identical — the dimensions that ran cannot see it. " +
        "Re-run with --rows <events.json> (snapshot-ledger.ts --rows-out writes that file).",
    );
  }
  if (mode !== "local") console.log(formatGateResult(result));

  process.exit(exitCode);
}

/**
 * The verdict for the case nobody planned: the gate itself threw.
 *
 * The unreadable-row throw above was ONE instance of a class — a gate that dies on a stack trace has not
 * reported anything, and run-gate then records it from a bare exit code with no structured result. It is
 * never a false pass, but the structured record is how an operator reads a release, and "the process
 * exited 1" does not say which gate failed or why. Anything unforeseen becomes a FAIL like any other.
 *
 * `assertions: 0` is deliberate and correct here: a crash asserted nothing. `gateResultProblem` only
 * requires assertions > 0 for a PASS — precisely so a failure cannot be dressed up as one.
 *
 * The detail is CLIPPED to one line and 300 chars. A raw ZodError message is a multi-line JSON dump that
 * can carry row content, and this string is written verbatim into the evidence artifact.
 */
export function gateCrashResult(err: unknown): GateResult {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const oneLine = raw.replace(/\s+/g, " ").trim();
  const detail = oneLine.length > 300 ? `${oneLine.slice(0, 297)}…` : oneLine;
  return { gate: "restore-verify", status: "FAIL", executed: true, assertions: 0, detail: `the gate itself threw — ${detail}` };
}

if (process.argv[1] !== undefined && /restore-verify\.ts$/.test(process.argv[1])) {
  // main() exits on every normal path, so this only ever fires on the unforeseen.
  void main().catch((err: unknown) => {
    const result = gateCrashResult(err);
    console.error(`restore-verify: FAIL — ${result.detail}`);
    if (parseMode(process.argv.slice(2)) !== "local") console.log(formatGateResult(result));
    process.exit(EVIDENCE_EXIT.ASSERTIONS_FAILED);
  });
}
