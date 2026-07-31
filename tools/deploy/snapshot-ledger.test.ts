import { describe, expect, it } from "vitest";
import type { LedgerEvent } from "@shuddl/contracts";
import { GENESIS_HASH, buildChain } from "@shuddl/ledger/chain";
import { eventToRow } from "@shuddl/ledger/lens";
import { ROW_UNREADABLE, reconcileRestore, type LedgerSnapshot } from "./restore-verify.js";
import {
  SNAPSHOT_SQL,
  captureSnapshot,
  surveyStreamChains,
  type SnapshotIo,
  type SnapshotRow,
} from "./snapshot-ledger.js";

// THE SNAPSHOT CAPTURE (REQ-117 / REQ-135) — the missing half of the restore gate.
//
// tools/deploy/restore-verify.ts reconciles two `LedgerSnapshot`s and has never run, because NOTHING in
// this repository produced one. These tests are the contract for the tool that does: it must fill EVERY
// field reconcileRestore reads, because a field left `undefined` on both sides compares equal and turns a
// dimension of the gate into a decoration. So the coupling is asserted directly — a snapshot pair that
// differs in a real dimension must FAIL through the real reconciler, not through a mock of it.
//
// Everything here is offline: the D1 querying is a seam (`SnapshotIo`) and the fixtures below are the
// exact rows the declared SQL returns.

// ── the synthetic database ────────────────────────────────────────────────────────────────────────────

type Fixture = {
  events?: { n: number; head: string | null };
  invoices?: { n: number; cents: number };
  moneyLines?: { n: number; cents: number };
  anchors?: { id: string; hash: string }[];
  eventDays?: { day: string; n: number }[];
  positionDays?: { day: string; n: number }[];
};

/** An io that answers ONLY the declared SQL — so a tool that invents a query fails loudly here rather
 * than silently returning nothing (which reads as a zero, which reads as a clean restore). */
function io(f: Fixture = {}): SnapshotIo {
  const answers = new Map<string, SnapshotRow[]>([
    [SNAPSHOT_SQL.events, [{ n: f.events?.n ?? 0, head: f.events?.head ?? null }]],
    [SNAPSHOT_SQL.invoices, [{ n: f.invoices?.n ?? 0, cents: f.invoices?.cents ?? 0 }]],
    [SNAPSHOT_SQL.moneyLines, [{ n: f.moneyLines?.n ?? 0, cents: f.moneyLines?.cents ?? 0 }]],
    [SNAPSHOT_SQL.anchors, (f.anchors ?? []).map((a) => ({ id: a.id, hash: a.hash }))],
    [SNAPSHOT_SQL.eventDays, (f.eventDays ?? []).map((d) => ({ day: d.day, n: d.n }))],
    [SNAPSHOT_SQL.positionDays, (f.positionDays ?? []).map((d) => ({ day: d.day, n: d.n }))],
  ]);
  return {
    query: (sql) => {
      const rows = answers.get(sql);
      if (rows === undefined) throw new Error(`the tool issued an undeclared query: ${sql}`);
      return rows;
    },
  };
}

const HEAD = "a".repeat(64);
const ROOT = "b".repeat(64);
const DIGEST = "c".repeat(64);

const FULL: Fixture = {
  events: { n: 40, head: HEAD },
  invoices: { n: 5, cents: 480_000 },
  moneyLines: { n: 10, cents: 480_000 },
  anchors: [{ id: "anchor:2026-07-30", hash: ROOT }],
  eventDays: [{ day: "2026-07-30", n: 38 }, { day: "2026-07-31", n: 2 }],
  positionDays: [{ day: "2026-07-30", n: 7 }],
};

const OPTS = { tenant: "tenant-a", capturedAt: "2026-07-31T13:00:00.000Z", manifestDigest: DIGEST };

// ── the shape ─────────────────────────────────────────────────────────────────────────────────────────

