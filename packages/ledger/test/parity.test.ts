import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { LedgerEvent as LedgerEventSchema, type LedgerEvent } from "@shuddl/contracts";
import { NATIVE_VISIBLE_SOURCES, nativeVisibleSourceSql } from "../src/queries/unbilled.js";
const TRACKED_SOURCES_FOR_TEST = ["native", "legacy"] as const;
import { applyMigrations } from "../src/migrate.js";
import {
  computeAllParity,
  computeModuleParity,
  PARITY_MODULES,
  PARITY_TOLERANCE_BPS,
  type ModuleParity,
} from "../src/parity.js";
import { eventInsertStmt, mkEvent, resetEventCounter } from "./helpers.js";
import ledgerCore from "../../../db/tenant/migrations/0001_ledger_core.sql?raw";
import domain from "../../../db/tenant/migrations/0002_domain.sql?raw";

// WP-15 Task 6 (REQ-023/152/153) — the SHARED native-vs-legacy PARITY primitive. ONE definition the flip guard
// (Task 3), the Command v_parity dashboard (Task 7) and the Watchtower drift sweep (Task 8) all consume, so
// "what the gate checks / the dashboard shows / the watchtower alarms on" can never drift apart. PARITY = how
// closely SHUDDL's `source:'native'` output matches the incumbent's `source:'legacy'` mirror, per module.
//
// THE LINCHPIN (the anti-false-green heart, written FIRST): a MISSING side (no native OR no legacy events for
// the module) must resolve to status:'UNKNOWN' AND within_gate:false — you CANNOT prove parity with a side
// missing, and the flip gate must treat UNKNOWN as "not green". NEVER a fabricated 100% match from a missing
// side. Today (before the Task-4 mirror) NO legacy events exist, so parity is testable only with SEEDED
// legacy+native events — every case seeds both sides explicitly. Per-test isolatedStorage rolls each `it` back,
// so `computeModuleParity` reads a clean whole-tenant D1 per test (no scope needed).

const DB = env.TENANT_A_DB;

beforeAll(async () => {
  await applyMigrations(DB, [
    { path: "0001_ledger_core.sql", sql: ledgerCore },
    { path: "0002_domain.sql", sql: domain },
  ]);
});

// ── seeding: a real events row with an explicit `source`, on its own stream ──────────────────────────────
type Source = LedgerEvent["source"];
async function seed(
  kind: LedgerEvent["kind"],
  o: { source: Source; shipment: string; seq?: number; payload?: Record<string, unknown> },
): Promise<void> {
  const over: Partial<LedgerEvent> = {
    source: o.source,
    stream_id: `s:${o.shipment}`,
    shipment_id: o.shipment,
    seq: o.seq ?? 0,
  };
  // The seed helper is kind-generic, so `payload` is a plain object; cast to the per-kind payload union (the
  // pricedPayload/invoicePayload/splitPayload builders produce valid shapes, and eventFixture .parse()-validates).
  if (o.payload !== undefined) over.payload = o.payload as unknown as LedgerEvent["payload"];
  await eventInsertStmt(DB, mkEvent(kind, over)).run();
}

// Valid, penny-parity quote.priced (single line == sell) with a positive cost basis.
const pricedPayload = (sell: number): Record<string, unknown> => ({
  sell,
  lines: [{ kind: "freight", code: "freight", amount_cents: sell }],
  floors: { contribution: Math.max(1, sell - 2), full: Math.max(1, sell - 1), target: sell + 1 },
  versions: { rate_config_ids: ["rc-parity"] },
  basis: {},
});
// Valid invoice.issued (single line == total).
const invoicePayload = (total: number): Record<string, unknown> => ({
  invoice_id: "inv-parity",
  party_id: "party-bill-to",
  division: "main",
  lines: [{ line_no: 1, kind: "freight", amount_cents: total, gl_map: "4000-REV" }],
});
// Valid split.computed (total_cents + allocations summing to 10000 bps). total_cents may be 0 (I19 refine >= 0).
const splitPayload = (total: number): Record<string, unknown> => ({
  total_cents: total,
  allocations: [
    { party_id: "party-carrier", share_bps: 7_000 },
    { party_id: "party-interline", share_bps: 3_000 },
  ],
});

