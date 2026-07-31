import { describe, expect, it } from "vitest";
import type { LedgerEvent } from "@shuddl/contracts";
import { GENESIS_HASH, buildChain } from "@shuddl/ledger/chain";
import { eventToRow } from "@shuddl/ledger/lens";
import {
  gateCrashResult,
  reconcileRestore,
  snapshotDigest,
  verifyChainOfRows,
  RESTORE_CHECKS,
  type LedgerSnapshot,
  type ChainVerdict,
} from "./restore-verify.js";
import { formatGateResult, gateResultProblem, parseGateResults } from "../release/evidence.js";

// V1 remediation Task 15 (REQ-117/REQ-284/REQ-288) — RESTORE RECONCILIATION.
//
// A backup that restores is not a backup that is CORRECT. The only thing that makes a restore
// trustworthy is proving the restored ledger is the same ledger: the same number of events, the same
// head hash, an intact hash chain, the same invoices and the same money, and the same anchor roots. Any
// mismatch fails — a restore that "mostly" matches is a silent data-loss event, and on an append-only
// ledger it is unrecoverable because there is nothing to diff against later.
//
// This is pure over source/restored METADATA so it is unit-testable without a database; the CLI reads
// the two snapshots and feeds them in.

const CHAIN_OK: ChainVerdict = { ok: true, head: "a".repeat(64), count: 1200 };

function snapshot(over: Partial<LedgerSnapshot> = {}): LedgerSnapshot {
  return {
    tenant: "tenant-a",
    capturedAt: "2026-07-24T06:00:00.000Z",
    events: { count: 1200, headHash: "a".repeat(64) },
    invoices: { count: 37, totalCents: 4_812_355 },
    moneyLines: { count: 402, sumCents: 4_812_355 },
    anchors: [{ day: "2026-07-23", root: "b".repeat(64), leafCount: 1200 }],
    manifestDigest: "c".repeat(64),
    ...over,
  };
}

const codes = (source: LedgerSnapshot, restored: LedgerSnapshot, chain: ChainVerdict = CHAIN_OK): string[] =>
  reconcileRestore(source, restored, chain).problems.map((p) => p.code);