describe("the captured snapshot", () => {
  it("fills every field reconcileRestore reads, and nothing else", () => {
    const snap = captureSnapshot(io(FULL), OPTS);
    expect(Object.keys(snap).sort()).toEqual(
      ["anchors", "capturedAt", "events", "invoices", "manifestDigest", "moneyLines", "tenant"],
    );
    expect(snap.tenant).toBe("tenant-a");
    expect(snap.capturedAt).toBe(OPTS.capturedAt);
    expect(snap.events).toEqual({ count: 40, headHash: HEAD });
    expect(snap.invoices).toEqual({ count: 5, totalCents: 480_000 });
    expect(snap.moneyLines).toEqual({ count: 10, sumCents: 480_000 });
    expect(snap.manifestDigest).toBe(DIGEST);
  });

  it("reports an empty ledger as a real zero at genesis, never as an absent field", () => {
    const snap = captureSnapshot(io(), OPTS);
    expect(snap.events).toEqual({ count: 0, headHash: GENESIS_HASH });
    expect(snap.invoices).toEqual({ count: 0, totalCents: 0 });
    expect(snap.moneyLines).toEqual({ count: 0, sumCents: 0 });
    expect(snap.anchors).toEqual([]);
  });

  it("recomputes each anchor day's leaf count as events + positions in that UTC day bucket", () => {
    // The anchored root commits to events FIRST then positions, bucketed on recorded_at (anchor.ts).
    // 38 events + 7 positions on the anchored day; the 2 events of the NEXT day belong to no anchor yet.
    const snap = captureSnapshot(io(FULL), OPTS);
    expect(snap.anchors).toEqual([{ day: "2026-07-30", root: ROOT, leafCount: 45 }]);
  });

  it("refuses a money total that is not integer cents — money never becomes a float", () => {
    expect(() => captureSnapshot(io({ invoices: { n: 1, cents: 1234.5 } }), OPTS)).toThrow(/integer cents/i);
    expect(() => captureSnapshot(io({ moneyLines: { n: 1, cents: 1234.5 } }), OPTS)).toThrow(/integer cents/i);
  });

  it("refuses an anchor document id it cannot parse rather than guessing a day", () => {
    expect(() => captureSnapshot(io({ anchors: [{ id: "anchor:last-tuesday", hash: ROOT }] }), OPTS)).toThrow(
      /anchor:last-tuesday/,
    );
  });
});

// ── the coupling to the real reconciler ───────────────────────────────────────────────────────────────

