import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { EVENT_KINDS, type EventKind } from "@shuddl/contracts";
import { applyMigrations } from "../src/migrate.js";
import {
  projectMoneyLines,
  mapMoneyProjectionError,
  type OriginalLine,
} from "../src/projection/money.js";
import { allocateCents } from "../src/money/split.js";
import { appendWithMoney, mkEvent, resetEventCounter } from "./helpers.js";
import ledgerCore from "../../../db/tenant/migrations/0001_ledger_core.sql?raw";
import domain from "../../../db/tenant/migrations/0002_domain.sql?raw";
import insertGuards from "../../../db/tenant/migrations/0003_insert_guards.sql?raw";

const DB = env.TENANT_A_DB;

const ISSUE_LINES = [
  { line_no: 1, kind: "freight" as const, amount_cents: 100_000, gl_map: "4000-FREIGHT" },
  { line_no: 2, kind: "fsc" as const, amount_cents: 15_000, gl_map: "4100-FSC" },
  { line_no: 3, kind: "accessorial" as const, amount_cents: 5_000, gl_map: "4200-ACC" },
];
const ORIGINAL: OriginalLine[] = ISSUE_LINES.map((l) => ({
  line_no: l.line_no,
  amount_cents: l.amount_cents,
  gl_map: l.gl_map,
  party_id: "party-bill",
  division: "north",
}));

