import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { GENESIS_HASH } from "@shuddl/ledger/chain";
import { ROW_UNREADABLE, verifyChainOfRows } from "./restore-verify.js";
import { manifestDigest, unsignManifest, type SignedBackupManifest } from "./backup.js";
import type { AnchorSummary, LedgerSnapshot } from "./restore-verify.js";
import { EVIDENCE_EXIT } from "../release/evidence.js";

// THE SNAPSHOT CAPTURE (REQ-117) — the missing half of the restore gate.
//
// `tools/deploy/restore-verify.ts` reconciles a source `LedgerSnapshot` against a restored one across 11
// dimensions, and had never once run — because NOTHING in this repository produced a `LedgerSnapshot`.
// The gate's `main()` reads two JSON files that no tool wrote. That is not a gate that was failing; it is
// a gate that could not execute on any environment, in any account, ever. This file writes those files.
//
// THE CONTRACT IT MUST HONOUR: every field `reconcileRestore` reads must be POPULATED. A field left
// `undefined` on both sides compares equal, and a dimension that always agrees is a decoration on the
// report, not a check. So the tests couple this tool to the REAL reconciler and assert that a pair
// differing in each real dimension actually FAILS.
//
// Everything that decides is PURE over an injected `SnapshotIo` (the backup.ts / preflight.ts discipline),
// so the whole capture is provable offline with no account and no database.
//
// ── two things about this ledger that shape the capture ─────────────────────────────────────────────
//
// 1. HEAD HASH. SHUDDL chains events PER STREAM: `PRIMARY KEY (stream_id, seq)`, each stream's seq dense
//    from 0 and its own `prev_hash` walk from genesis (`packages/ledger/src/chain.ts`). There is no single
//    global chain, so "the head hash" needs a definition, and it must be the one that makes the gate's
//    `chain-head-mismatch` check meaningful. It is the `hash` of the LAST event under the total order
//    `(stream_id, seq)` — the same total order the daily anchor uses for leaf ordering (Decision 7,
//    `packages/ledger/src/anchor.ts`). For a single-stream ledger that is exactly what `verifyChain`
//    returns as its head, and for a multi-stream one it is the head of the lexicographically-last stream,
//    which `surveyStreamChains` re-derives and cross-checks before a snapshot is written.
//
// 2. ANCHORS ARE NOT A TABLE (I8). A daily anchor is a `documents` row `anchor:{day}` of kind
//    `tsa_receipt` whose `hash` IS the merkle root. The leaf COUNT is not stored on that row, so it is
//    recomputed here the way anchor.ts buckets leaves: events + positions whose `recorded_at` falls in
//    that UTC day. That makes it a fidelity measure BETWEEN two databases (which is what the restore gate
//    asks), not a re-derivation of the anchored root — a day that gained a late row after anchoring reads
//    the same, higher, count on both sides.
//
// This is an OPERATOR/CI command like backup.ts. Nothing in a local pipeline should reach an account.

// ── the seam ──────────────────────────────────────────────────────────────────────────────────────────

export type SnapshotRow = Record<string, string | number | null>;

/** Every effect a capture performs: one injectable query. Tests answer it from fixtures, so no test run
 * can reach an account. */
export type SnapshotIo = {
  query: (sql: string) => SnapshotRow[];
};

/**
 * The queries, in one frozen place, so the tests answer EXACTLY what the tool asks. A query invented at
 * the call site would return nothing under test — and nothing reads as a zero, and a zero on both sides
 * reads as a clean restore.
 *
 * Day bucketing is UTC on `recorded_at` (the server clock), never the actor-claimed `ts` — the same rule
 * `anchor.ts dayOf()` applies, and for the same reason: an airplane-mode upload carries yesterday's
 * physical timestamp and must not appear to mutate an already-anchored day.
 */