beforeAll(() => resetEventCounter());

// ─── 1. THE LINCHPIN — a missing side ⇒ UNKNOWN + within_gate:false (NEVER a fabricated match) ─────────
describe("computeModuleParity — the HONESTY LAW: a missing side fails CLOSED to UNKNOWN (REQ-023)", () => {
  it("native events but NO legacy ⇒ status UNKNOWN, within_gate:false, legacy_value/drift honest UNKNOWN", async () => {
    await seed("quote.priced", { source: "native", shipment: "rat-nat-only", payload: pricedPayload(100_000) });
    const p = await computeModuleParity(DB, "rating");
    expect(p.status).toBe("UNKNOWN");
    expect(p.within_gate).toBe(false); // fail-closed: you cannot prove parity with legacy absent
    expect(p.native_value).toBe(100_000); // the native side is honestly reported…
    expect(p.legacy_value).toBe("UNKNOWN"); // …but the missing side is UNKNOWN, never fabricated to match
    expect(p.drift_bps).toBe("UNKNOWN"); // no drift is computable, and NONE is invented as 0
  });

  it("legacy events but NO native ⇒ the SAME fail-closed UNKNOWN (symmetric)", async () => {
    await seed("quote.priced", { source: "legacy", shipment: "rat-leg-only", payload: pricedPayload(100_000) });
    const p = await computeModuleParity(DB, "rating");
    expect(p.status).toBe("UNKNOWN");
    expect(p.within_gate).toBe(false);
    expect(p.native_value).toBe("UNKNOWN");
    expect(p.legacy_value).toBe(100_000);
    expect(p.drift_bps).toBe("UNKNOWN");
  });

  it("NO events at all ⇒ UNKNOWN, within_gate:false (a never-run module is not green)", async () => {
    const p = await computeModuleParity(DB, "settlement");
    expect(p.status).toBe("UNKNOWN");
    expect(p.within_gate).toBe(false);
    expect(p.native_value).toBe("UNKNOWN");
    expect(p.legacy_value).toBe("UNKNOWN");
  });
});

// ─── 2. BOTH sides present, within tolerance ⇒ MATCH ─────────────────────────────────────────────────
describe("computeModuleParity — both sides within tolerance ⇒ MATCH (REQ-023)", () => {
  it("rating: native 100000 vs legacy 102000 (196 bps ≤ 1000) ⇒ MATCH, within_gate:true", async () => {
    await seed("quote.priced", { source: "native", shipment: "rat-m-nat", payload: pricedPayload(100_000) });
    await seed("quote.priced", { source: "legacy", shipment: "rat-m-leg", payload: pricedPayload(102_000) });
    const p = await computeModuleParity(DB, "rating");
    expect(p.native_value).toBe(100_000);
    expect(p.legacy_value).toBe(102_000);
    expect(p.drift_bps).toBe(196); // |100000-102000|*10000/102000 = 196
    expect(p.within_gate).toBe(true);
    expect(p.status).toBe("MATCH");
    expect(p.backing_kinds).toEqual(["quote.priced"]);
  });
});

// ─── 3. BOTH sides present, beyond tolerance ⇒ DRIFT ─────────────────────────────────────────────────
describe("computeModuleParity — both sides beyond tolerance ⇒ DRIFT (REQ-023)", () => {
  it("rating: native 100000 vs legacy 200000 (5000 bps > 1000) ⇒ DRIFT, within_gate:false", async () => {
    await seed("quote.priced", { source: "native", shipment: "rat-d-nat", payload: pricedPayload(100_000) });
    await seed("quote.priced", { source: "legacy", shipment: "rat-d-leg", payload: pricedPayload(200_000) });
    const p = await computeModuleParity(DB, "rating");
    expect(p.drift_bps).toBe(5_000);
    expect(p.within_gate).toBe(false);
    expect(p.status).toBe("DRIFT");
  });
});