describe("REQ-012 — projectMoneyLines is a pure projection of the event payload", () => {
  it("invoice.issued -> one positive AR row per line + the invoices projection row (REQ-057)", () => {
    const e = mkEvent("invoice.issued", {
      payload: { invoice_id: "inv-1", party_id: "party-bill", division: "north", lines: ISSUE_LINES },
    });
    const p = projectMoneyLines(e, {});
    expect(p.lines).toHaveLength(3);
    expect(p.lines.map((l) => l.kind)).toEqual(["freight", "fsc", "accessorial"]);
    expect(p.lines.every((l) => l.direction === "ar")).toBe(true);
    expect(p.lines.every((l) => l.amount_cents > 0)).toBe(true);
    expect(p.lines.every((l) => l.party_id === "party-bill" && l.division === "north")).toBe(true);
    expect(p.lines.every((l) => l.event_id === e.id && l.corrects_event_id === null)).toBe(true);
    expect(p.invoices).toEqual([
      { id: "inv-1", party_id: "party-bill", division: "north", total_cents: 120_000, status: "issued", issued_event_id: e.id, mode: "insert" },
    ]);
  });

  it("invoice.corrected (reissue) -> full reversal of the originals + reissue debits; credit+original net to 0 (I7)", () => {
    const e = mkEvent("invoice.corrected", {
      payload: {
        invoice_id: "inv-1",
        corrects_event_id: "evt-orig",
        reason: "reweigh correction",
        reissue_lines: [
          { line_no: 1, kind: "freight", amount_cents: 110_000, gl_map: "4000-FREIGHT" },
          { line_no: 2, kind: "fsc", amount_cents: 15_000, gl_map: "4100-FSC" },
          { line_no: 3, kind: "accessorial", amount_cents: 5_000, gl_map: "4200-ACC" },
        ],
      },
    });
    const p = projectMoneyLines(e, { originalLines: ORIGINAL });
    const credits = p.lines.filter((l) => l.kind === "correction_credit");
    const debits = p.lines.filter((l) => l.kind === "correction_debit");
    expect(credits).toHaveLength(3);
    expect(debits).toHaveLength(3);
    // credits reverse the originals exactly, tagged with corrects_event_id
    expect(credits.map((l) => l.amount_cents)).toEqual([-100_000, -15_000, -5_000]);
    expect(credits.every((l) => l.corrects_event_id === "evt-orig")).toBe(true);
    // debits are the new charges (not reversals -> corrects_event_id null); line_no offset avoids
    // the UNIQUE(event_id,line_no) collision with the credits.
    expect(debits.map((l) => l.amount_cents)).toEqual([110_000, 15_000, 5_000]);
    expect(debits.every((l) => l.corrects_event_id === null)).toBe(true);
    expect(new Set(p.lines.map((l) => l.line_no)).size).toBe(6);
    // THE I7 IDENTITY: reversed originals + credits sum to exactly zero.
    const originalsSum = ORIGINAL.reduce((s, l) => s + l.amount_cents, 0);
    const creditsSum = credits.reduce((s, l) => s + l.amount_cents, 0);
    expect(originalsSum + creditsSum).toBe(0);
    expect(p.invoices).toEqual([
      { id: "inv-1", total_cents: 130_000, status: "issued", issued_event_id: e.id, mode: "update" },
    ]);
  });

  it("invoice.corrected with empty reissue_lines is a VOID: credits only, no reissue, no invoice upsert", () => {
    const e = mkEvent("invoice.corrected", {
      payload: { invoice_id: "inv-1", corrects_event_id: "evt-orig", reason: "void", reissue_lines: [] },
    });
    const p = projectMoneyLines(e, { originalLines: ORIGINAL });
    expect(p.lines).toHaveLength(3);
    expect(p.lines.every((l) => l.kind === "correction_credit")).toBe(true);
    expect(p.lines.reduce((s, l) => s + l.amount_cents, 0)).toBe(-120_000);
    expect(p.invoices).toEqual([]);
  });

  it("Exit audit (REQ-119) I7: voiding an all-positive invoice nets stream AR to EXACTLY 0", () => {
    // InvoiceLine.amount_cents is now non-negative, so every in-effect line clears #moneyDeps's
    // `amount_cents > 0` filter and the void reverses the WHOLE invoice. Pre-fix a -3000 line could be
    // issued, escape that filter, and leave AR = -3000 after a void (I7 "to the penny" violated).
    const issued: OriginalLine[] = [
      { line_no: 1, amount_cents: 10_000, gl_map: "4000-FREIGHT", party_id: "party-bill", division: "north" },
      { line_no: 2, amount_cents: 3_000, gl_map: "4200-ACC", party_id: "party-bill", division: "north" },
    ];
    const voidEvt = mkEvent("invoice.corrected", {
      payload: { invoice_id: "inv-1", corrects_event_id: "evt-orig", reason: "void", reissue_lines: [] },
    });
    const p = projectMoneyLines(voidEvt, { originalLines: issued });
    const issuedSum = issued.reduce((s, l) => s + l.amount_cents, 0);
    const voidSum = p.lines.reduce((s, l) => s + l.amount_cents, 0);
    expect(issuedSum + voidSum).toBe(0); // AR after the void: exactly zero
    expect(p.lines.every((l) => l.kind === "correction_credit")).toBe(true);
    expect(p.invoices).toEqual([]); // a void reissues nothing
  });

  it("split.computed -> interline_split AP rows via Hamilton allocation; zero-cent shares are dropped", () => {
    const e = mkEvent("split.computed", {
      payload: {
        total_cents: 100_000,
        allocations: [
          { party_id: "carrier-a", share_bps: 7_000 },
          { party_id: "carrier-b", share_bps: 3_000 },
        ],
      },
    });
    const p = projectMoneyLines(e, { division: "north" });
    expect(p.lines.map((l) => ({ k: l.kind, d: l.direction, a: l.amount_cents, party: l.party_id }))).toEqual([
      { k: "interline_split", d: "ap", a: 70_000, party: "carrier-a" },
      { k: "interline_split", d: "ap", a: 30_000, party: "carrier-b" },
    ]);
    expect(p.lines.reduce((s, l) => s + l.amount_cents, 0)).toBe(100_000);

    const tiny = mkEvent("split.computed", {
      payload: {
        total_cents: 1,
        allocations: [
          { party_id: "a", share_bps: 3_334 },
          { party_id: "b", share_bps: 3_333 },
          { party_id: "c", share_bps: 3_333 },
        ],
      },
    });
    const pt = projectMoneyLines(tiny, { division: "north" });
    expect(pt.lines).toHaveLength(1); // [1,0,0] -> only the nonzero share survives (money CHECK amount!=0)
    expect(pt.lines[0]?.amount_cents).toBe(1);
  });

  it("payment.received projects NOTHING unless it is a COD collection", () => {
    const ach = mkEvent("payment.received", { payload: { method: "ach", amount_cents: 50_000 } });
    expect(projectMoneyLines(ach, {}).lines).toEqual([]);
    const cod = mkEvent("payment.received", {
      payload: { method: "cod", amount_cents: 50_000, party_id: "party-bill", division: "north" },
    });
    const p = projectMoneyLines(cod, {});
    expect(p.lines).toHaveLength(1);
    expect(p.lines[0]).toMatchObject({ kind: "cod_collect", direction: "ar", amount_cents: -50_000 });
  });

  it("settlement.executed -> a dormant settle_fee AP row (synthetic; the feature is CONFIRM-gated)", () => {
    const e = mkEvent("settlement.executed", {
      payload: { fee_cents: 2_500, party_id: "factor-x", division: "north" },
    });
    const p = projectMoneyLines(e, {});
    expect(p.lines).toHaveLength(1);
    expect(p.lines[0]).toMatchObject({ kind: "settle_fee", direction: "ap", amount_cents: 2_500 });
  });

  it("every one of the other 30 kinds projects [] (exhaustive switch + never guard)", () => {
    const MONEY_KINDS = new Set<EventKind>([
      "invoice.issued", "invoice.corrected", "split.computed", "payment.received", "settlement.executed",
    ]);
    for (const kind of EVENT_KINDS) {
      if (MONEY_KINDS.has(kind)) continue;
      const e = mkEvent(kind);
      const p = projectMoneyLines(e, {});
      expect(p.lines, `kind ${kind} must project no money`).toEqual([]);
      expect(p.invoices).toEqual([]);
    }
  });
});