describe("an identical restore", () => {
  it("reconciles clean", () => {
    const report = reconcileRestore(snapshot(), snapshot(), CHAIN_OK);
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("checks every declared dimension, so a clean result is not a thin one", () => {
    const report = reconcileRestore(snapshot(), snapshot(), CHAIN_OK);
    expect(report.checked).toBe(RESTORE_CHECKS);
    expect(RESTORE_CHECKS).toBeGreaterThanOrEqual(8);
  });
});

describe("event integrity", () => {
  it("fails a short restore — the classic silent truncation", () => {
    const restored = snapshot({ events: { count: 1199, headHash: "a".repeat(64) } });
    expect(codes(snapshot(), restored)).toContain("event-count-mismatch");
  });

  it("fails a restore that somehow has MORE events than the source", () => {
    const restored = snapshot({ events: { count: 1201, headHash: "a".repeat(64) } });
    expect(codes(snapshot(), restored)).toContain("event-count-mismatch");
  });

  it("fails a divergent head hash even when the counts agree", () => {
    const restored = snapshot({ events: { count: 1200, headHash: "d".repeat(64) } });
    const found = codes(snapshot(), restored);
    expect(found).toContain("head-hash-mismatch");
    expect(found).not.toContain("event-count-mismatch");
  });

  it("fails a broken hash chain and names the failing seq", () => {
    const broken: ChainVerdict = { ok: false, failure: { seq: 814, reason: "prev_hash_mismatch" } };
    const report = reconcileRestore(snapshot(), snapshot(), broken);
    const problem = report.problems.find((p) => p.code === "chain-broken");
    expect(problem?.detail).toContain("814");
    expect(problem?.detail).toContain("prev_hash_mismatch");
    expect(report.ok).toBe(false);
  });

  it("fails when the chain verdict counted a different number of events than the snapshot claims", () => {
    const chain: ChainVerdict = { ok: true, head: "a".repeat(64), count: 1198 };
    expect(codes(snapshot(), snapshot(), chain)).toContain("chain-count-mismatch");
  });

  it("fails when the chain head disagrees with the restored head", () => {
    const chain: ChainVerdict = { ok: true, head: "f".repeat(64), count: 1200 };
    expect(codes(snapshot(), snapshot(), chain)).toContain("chain-head-mismatch");
  });
});

describe("money integrity", () => {
  it("fails a penny of invoice drift", () => {
    const restored = snapshot({ invoices: { count: 37, totalCents: 4_812_354 } });
    expect(codes(snapshot(), restored)).toContain("invoice-total-mismatch");
  });

  it("fails a missing invoice row", () => {
    expect(codes(snapshot(), snapshot({ invoices: { count: 36, totalCents: 4_812_355 } }))).toContain("invoice-count-mismatch");
  });

  it("fails money-line drift in either count or sum", () => {
    expect(codes(snapshot(), snapshot({ moneyLines: { count: 401, sumCents: 4_812_355 } }))).toContain("money-line-count-mismatch");
    expect(codes(snapshot(), snapshot({ moneyLines: { count: 402, sumCents: 4_812_300 } }))).toContain("money-sum-mismatch");
  });
});

describe("anchors and manifest", () => {
  it("fails a missing anchor day", () => {
    expect(codes(snapshot(), snapshot({ anchors: [] }))).toContain("anchor-missing");
  });

  it("fails an anchor whose merkle root changed — the strongest tamper signal there is", () => {
    const restored = snapshot({ anchors: [{ day: "2026-07-23", root: "e".repeat(64), leafCount: 1200 }] });
    const problem = reconcileRestore(snapshot(), restored, CHAIN_OK).problems.find((p) => p.code === "anchor-root-mismatch");
    expect(problem?.detail).toContain("2026-07-23");
  });

  it("fails an anchor whose leaf count changed", () => {
    const restored = snapshot({ anchors: [{ day: "2026-07-23", root: "b".repeat(64), leafCount: 1199 }] });
    expect(codes(snapshot(), restored)).toContain("anchor-leaf-count-mismatch");
  });

  it("fails a manifest digest mismatch", () => {
    expect(codes(snapshot(), snapshot({ manifestDigest: "9".repeat(64) }))).toContain("manifest-digest-mismatch");
  });

  it("fails a tenant mismatch outright — restoring into the wrong tenant is a cross-tenant write", () => {
    expect(codes(snapshot(), snapshot({ tenant: "tenant-b" }))).toContain("tenant-mismatch");
  });
});

describe("the verdict is never optimistic", () => {
  it("ok is false whenever any problem exists", () => {
    const mutations: Partial<LedgerSnapshot>[] = [
      { events: { count: 1, headHash: "a".repeat(64) } },
      { invoices: { count: 0, totalCents: 0 } },
      { moneyLines: { count: 0, sumCents: 0 } },
      { anchors: [] },
      { manifestDigest: "0".repeat(64) },
      { tenant: "other" },
    ];
    for (const m of mutations) {
      const report = reconcileRestore(snapshot(), snapshot(m), CHAIN_OK);
      expect(report.problems.length, JSON.stringify(m)).toBeGreaterThan(0);
      expect(report.ok, JSON.stringify(m)).toBe(false);
    }
  });

  it("reports EVERY mismatch, not just the first — an operator needs the whole picture", () => {
    const restored = snapshot({
      events: { count: 2, headHash: "z".repeat(64) },
      invoices: { count: 1, totalCents: 1 },
      manifestDigest: "1".repeat(64),
    });
    expect(reconcileRestore(snapshot(), restored, CHAIN_OK).problems.length).toBeGreaterThanOrEqual(4);
  });
});

// ── the chain walk (this ledger is chained PER STREAM) ────────────────────────────────────────────────
//
// `events` is `PRIMARY KEY (stream_id, seq)`: every stream restarts at seq 0 with `prev_hash` = genesis.
// `verifyChain` walks ONE monotonic chain by contract — correct for a single stream, and it reports
// `seq_gap` at the second stream's first event when it is handed a whole tenant's rows. So the one
// dimension that RE-DERIVES the chain from the restored rows could not pass on any real database: it
// cried data loss where there was none, which is worse than no gate at all — it trains the operator to
// ignore the gate during the exact incident it exists for. Observed in the 2026-07-31 staging drill
// (tenant-a: 40 events, 5 streams, data verified intact) as `chain-broken … seq_gap at seq 0`.
//
// Events are built the one way this repo builds them: the ledger's own buildChain + eventToRow.

type Row = Record<string, string | number | null>;

function event(streamId: string, i: number): LedgerEvent {
  return {
    id: crypto.randomUUID(),
    stream_id: streamId,
    seq: i,
    ts: 1_753_900_000_000 + i,
    recorded_at: 1_753_900_000_000 + i,
    kind: "exception.raised",
    actor: { party: "party-ops" },
    party_refs: [],
    evidence: [],
    payload: {},
    prev_hash: GENESIS_HASH,
    visibility: "internal",
    source: "native",
    confidence: 10_000,
  } as unknown as LedgerEvent;
}

/** One stream's rows, hashed and linked by the ledger itself — dense seq from 0, prev_hash from genesis. */
async function streamRows(streamId: string, n: number): Promise<Row[]> {
  const chained = await buildChain(Array.from({ length: n }, (_, i) => event(streamId, i)));
  return chained.map((e) => eventToRow(e));
}

/** The snapshot's head definition, spelled out: the last row under the total order (stream_id, seq) —
 * `SELECT hash FROM events ORDER BY stream_id DESC, seq DESC LIMIT 1` (tools/deploy/snapshot-ledger.ts). */
function headOf(rows: Row[]): string | number | null | undefined {
  const total = [...rows].sort((x, y) => {
    const a = String(x.stream_id);
    const b = String(y.stream_id);
    return a < b ? -1 : a > b ? 1 : Number(x.seq) - Number(y.seq);
  });
  return total[total.length - 1]?.hash;
}

describe("verifyChainOfRows over a real (multi-stream) ledger", () => {
  it("PASSES two streams that each start at seq 0 — the per-stream restart is not a gap", async () => {
    // THE REGRESSION. Both streams are internally valid; before the fix this reported seq_gap at seq 0.
    const rows = [...(await streamRows("s:SHP-a", 4)), ...(await streamRows("s:SHP-b", 3))];
    const verdict = await verifyChainOfRows(rows);
    expect(verdict.ok, verdict.ok ? "" : `${verdict.failure.reason} at seq ${verdict.failure.seq}`).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.count).toBe(7);
  });

  it("still catches a DROPPED row in the SECOND stream — the fix is not a rubber stamp", async () => {
    // The failure mode that matters most: walking per stream must not become "walk nothing, return ok".
    const a = await streamRows("s:SHP-a", 4);
    const b = await streamRows("s:SHP-b", 3);
    const verdict = await verifyChainOfRows([...a, ...b.filter((r) => r.seq !== 1)]);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.failure.reason).toBe("seq_gap");
    expect(verdict.failure.seq).toBe(2);
    expect(verdict.failure.stream).toBe("s:SHP-b");
  });

  it("still catches a tampered payload inside a stream — hash_mismatch, and it says which stream", async () => {
    const rows = [...(await streamRows("s:SHP-a", 4)), ...(await streamRows("s:SHP-b", 3))];
    const victim = rows[5]; // s:SHP-b, seq 1
    if (victim === undefined) throw new Error("fixture");
    victim.payload = JSON.stringify({ tampered: true });
    const verdict = await verifyChainOfRows(rows);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.failure.reason).toBe("hash_mismatch");
    expect(verdict.failure.seq).toBe(1);
    expect(verdict.failure.stream).toBe("s:SHP-b");
  });

  it("catches a break in the FIRST stream too — no stream is walked on trust", async () => {
    const rows = [...(await streamRows("s:SHP-a", 4)), ...(await streamRows("s:SHP-b", 3))];
    const victim = rows[2]; // s:SHP-a, seq 2
    if (victim === undefined) throw new Error("fixture");
    victim.payload = JSON.stringify({ tampered: true });
    const verdict = await verifyChainOfRows(rows);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.failure.stream).toBe("s:SHP-a");
  });

  it("aggregates the head as the LAST event under (stream_id, seq), matching the snapshot's definition", async () => {
    // If the walk aggregated any other head, the fix would trade a false chain-broken for a false
    // chain-head-mismatch. Streams are supplied in the WRONG order here on purpose.
    const rows = [...(await streamRows("s:SHP-b", 3)), ...(await streamRows("s:SHP-a", 4))];
    const verdict = await verifyChainOfRows(rows);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.head).toBe(headOf(rows));
    expect(verdict.head).not.toBe(rows[rows.length - 1]?.hash); // not merely "the last row handed in"
  });

  it("verifies rows supplied out of order — a .sql export's row order is not a contract", async () => {
    const rows = [...(await streamRows("s:SHP-a", 4)), ...(await streamRows("s:SHP-b", 3))];
    const jumbled = [...rows].sort((x, y) => Number(y.seq) - Number(x.seq)); // seq descending, streams interleaved
    expect(await verifyChainOfRows(jumbled)).toEqual(await verifyChainOfRows(rows));
    expect((await verifyChainOfRows(jumbled)).ok).toBe(true);
  });

  it("reconciles a multi-stream restore clean through the REAL reconciler", async () => {
    const rows = [...(await streamRows("s:SHP-a", 4)), ...(await streamRows("s:SHP-b", 3))];
    const verdict = await verifyChainOfRows(rows);
    if (!verdict.ok) throw new Error(`chain walk failed: ${verdict.failure.reason} at seq ${verdict.failure.seq}`);
    const snap = snapshot({ events: { count: verdict.count, headHash: verdict.head } });
    expect(reconcileRestore(snap, snap, verdict).problems).toEqual([]);
  });

  it("names the stream in the operator-facing detail — a bare seq 0 is ambiguous across streams", async () => {
    const b = (await streamRows("s:SHP-b", 3)).filter((r) => r.seq !== 1);
    const verdict = await verifyChainOfRows([...(await streamRows("s:SHP-a", 4)), ...b]);
    const detail = reconcileRestore(snapshot(), snapshot(), verdict).problems.find((p) => p.code === "chain-broken")?.detail;
    expect(detail).toContain("s:SHP-b");
    expect(detail).toContain("seq_gap");
  });

  it("treats zero rows as a valid empty chain AT GENESIS — the same head an empty database snapshots", async () => {
    // captureSnapshot records GENESIS_HASH for a 0-event database, so the two sides agree instead of
    // comparing two absences. Deliberately not a failure: the prod ledgers are empty today, and a gate
    // permanently red on a true fact is the same trained-to-ignore failure this function was fixed for.
    expect(await verifyChainOfRows([])).toEqual({ ok: true, head: GENESIS_HASH, count: 0 });
  });

  it("an empty walk against a snapshot that CLAIMS events fails loudly — 0 never launders a truncation", async () => {
    const found = codes(snapshot(), snapshot(), await verifyChainOfRows([]));
    expect(found).toContain("chain-count-mismatch");
    expect(found).toContain("chain-head-mismatch");
  });
});