// ─── 4. PER-MODULE metrics, computed from real source-split events ───────────────────────────────────
describe("computeModuleParity — per-module honest metric from source-split events (REQ-023)", () => {
  it("rating (±10%): sums latest quote.priced sell per stream, native vs legacy; a requote dedups to max-seq", async () => {
    // native requotes on ONE stream (seq 0 then seq 1) — only the latest (120000) counts
    await seed("quote.priced", { source: "native", shipment: "rat-p-nat", seq: 0, payload: pricedPayload(999_999) });
    await seed("quote.priced", { source: "native", shipment: "rat-p-nat", seq: 1, payload: pricedPayload(120_000) });
    await seed("quote.priced", { source: "legacy", shipment: "rat-p-leg", payload: pricedPayload(120_000) });
    const p = await computeModuleParity(DB, "rating");
    expect(p.native_value).toBe(120_000); // latest-per-stream, NOT 999999+120000
    expect(p.legacy_value).toBe(120_000);
    expect(p.drift_bps).toBe(0);
    expect(p.status).toBe("MATCH");
  });

  it("invoicing (±2% + penny): sums invoice.issued line totals; penny-exact match ⇒ drift 0, MATCH", async () => {
    await seed("invoice.issued", { source: "native", shipment: "inv-nat", payload: invoicePayload(120_000) });
    await seed("invoice.issued", { source: "legacy", shipment: "inv-leg", payload: invoicePayload(120_000) });
    const p = await computeModuleParity(DB, "invoicing");
    expect(p.native_value).toBe(120_000);
    expect(p.legacy_value).toBe(120_000);
    expect(p.drift_bps).toBe(0); // penny-exact
    expect(p.within_gate).toBe(true);
    expect(p.status).toBe("MATCH");
    expect(p.backing_kinds).toEqual(["invoice.issued"]);
  });

  it("invoicing (±2%): 83 bps drift (≤ 200) ⇒ MATCH; 2000 bps drift (> 200) ⇒ DRIFT", async () => {
    await seed("invoice.issued", { source: "native", shipment: "inv2-nat", payload: invoicePayload(120_000) });
    await seed("invoice.issued", { source: "legacy", shipment: "inv2-leg", payload: invoicePayload(121_000) });
    const near = await computeModuleParity(DB, "invoicing");
    expect(near.drift_bps).toBe(83); // |120000-121000|*10000/121000 = 82.6 → 83
    expect(near.status).toBe("MATCH");
  });

  it("settlement (±2%): sums split.computed total_cents, native vs legacy", async () => {
    await seed("split.computed", { source: "native", shipment: "set-nat", payload: splitPayload(50_000) });
    await seed("split.computed", { source: "legacy", shipment: "set-leg", payload: splitPayload(50_500) });
    const p = await computeModuleParity(DB, "settlement");
    expect(p.native_value).toBe(50_000);
    expect(p.legacy_value).toBe(50_500);
    expect(p.drift_bps).toBe(99); // |50000-50500|*10000/50500 = 99.0
    expect(p.status).toBe("MATCH");
  });

  it("dispatch: structural COUNT parity over dispatch.assigned + appointment.set, native vs legacy", async () => {
    // native: 1 dispatch.assigned + 1 appointment.set = count 2; legacy: 2 dispatch.assigned = count 2
    await seed("dispatch.assigned", { source: "native", shipment: "dsp-nat-1" });
    await seed("appointment.set", { source: "native", shipment: "dsp-nat-2" });
    await seed("dispatch.assigned", { source: "legacy", shipment: "dsp-leg-1" });
    await seed("dispatch.assigned", { source: "legacy", shipment: "dsp-leg-2" });
    const p = await computeModuleParity(DB, "dispatch");
    expect(p.native_value).toBe(2);
    expect(p.legacy_value).toBe(2);
    expect(p.status).toBe("MATCH");
    expect(p.backing_kinds).toEqual(["dispatch.assigned", "appointment.set"]);
  });

  it("comms: structural COUNT parity over message.sent + message.received; a count gap drifts", async () => {
    await seed("message.sent", { source: "native", shipment: "cm-nat-1" });
    await seed("message.received", { source: "native", shipment: "cm-nat-2" });
    await seed("message.sent", { source: "native", shipment: "cm-nat-3" });
    await seed("message.sent", { source: "legacy", shipment: "cm-leg-1" });
    await seed("message.received", { source: "legacy", shipment: "cm-leg-2" });
    const p = await computeModuleParity(DB, "comms");
    expect(p.native_value).toBe(3);
    expect(p.legacy_value).toBe(2);
    expect(p.drift_bps).toBe(5_000); // |3-2|*10000/2 = 5000 > 200
    expect(p.status).toBe("DRIFT");
    expect(p.within_gate).toBe(false);
  });
});