export const SNAPSHOT_SQL = {
  events:
    "SELECT (SELECT COUNT(*) FROM events) AS n, (SELECT hash FROM events ORDER BY stream_id DESC, seq DESC LIMIT 1) AS head",
  invoices: "SELECT COUNT(*) AS n, COALESCE(SUM(total_cents),0) AS cents FROM invoices",
  moneyLines: "SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS cents FROM money_lines",
  anchors: "SELECT id, hash FROM documents WHERE kind='tsa_receipt' AND id LIKE 'anchor:%' ORDER BY id",
  eventDays: "SELECT strftime('%Y-%m-%d', recorded_at/1000, 'unixepoch') AS day, COUNT(*) AS n FROM events GROUP BY day",
  positionDays:
    "SELECT strftime('%Y-%m-%d', recorded_at/1000, 'unixepoch') AS day, COUNT(*) AS n FROM positions GROUP BY day",
  /** Only the CLI asks for this (`--rows-out`): every event row, in the anchor's total order. */
  rows: "SELECT * FROM events ORDER BY stream_id, seq",
} as const;

// ── reading a row honestly ────────────────────────────────────────────────────────────────────────────

const HEX64 = /^[0-9a-f]{64}$/i;
const ANCHOR_ID = /^anchor:(\d{4}-\d{2}-\d{2})$/;

function one(io: SnapshotIo, sql: string, what: string): SnapshotRow {
  const rows = io.query(sql);
  const row = rows[0];
  if (row === undefined) throw new Error(`snapshot-ledger: the ${what} query returned no row at all; a snapshot cannot be assembled from a silence`);
  return row;
}

/** A count is a non-negative safe integer or the read is corrupt. Never coerced, never defaulted. */
function count(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`snapshot-ledger: ${what} came back as ${JSON.stringify(value)}, which is not a count`);
  }
  return value;
}

/** Money is INTEGER CENTS end to end. A float here is not a rounding problem, it is a corrupt read of a
 * column the schema declares INTEGER — and it would flow straight into a penny-exact comparison. */
function cents(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`snapshot-ledger: ${what} came back as ${JSON.stringify(value)} — money is integer cents end to end`);
  }
  return value;
}

function hash64(value: unknown, what: string): string {
  if (typeof value !== "string" || !HEX64.test(value)) {
    throw new Error(`snapshot-ledger: ${what} came back as ${JSON.stringify(value)}, which is not a sha256 hex digest`);
  }
  return value.toLowerCase();
}

// ── the capture (pure) ────────────────────────────────────────────────────────────────────────────────

export type CaptureOptions = {
  /** The tenant identity recorded in the snapshot. `reconcileRestore` fails outright when the two sides
   * disagree — restoring into another tenant is a cross-tenant write (REQ-025). */
  tenant: string;
  capturedAt: string;
  /** sha256 over the canonicalized backup manifest body. The SAME value on both sides: it identifies the
   * export the restore came from, so a restore reconciled against a different backup is a mismatch. */
  manifestDigest: string;
};

export function captureSnapshot(io: SnapshotIo, opts: CaptureOptions): LedgerSnapshot {
  const eventsRow = one(io, SNAPSHOT_SQL.events, "events");
  const eventCount = count(eventsRow.n, "the event count");
  // An empty ledger's head IS genesis — a real, comparable value. Left null it would compare equal to
  // anything else that was also left null.
  const headHash = eventCount === 0 && eventsRow.head === null ? GENESIS_HASH : hash64(eventsRow.head, "the head hash");

  const invoicesRow = one(io, SNAPSHOT_SQL.invoices, "invoices");
  const moneyRow = one(io, SNAPSHOT_SQL.moneyLines, "money_lines");

  return {
    tenant: opts.tenant,
    capturedAt: opts.capturedAt,
    events: { count: eventCount, headHash },
    invoices: { count: count(invoicesRow.n, "the invoice count"), totalCents: cents(invoicesRow.cents, "the invoice total") },
    moneyLines: { count: count(moneyRow.n, "the money-line count"), sumCents: cents(moneyRow.cents, "the money-line sum") },
    anchors: captureAnchors(io),
    manifestDigest: opts.manifestDigest,
  };
}