// ── a row that is not a readable event ────────────────────────────────────────────────────────────────
//
// Byte-level corruption (a flipped hash, a broken prev_hash, a dropped row) already produces a verdict:
// the row still PARSES, so the walk reaches it and `verifyChain` names the break. A row whose payload no
// longer satisfies the schema never gets that far — `rowToEvent` throws a raw ZodError inside the parse
// loop, which under `--mode release` left the process dead on a stack trace with NO ##SHUDDL-GATE##
// sentinel: run-gate then recorded the gate from a bare exit code, with no structured result. It was
// never a false pass (exit 1 is not green), but a gate that stack-traces has not reported a verdict, and
// the structured record is how an operator reads a release. The unreadable row is a chain break like any
// other and says so, naming the stream and the seq.
describe("a row that is not a readable event", () => {
  it("returns a verdict naming the stream and seq instead of throwing", async () => {
    const rows = [...(await streamRows("s:SHP-a", 4)), ...(await streamRows("s:SHP-b", 3))];
    const victim = rows[5]; // s:SHP-b, seq 1
    if (victim === undefined) throw new Error("fixture");
    victim.payload = JSON.stringify("not-an-object"); // schema-invalid, not merely hash-divergent
    const verdict = await verifyChainOfRows(rows);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.failure.reason).toBe("row_unreadable");
    expect(verdict.failure.seq).toBe(1);
    expect(verdict.failure.stream).toBe("s:SHP-b");
    expect(verdict.failure.detail).toBeTruthy();
  });

  it("survives payload bytes that are not JSON at all — the parse throws a SyntaxError, not a ZodError", async () => {
    const rows = await streamRows("s:SHP-a", 3);
    const victim = rows[2];
    if (victim === undefined) throw new Error("fixture");
    victim.payload = "{not json";
    const verdict = await verifyChainOfRows(rows);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.failure.reason).toBe("row_unreadable");
    expect(verdict.failure.seq).toBe(2);
    expect(verdict.failure.stream).toBe("s:SHP-a");
  });

  it("still answers when the row's OWN identity is the unreadable part", async () => {
    // No usable stream_id and no usable seq: the verdict must still be a verdict, and must not claim a
    // stream or a seq it cannot see.
    const rows = await streamRows("s:SHP-a", 2);
    const victim = rows[1];
    if (victim === undefined) throw new Error("fixture");
    victim.stream_id = null;
    victim.seq = null;
    const verdict = await verifyChainOfRows(rows);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.failure.reason).toBe("row_unreadable");
    expect(verdict.failure.stream).toBeUndefined();
    expect(verdict.failure.seq).toBe(-1);
  });

  it("reaches the operator as a chain-broken problem that names the stream and the reason", async () => {
    const rows = [...(await streamRows("s:SHP-a", 4)), ...(await streamRows("s:SHP-b", 3))];
    const victim = rows[5];
    if (victim === undefined) throw new Error("fixture");
    victim.payload = JSON.stringify("not-an-object");
    const verdict = await verifyChainOfRows(rows);
    const problem = reconcileRestore(snapshot(), snapshot(), verdict).problems.find((p) => p.code === "chain-broken");
    expect(problem).toBeDefined();
    expect(problem?.detail).toContain("s:SHP-b");
    expect(problem?.detail).toContain("row_unreadable");
  });

  it("does not regress the byte-level corruptions, which must still name their own reasons", async () => {
    // The unreadable-row branch must not swallow a plain hash divergence: a row that PARSES is walked.
    const tampered = [...(await streamRows("s:SHP-a", 4)), ...(await streamRows("s:SHP-b", 3))];
    const victim = tampered[5];
    if (victim === undefined) throw new Error("fixture");
    victim.payload = JSON.stringify({ tampered: true }); // still a valid JsonObject
    const hashBreak = await verifyChainOfRows(tampered);
    expect(hashBreak.ok).toBe(false);
    if (!hashBreak.ok) expect(hashBreak.failure.reason).toBe("hash_mismatch");

    const dropped = await verifyChainOfRows((await streamRows("s:SHP-a", 4)).filter((r) => r.seq !== 2));
    expect(dropped.ok).toBe(false);
    if (!dropped.ok) expect(dropped.failure.reason).toBe("seq_gap");
  });
});