// ─── 5. computeAllParity — all 5 modules, honestly (UNKNOWN where no data) ────────────────────────────
describe("computeAllParity — all 5 overlay modules, honestly (REQ-152/153)", () => {
  it("returns exactly the 5 modules; a seeded module computes, an unseeded one is fail-closed UNKNOWN", async () => {
    // rating: both sides (MATCH). invoicing: native-only (UNKNOWN). settlement/dispatch/comms: no data (UNKNOWN).
    await seed("quote.priced", { source: "native", shipment: "all-rat-nat", payload: pricedPayload(100_000) });
    await seed("quote.priced", { source: "legacy", shipment: "all-rat-leg", payload: pricedPayload(100_000) });
    await seed("invoice.issued", { source: "native", shipment: "all-inv-nat", payload: invoicePayload(50_000) });

    const all = await computeAllParity(DB);
    expect(all.map((m) => m.module)).toEqual([...PARITY_MODULES]);

    const by = new Map(all.map((m) => [m.module, m]));
    const rating = by.get("rating") as ModuleParity;
    expect(rating.status).toBe("MATCH");
    expect(rating.within_gate).toBe(true);
    // invoicing has native but no legacy mirror → fail-closed UNKNOWN, NOT a fabricated match off one side
    const invoicing = by.get("invoicing") as ModuleParity;
    expect(invoicing.status).toBe("UNKNOWN");
    expect(invoicing.within_gate).toBe(false);
    for (const m of ["settlement", "dispatch", "comms"] as const) {
      expect((by.get(m) as ModuleParity).status).toBe("UNKNOWN");
      expect((by.get(m) as ModuleParity).within_gate).toBe(false);
    }
  });

  it("TODAY (no legacy mirror seeded at all) EVERY module is UNKNOWN + not-green — the pre-Task-4 reality", async () => {
    // Only native events exist in the whole tenant D1 → no legacy side anywhere → all fail-closed.
    await seed("quote.priced", { source: "native", shipment: "today-rat", payload: pricedPayload(100_000) });
    await seed("invoice.issued", { source: "native", shipment: "today-inv", payload: invoicePayload(50_000) });
    const all = await computeAllParity(DB);
    expect(all.every((m) => m.status === "UNKNOWN")).toBe(true);
    expect(all.every((m) => m.within_gate === false)).toBe(true);
  });
});

// ─── 6. tolerances (ONE source of truth) + the divide-by-zero fail-closed edge ────────────────────────
describe("PARITY_TOLERANCE_BPS + edges (REQ-023, CLAUDE.md rule 6)", () => {
  it("tolerances = the fixture replay gates, defined once for all 5 modules", () => {
    expect(PARITY_MODULES).toEqual(["rating", "invoicing", "settlement", "dispatch", "comms"]);
    expect(PARITY_TOLERANCE_BPS.rating).toBe(1_000); // ±10% routes replay gate
    expect(PARITY_TOLERANCE_BPS.invoicing).toBe(200); // ±2% aggregate legacy-export replay gate
    expect(PARITY_TOLERANCE_BPS.settlement).toBe(200); // ±2%
    expect(Object.keys(PARITY_TOLERANCE_BPS).sort()).toEqual([...PARITY_MODULES].sort());
  });

  it("a legacy side of 0 with a nonzero native ⇒ unbounded relative drift ⇒ DRIFT, never a 0/0 MATCH", async () => {
    await seed("split.computed", { source: "native", shipment: "z-nat", payload: splitPayload(100) });
    await seed("split.computed", { source: "legacy", shipment: "z-leg", payload: splitPayload(0) });
    const p = await computeModuleParity(DB, "settlement");
    expect(p.native_value).toBe(100);
    expect(p.legacy_value).toBe(0); // legacy is present (n=1) with value 0 — NOT UNKNOWN
    expect(p.within_gate).toBe(false);
    expect(p.status).toBe("DRIFT"); // both present but unbounded relative drift — fail-closed, not MATCH
  });
});