describe("a captured pair, run through the real reconcileRestore", () => {
  const chainOf = (s: LedgerSnapshot) => ({ ok: true as const, head: s.events.headHash, count: s.events.count });

  it("reconciles clean when the restored database is the same database", () => {
    const source = captureSnapshot(io(FULL), OPTS);
    const restored = captureSnapshot(io(FULL), { ...OPTS, capturedAt: "2026-07-31T13:44:00.000Z" });
    const report = reconcileRestore(source, restored, chainOf(restored));
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("FAILS on every dimension that can really drift — the point of capturing them at all", () => {
    const source = captureSnapshot(io(FULL), OPTS);
    const cases: { over: Fixture; opts?: Partial<typeof OPTS>; code: string }[] = [
      { over: { events: { n: 39, head: HEAD } }, code: "event-count-mismatch" },
      { over: { events: { n: 40, head: "d".repeat(64) } }, code: "head-hash-mismatch" },
      { over: { invoices: { n: 4, cents: 480_000 } }, code: "invoice-count-mismatch" },
      { over: { invoices: { n: 5, cents: 479_999 } }, code: "invoice-total-mismatch" },
      { over: { moneyLines: { n: 9, cents: 480_000 } }, code: "money-line-count-mismatch" },
      { over: { moneyLines: { n: 10, cents: 479_999 } }, code: "money-sum-mismatch" },
      { over: { anchors: [] }, code: "anchor-missing" },
      { over: { anchors: [{ id: "anchor:2026-07-30", hash: "e".repeat(64) }] }, code: "anchor-root-mismatch" },
      { over: { eventDays: [{ day: "2026-07-30", n: 37 }, { day: "2026-07-31", n: 2 }] }, code: "anchor-leaf-count-mismatch" },
      { over: { positionDays: [] }, code: "anchor-leaf-count-mismatch" },
      { over: {}, opts: { tenant: "tenant-b" }, code: "tenant-mismatch" },
      { over: {}, opts: { manifestDigest: "9".repeat(64) }, code: "manifest-digest-mismatch" },
    ];
    for (const c of cases) {
      const restored = captureSnapshot(io({ ...FULL, ...c.over }), { ...OPTS, ...c.opts });
      const codes = reconcileRestore(source, restored, chainOf(restored)).problems.map((p) => p.code);
      expect(codes, c.code).toContain(c.code);
    }
  });

  it("does not fail on capturedAt — the only field that legitimately differs", () => {
    const source = captureSnapshot(io(FULL), { ...OPTS, capturedAt: "2020-01-01T00:00:00.000Z" });
    const restored = captureSnapshot(io(FULL), { ...OPTS, capturedAt: "2026-07-31T13:44:00.000Z" });
    expect(reconcileRestore(source, restored, chainOf(restored)).ok).toBe(true);
  });
});

// ── the chain survey (the ledger is chained PER STREAM) ───────────────────────────────────────────────

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

async function streamRows(streamId: string, n: number): Promise<SnapshotRow[]> {
  const chained = await buildChain(Array.from({ length: n }, (_, i) => event(streamId, i)));
  return chained.map((e) => eventToRow(e));
}

describe("surveyStreamChains", () => {
  it("walks EVERY stream through the ledger's own verifyChain, not just the first", async () => {
    const rows = [...(await streamRows("s:SHP-a", 4)), ...(await streamRows("s:SHP-b", 3))];
    const survey = await surveyStreamChains(rows);
    expect(survey.ok).toBe(true);
    if (!survey.ok) return;
    expect(survey.count).toBe(7);
    expect(survey.streams.map((s) => [s.streamId, s.count])).toEqual([
      ["s:SHP-a", 4],
      ["s:SHP-b", 3],
    ]);
    for (const s of survey.streams) expect(s.head).toMatch(/^[0-9a-f]{64}$/);
  });

  it("catches a tampered row and names the stream and the seq it broke at", async () => {
    const rows = [...(await streamRows("s:SHP-a", 4)), ...(await streamRows("s:SHP-b", 3))];
    const victim = rows[5];
    if (victim === undefined) throw new Error("fixture");
    victim.payload = JSON.stringify({ tampered: true });
    const survey = await surveyStreamChains(rows);
    expect(survey.ok).toBe(false);
    if (survey.ok) return;
    expect(survey.streamId).toBe("s:SHP-b");
    expect(survey.failure.seq).toBe(1);
  });

  it("catches a DROPPED row — the silent truncation a restore actually produces", async () => {
    const rows = await streamRows("s:SHP-a", 4);
    const survey = await surveyStreamChains(rows.filter((r) => r.seq !== 2));
    expect(survey.ok).toBe(false);
    if (survey.ok) return;
    expect(survey.failure.reason).toBe("seq_gap");
  });

  // Same defect class as restore-verify's: a row that is not a readable event used to escape as a raw
  // throw, killing the capture mid-survey. Here the disposition is not a gate sentinel — snapshot-ledger
  // is an operator/nightly command, not one of run-gate's gates — it is "say which row, write NOTHING".
  // A survey that crashes leaves the operator with a stack trace and no idea which row to look at, during
  // the one procedure where they need to know exactly that.
  it("returns a verdict for a schema-invalid row instead of throwing", async () => {
    const rows = [...(await streamRows("s:SHP-a", 4)), ...(await streamRows("s:SHP-b", 3))];
    const victim = rows[5]; // s:SHP-b, seq 1
    if (victim === undefined) throw new Error("fixture");
    victim.payload = JSON.stringify("not-an-object");
    const survey = await surveyStreamChains(rows);
    expect(survey.ok).toBe(false);
    if (survey.ok) return;
    expect(survey.failure.reason).toBe(ROW_UNREADABLE);
    expect(survey.streamId).toBe("s:SHP-b");
    expect(survey.failure.seq).toBe(1);
    expect(survey.failure.detail).toContain("payload");
  });

  it("returns a verdict for a row that carries no stream_id at all — it cannot be attributed", async () => {
    const rows = await streamRows("s:SHP-a", 3);
    const victim = rows[1];
    if (victim === undefined) throw new Error("fixture");
    victim.stream_id = null;
    const survey = await surveyStreamChains(rows);
    expect(survey.ok).toBe(false);
    if (survey.ok) return;
    expect(survey.failure.reason).toBe(ROW_UNREADABLE);
    expect(survey.streamId).toBeNull(); // null, never a guessed or defaulted stream
    expect(survey.failure.detail).toContain("stream_id");
  });
});