describe("the gate's own crash verdict", () => {
  it("is a FAIL that run-gate can read, with the cause in the detail", () => {
    const result = gateCrashResult(new TypeError("cannot read properties of undefined"));
    expect(result.status).toBe("FAIL");
    expect(result.executed).toBe(true);
    expect(result.detail).toContain("TypeError");
    // A FAIL is well-formed with 0 assertions; a PASS would not be. That asymmetry is the point.
    expect(gateResultProblem(result)).toBeNull();
  });

  it("is a well-formed sentinel run-gate parses back to the same verdict", () => {
    const result = gateCrashResult(new Error("boom"));
    const parsed = parseGateResults(formatGateResult(result));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.status).toBe("FAIL");
  });

  it("survives a non-Error throw", () => {
    expect(gateCrashResult("a bare string").detail).toContain("a bare string");
  });

  it("clips the detail to one line and a bounded length — this string lands in the evidence artifact", () => {
    // A raw ZodError message is a multi-line JSON dump that can carry row content.
    const detail = gateCrashResult(new Error(`ZodError: [\n  {\n    "path": ["payload"],\n${"x".repeat(2000)}\n  }\n]`)).detail ?? "";
    expect(detail).not.toContain("\n");
    expect(detail.length).toBeLessThanOrEqual(340);
    expect(detail.endsWith("…")).toBe(true);
  });
});

describe("snapshotDigest", () => {
  it("is stable across key order — the two sides compute it independently", async () => {
    const a = await snapshotDigest({ tenant: "t", day: "2026-07-23", count: 2 });
    const b = await snapshotDigest({ count: 2, day: "2026-07-23", tenant: "t" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any value changes", async () => {
    const a = await snapshotDigest({ tenant: "t", count: 2 });
    const b = await snapshotDigest({ tenant: "t", count: 3 });
    expect(a).not.toBe(b);
  });
});