// THE SOURCE PARTITION (audit §437). `NATIVE_VISIBLE_SOURCES` (queries/unbilled.ts) and this file's
// `TRACKED_SOURCES` are complements over the contract's `source` enum, and the first one decides what every
// money/ops aggregate can SEE: KPIs (workers/api/src/kpis/compute.ts), the SLA sweep, the watchtower anomaly
// scan, the unbilled/billing reads, and the lens. It had no test that named it.
//
// MEASURED before this existed: dropping "edi" from the list left `packages/ledger` 625/625 GREEN, and the
// two api suites that consume it (kpis, source-aware-ledger) exit 0 as well. The entry is not dead —
// `workers/translator/src/core/map-204.ts:208@source` stamps `source: "edi"` on every EDI-tendered event — so a
// silent removal makes EDI freight invisible to every aggregate at once: uninvoiced, un-SLA'd, unwatched.
//
// THE EXPECTATION IS DERIVED FROM THE CONTRACT, NOT RESTATED (§433/§434). A frozen literal would pin today's
// membership but say nothing when a FIFTH source is added to the enum — the case that actually matters,
// because a new source defaults to invisible and nobody is told. Anchoring on the enum minus the legacy
// shadow makes adding a source a decision here rather than an omission.
describe("REQ-014/168: the source partition is total — native-visible ∪ legacy = the contract enum (§437)", () => {
  // LedgerEvent is a DISCRIMINATED UNION over `kind`, so there is no single top-level `source` field: each
  // of the 35 per-kind schemas declares its own. Reading all 35 and requiring them to AGREE is both how the
  // enum is obtained and an invariant worth holding on its own — a kind that accepted a source the others
  // rejected would be a hole in exactly the partition this describe exists to pin.
  const enumValues = (): readonly string[] => {
    const { options } = (
      LedgerEventSchema as unknown as {
        def: { options: ReadonlyArray<{ shape: Record<string, { def?: { entries?: Record<string, string> } }> }> };
      }
    ).def;
    const perKind = options.map((o) => Object.keys(o.shape["source"]?.def?.entries ?? {}).sort().join(","));
    const distinct = [...new Set(perKind)];
    if (perKind.length !== 35) throw new Error(`expected 35 kind schemas, saw ${perKind.length} — re-anchor this test`);
    if (distinct.length !== 1) throw new Error(`the kinds DISAGREE on the source enum: ${distinct.join(" | ")}`);
    return distinct[0]!.split(",");
  };

  it("NATIVE_VISIBLE_SOURCES is EXACTLY the contract's sources minus the legacy shadow", () => {
    const all = enumValues();
    expect(all.length, "non-vacuity: the enum must actually carry sources").toBeGreaterThan(2);
    expect([...NATIVE_VISIBLE_SOURCES].sort()).toEqual(all.filter((s) => s !== "legacy").sort());
  });

  it("the two lists PARTITION the enum — nothing is in both, nothing is in neither", () => {
    // The complement property stated directly. `native` is deliberately in BOTH lists (it is tracked for
    // parity AND natively visible), so the partition is over VISIBILITY, not over the two arrays: every
    // source is either native-visible or the legacy shadow, and `legacy` is the only member of the latter.
    const all = enumValues();
    const visible = new Set<string>(NATIVE_VISIBLE_SOURCES);
    const shadow = all.filter((s) => !visible.has(s));
    expect(shadow).toEqual(["legacy"]);
    expect(TRACKED_SOURCES_FOR_TEST).toContain("legacy"); // the shadow is what parity tracks against native
  });

  it("the emitted SQL names every native-visible source", () => {
    // The registry is consumed as interpolated SQL, so a member that never reaches the predicate is the
    // same defect one layer down.
    const sql = nativeVisibleSourceSql("e.source");
    for (const s of NATIVE_VISIBLE_SOURCES) expect(sql, `${s} missing from the emitted predicate`).toContain(`'${s}'`);
    expect(sql).not.toContain("'legacy'");
  });
});
