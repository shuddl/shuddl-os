import { describe, expect, it } from "vitest";
import {
  reconcileRestore,
  snapshotDigest,
  RESTORE_CHECKS,
  type LedgerSnapshot,
  type ChainVerdict,
} from "./restore-verify.js";

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