function captureAnchors(io: SnapshotIo): AnchorSummary[] {
  const leavesPerDay = new Map<string, number>();
  for (const sql of [SNAPSHOT_SQL.eventDays, SNAPSHOT_SQL.positionDays]) {
    for (const row of io.query(sql)) {
      const day = typeof row.day === "string" ? row.day : null;
      if (day === null) throw new Error(`snapshot-ledger: a day bucket came back as ${JSON.stringify(row.day)}`);
      leavesPerDay.set(day, (leavesPerDay.get(day) ?? 0) + count(row.n, `the ${day} row count`));
    }
  }

  return io.query(SNAPSHOT_SQL.anchors).map((row) => {
    const id = typeof row.id === "string" ? row.id : "";
    const day = ANCHOR_ID.exec(id)?.[1];
    if (day === undefined) {
      // Guessing a day here would silently drop an anchor out of the comparison — the one dimension that
      // commits to every leaf under it.
      throw new Error(`snapshot-ledger: cannot read a day out of the anchor document id ${JSON.stringify(id)}`);
    }
    return { day, root: hash64(row.hash, `the ${day} anchor root`), leafCount: leavesPerDay.get(day) ?? 0 };
  });
}

// ── the chain survey ──────────────────────────────────────────────────────────────────────────────────

export type StreamChain = { streamId: string; count: number; head: string };
// `streamId` is null for the one failure that cannot be attributed to a stream: a row whose own
// `stream_id` column is unreadable. Null rather than "" or a placeholder — a survey must not name a
// stream it cannot see, and the operator line prints "(unattributed)" so nobody goes looking for one.
export type ChainSurvey =
  | { ok: true; streams: StreamChain[]; count: number }
  | { ok: false; streams: StreamChain[]; streamId: string | null; failure: { seq: number; reason: string; detail?: string } };

/**
 * Re-walk EVERY stream's hash chain through the ledger's own verifier.
 *
 * `verifyChain` expects a dense seq from 0 and a single prev_hash walk — correct for ONE stream, and this
 * ledger chains per stream (`PRIMARY KEY (stream_id, seq)`). So both sides group by `stream_id` first and
 * walk each: this survey, and `restore-verify.ts`'s own `verifyChainOfRows`.
 *
 * (Historical, because the comment here asserted otherwise until 2026-07-31: `verifyChainOfRows` DID walk
 * every row as one chain, so `restore-verify --rows` reported `seq_gap` at the second stream's `seq 0` on
 * any real tenant — crying data loss where there was none. Fixed the same day the first drill found it.)
 *
 * The ledger stays the single authority on chain validity; neither side reimplements `verifyChain`.
 */
export async function surveyStreamChains(rows: SnapshotRow[]): Promise<ChainSurvey> {
  const byStream = new Map<string, SnapshotRow[]>();
  for (const row of rows) {
    const streamId = typeof row.stream_id === "string" ? row.stream_id : null;
    if (streamId === null) {
      // A VERDICT, NOT A CRASH — the same disposition verifyChainOfRows now takes for a row that will not
      // parse. This used to `throw`, which killed the capture mid-survey and (worse) dumped 200 bytes of
      // the offending row into the operator's terminal. The survey's contract is already "say which row,
      // write NOTHING"; a throw only removed the "say which row" half.
      const seq = typeof row.seq === "number" && Number.isFinite(row.seq) ? row.seq : -1;
      return { ok: false, streams: [], streamId: null, failure: { seq, reason: ROW_UNREADABLE, detail: "the row carries no usable stream_id, so it cannot be attributed to a chain" } };
    }
    const found = byStream.get(streamId) ?? [];
    found.push(row);
    byStream.set(streamId, found);
  }

  const streams: StreamChain[] = [];
  let total = 0;
  for (const streamId of [...byStream.keys()].sort()) {
    const streamRows = (byStream.get(streamId) ?? []).slice().sort((a, b) => Number(a.seq) - Number(b.seq));
    const verdict = await verifyChainOfRows(streamRows);
    if (!verdict.ok) return { ok: false, streams, streamId, failure: verdict.failure };
    streams.push({ streamId, count: verdict.count, head: verdict.head });
    total += verdict.count;
  }
  return { ok: true, streams, count: total };
}