describe("REQ-012 / I7 — applyMoneyProjection through real D1 (append batch + ux_ml_corrects)", () => {
  beforeAll(async () => {
    resetEventCounter();
    await applyMigrations(DB, [
      { path: "0001_ledger_core.sql", sql: ledgerCore },
      { path: "0002_domain.sql", sql: domain },
      { path: "0003_insert_guards.sql", sql: insertGuards },
    ]);
  });

  it("persists the invoices projection row so invoices.division is filterable (REQ-057)", async () => {
    const e = mkEvent("invoice.issued", {
      stream_id: "s:shp-a", shipment_id: "shp-a",
      payload: { invoice_id: "inv-a", party_id: "party-bill", division: "west", lines: ISSUE_LINES },
    });
    await appendWithMoney(DB, e);
    const inv = await DB.prepare("SELECT division, total_cents, status FROM invoices WHERE id = 'inv-a'").first<{
      division: string; total_cents: number; status: string;
    }>();
    expect(inv).toEqual({ division: "west", total_cents: 120_000, status: "issued" });
    const ml = await DB.prepare("SELECT COUNT(*) c FROM money_lines WHERE event_id = ?").bind(e.id).first<{ c: number }>();
    expect(ml?.c).toBe(3);
  });

  it("double-correcting the same event violates ux_ml_corrects -> mapped to VALIDATION_FAILED (I7)", async () => {
    const issue = mkEvent("invoice.issued", {
      stream_id: "s:shp-b", shipment_id: "shp-b", seq: 0,
      payload: { invoice_id: "inv-b", party_id: "party-bill", division: "north", lines: ISSUE_LINES },
    });
    await appendWithMoney(DB, issue);
    const orig = await loadInEffectLines(issue.id);

    const c1 = mkEvent("invoice.corrected", {
      stream_id: "s:shp-b", shipment_id: "shp-b", seq: 1,
      payload: { invoice_id: "inv-b", corrects_event_id: issue.id, reason: "first", reissue_lines: ISSUE_LINES },
    });
    await appendWithMoney(DB, c1, { originalLines: orig }); // first correction: fine

    const c2 = mkEvent("invoice.corrected", {
      stream_id: "s:shp-b", shipment_id: "shp-b", seq: 2,
      payload: { invoice_id: "inv-b", corrects_event_id: issue.id, reason: "second", reissue_lines: ISSUE_LINES },
    });
    let caught: unknown;
    try {
      await appendWithMoney(DB, c2, { originalLines: orig }); // corrects the SAME event again
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const mapped = mapMoneyProjectionError(caught);
    expect(mapped?.code).toBe("VALIDATION_FAILED");
  });
});

describe("Exit audit (REQ-119) Minor: an allocateCents throw maps to VALIDATION_FAILED, not INTERNAL", () => {
  it("a postcondition failure (bps not summing to 10000) is a client 4xx", () => {
    // Off-path: Zod normally rejects shares that don't sum to 10000, but if such input reaches the
    // allocator its throw must not surface as an opaque INTERNAL 500.
    let caught: unknown;
    try {
      allocateCents(100, [5_000]); // sums to 5000 → postcondition throws
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(mapMoneyProjectionError(caught)?.code).toBe("VALIDATION_FAILED");
  });
  it("a bad-share input error (negative bps) also maps to VALIDATION_FAILED", () => {
    let caught: unknown;
    try {
      allocateCents(100, [-1]);
    } catch (e) {
      caught = e;
    }
    expect(mapMoneyProjectionError(caught)?.code).toBe("VALIDATION_FAILED");
  });
  it("an unrelated error is NOT swallowed (returns null so the sequencer can 500 it)", () => {
    expect(mapMoneyProjectionError(new Error("something else entirely"))).toBeNull();
  });
});

async function loadInEffectLines(eventId: string): Promise<OriginalLine[]> {
  const r = await DB.prepare(
    "SELECT line_no, amount_cents, gl_map, party_id, division FROM money_lines WHERE event_id = ? AND amount_cents > 0 ORDER BY line_no",
  )
    .bind(eventId)
    .all<OriginalLine>();
  return r.results;
}