// ── the Cloudflare seam ───────────────────────────────────────────────────────────────────────────────

type Runner = (args: string[]) => { status: number; stdout: string; stderr: string };

/** `wrangler d1 execute <db> --json --command <sql>`. The `--json` payload is an array of statement
 * results; anything else (an error banner, an empty body) is a failed read, never an empty result. */
export function wranglerIo(run: Runner, databaseName: string, opts: { remote: boolean; configPath?: string }): SnapshotIo {
  return {
    query: (sql) => {
      const r = run([
        "d1",
        "execute",
        databaseName,
        ...(opts.remote ? ["--remote"] : ["--local"]),
        "--json",
        "--command",
        sql,
        ...(opts.configPath === undefined ? [] : ["--config", opts.configPath]),
      ]);
      if (r.status !== 0) {
        throw new Error(`snapshot-ledger: wrangler d1 execute exited ${r.status} for ${databaseName}: ${(r.stderr.trim() || r.stdout.trim()).slice(0, 400)}`);
      }
      return parseWranglerJson(r.stdout, sql);
    },
  };
}

/** wrangler prints its JSON payload after any banner it feels like emitting, so the array is located
 * rather than assumed to start at byte 0. A body with no array at all is an error, not an empty read. */
export function parseWranglerJson(stdout: string, sql: string): SnapshotRow[] {
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error(`snapshot-ledger: wrangler returned no JSON payload for: ${sql}`);
  const payload = JSON.parse(stdout.slice(start, end + 1)) as { results?: SnapshotRow[]; success?: boolean }[];
  const first = payload[0];
  if (first === undefined || first.success === false || !Array.isArray(first.results)) {
    throw new Error(`snapshot-ledger: wrangler reported no successful result for: ${sql}`);
  }
  return first.results;
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────────

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const USAGE = `usage: pnpm exec tsx tools/deploy/snapshot-ledger.ts --db <database_name> --tenant <tenant> --out <file.json>
                 [--manifest <manifest.json>] [--rows-out <rows.json>] [--local]
                 [--wrangler "<cmd>"] [--wrangler-config <path>]

  --db <name>          REQUIRED. The D1 database_name to snapshot (source OR restored).
  --tenant <tenant>    REQUIRED. The tenant identity recorded in the snapshot. Both sides must agree —
                       restore-verify fails a mismatch outright (a cross-tenant restore, REQ-025).
  --out <file>         REQUIRED. Where the LedgerSnapshot JSON lands.
  --manifest <file>    the backup manifest.json this restore came from (tools/deploy/backup.ts). Its
                       digest is RECOMPUTED over the manifest body, never read off the file. Pass the
                       SAME manifest to both sides; omit it only to snapshot a database with no backup,
                       in which case the digest field records that absence explicitly.
  --rows-out <file>    also dump every event row (ordered stream_id, seq) for restore-verify --rows, and
                       re-walk EVERY stream's hash chain first. A survey failure writes nothing.
  --local              query the local D1 rather than --remote.

Credentials (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID) come from the environment.`;

/** The digest recorded when there is no backup manifest to point at. Not a hash — it must never be
 * mistaken for one, and two databases snapshotted without a manifest still compare equal to each other. */
export const NO_MANIFEST = "no-manifest";

export async function readManifestDigest(path: string): Promise<string> {
  const signed = JSON.parse(readFileSync(path, "utf8")) as SignedBackupManifest;
  // Recomputed over the body, never trusted as written: `digest` is the field a tamper would edit.
  const recomputed = await manifestDigest(unsignManifest(signed));
  if (recomputed !== signed.digest) {
    throw new Error(`snapshot-ledger: ${path} does not describe itself — its body digests to ${recomputed} but it carries ${String(signed.digest)}`);
  }
  return recomputed;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(EVIDENCE_EXIT.OK);
  }

  const databaseName = flag(argv, "--db");
  const tenant = flag(argv, "--tenant");
  const out = flag(argv, "--out");
  if (databaseName === undefined || tenant === undefined || out === undefined) {
    console.error("snapshot-ledger: --db, --tenant and --out are all required.\n");
    console.error(USAGE);
    process.exit(EVIDENCE_EXIT.MALFORMED);
  }

  const wranglerCmd = (flag(argv, "--wrangler") ?? "pnpm exec wrangler").split(/\s+/).filter((s) => s.length > 0);
  const bin = wranglerCmd[0];
  if (bin === undefined) {
    console.error("snapshot-ledger: --wrangler is empty");
    process.exit(EVIDENCE_EXIT.MALFORMED);
  }
  const run: Runner = (args) => {
    const r = spawnSync(bin, [...wranglerCmd.slice(1), ...args], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });
    if (r.error) return { status: 127, stdout: "", stderr: r.error.message };
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };

  const configPath = flag(argv, "--wrangler-config");
  const io = wranglerIo(run, databaseName, {
    remote: !argv.includes("--local"),
    ...(configPath === undefined ? {} : { configPath }),
  });

  const manifestPath = flag(argv, "--manifest");
  const digest = manifestPath === undefined ? NO_MANIFEST : await readManifestDigest(manifestPath);
  if (manifestPath === undefined) {
    console.log("snapshot-ledger: no --manifest supplied — the manifest dimension records an absence, not a digest.");
  }

  const snapshot = captureSnapshot(io, { tenant, capturedAt: new Date().toISOString(), manifestDigest: digest });

  const rowsOut = flag(argv, "--rows-out");
  if (rowsOut !== undefined) {
    const rows = io.query(SNAPSHOT_SQL.rows);
    const survey = await surveyStreamChains(rows);
    if (!survey.ok) {
      // A snapshot taken from a database whose chain is broken would launder that break: both sides
      // record the same broken head and reconcile clean. Nothing is written.
      const why = survey.failure.detail === undefined ? "" : `: ${survey.failure.detail}`;
      console.error(`snapshot-ledger: the hash chain of ${databaseName} is BROKEN — stream ${survey.streamId ?? "(unattributed)"} fails at seq ${survey.failure.seq} (${survey.failure.reason}${why}).`);
      console.error("snapshot-ledger: no snapshot and no rows were written. Do not reconcile against this database.");
      process.exit(EVIDENCE_EXIT.ASSERTIONS_FAILED);
    }
    console.log(`snapshot-ledger: hash chain re-walked — ${survey.streams.length} stream(s), ${survey.count} event(s), all intact.`);
    for (const s of survey.streams) console.log(`  ${s.streamId.padEnd(24)} ${String(s.count).padStart(6)} events  head ${s.head.slice(0, 12)}…`);
    // The head the survey derives must be the head the snapshot claims: the last event under
    // (stream_id, seq) is the last event of the lexicographically-last stream.
    const last = survey.streams[survey.streams.length - 1];
    if (survey.count !== snapshot.events.count || (last !== undefined && last.head !== snapshot.events.headHash)) {
      console.error(`snapshot-ledger: the walked chain (${survey.count} events, head ${last?.head ?? "none"}) disagrees with the snapshot (${snapshot.events.count} events, head ${snapshot.events.headHash}). Nothing written.`);
      process.exit(EVIDENCE_EXIT.ASSERTIONS_FAILED);
    }
    writeFileSync(rowsOut, `${JSON.stringify(rows)}\n`, "utf8");
    console.log(`snapshot-ledger: ${rows.length} event row(s) → ${rowsOut}`);
  }

  writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(
    `snapshot-ledger: ${databaseName} → ${out}  events=${snapshot.events.count} head=${snapshot.events.headHash.slice(0, 12)}… invoices=${snapshot.invoices.count}/${snapshot.invoices.totalCents}¢ money_lines=${snapshot.moneyLines.count}/${snapshot.moneyLines.sumCents}¢ anchors=${snapshot.anchors.length}`,
  );
  process.exit(EVIDENCE_EXIT.OK);
}

if (process.argv[1] !== undefined && /snapshot-ledger\.ts$/.test(process.argv[1])) void main();
