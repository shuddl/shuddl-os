import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { EVENT_KINDS, type EventKind } from "@shuddl/contracts";
import { applyMigrations } from "../src/migrate.js";
import {
  projectMoneyLines,
  mapMoneyProjectionError,
  type OriginalLine,
} from "../src/projection/money.js";
import { computeDsoDays } from "../src/queries/metrics.js";
import { allocateCents } from "../src/money/split.js";
import { appendWithMoney, mkEvent, resetEventCounter } from "./helpers.js";
import ledgerCore from "../../../db/tenant/migrations/0001_ledger_core.sql?raw";
import domain from "../../../db/tenant/migrations/0002_domain.sql?raw";
import insertGuards from "../../../db/tenant/migrations/0003_insert_guards.sql?raw";
import uniqueGuards from "../../../db/tenant/migrations/0008_append_only_unique_guards.sql?raw";

const DB = env.TENANT_A_DB;

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-07-20T00:00:00Z");

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
    // REQ-083: with NO resolvable terms (deps.termsDays undefined) the invoice is honest about it —
    // terms/due_ts are NULL ("no terms on file"), never a fabricated due date.
    expect(p.invoices).toEqual([
      { id: "inv-1", party_id: "party-bill", division: "north", total_cents: 120_000, status: "issued", issued_event_id: e.id, mode: "insert", terms: null, due_ts: null },
    ]);
  });

  it("REQ-083 invoice.issued with termsDays -> terms='netN' + due_ts = issue ts + N days (integer ms)", () => {
    const issueTs = 1_720_000_000_000;
    const e = mkEvent("invoice.issued", {
      ts: issueTs,
      payload: { invoice_id: "inv-1", party_id: "party-bill", division: "north", lines: ISSUE_LINES },
    });
    const p = projectMoneyLines(e, { termsDays: 30 });
    expect(p.invoices).toEqual([
      {
        mode: "insert",
        id: "inv-1",
        party_id: "party-bill",
        division: "north",
        total_cents: 120_000,
        status: "issued",
        issued_event_id: e.id,
        terms: "net30",
        due_ts: issueTs + 30 * 86_400_000, // due_ts is the ISSUE ts (not recorded_at) + terms window
      },
    ]);
  });

  it("REQ-083 invoice.issued with NO termsDays -> terms=null, due_ts=null (aging treats it as no-terms-on-file)", () => {
    const e = mkEvent("invoice.issued", {
      payload: { invoice_id: "inv-1", party_id: "party-bill", division: "north", lines: ISSUE_LINES },
    });
    const inv = projectMoneyLines(e, {}).invoices[0];
    expect(inv).toMatchObject({ mode: "insert", terms: null, due_ts: null });
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

  it("invoice.corrected with empty reissue_lines is a VOID: credits only, no reissue, AND the invoices row flips to void/0 (REQ-119 read-model consistency)", () => {
    const e = mkEvent("invoice.corrected", {
      payload: { invoice_id: "inv-1", corrects_event_id: "evt-orig", reason: "void", reissue_lines: [] },
    });
    const p = projectMoneyLines(e, { originalLines: ORIGINAL });
    expect(p.lines).toHaveLength(3);
    expect(p.lines.every((l) => l.kind === "correction_credit")).toBe(true);
    expect(p.lines.reduce((s, l) => s + l.amount_cents, 0)).toBe(-120_000);
    // A void is a correction, NOT a no-op on the AR row: the invoices projection flips OUT of 'issued' to
    // {status:'void', total_cents:0} in the SAME batch as the reversing credits, so the AR read-model and
    // money_lines both land on 0 (the divergence the WP-16 launch audit caught — previously emitted []).
    expect(p.invoices).toEqual([{ mode: "void", id: "inv-1", total_cents: 0, status: "void" }]);
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
    // a void reissues nothing, but it DOES flip the invoices AR row to void/0 (read-model consistency)
    expect(p.invoices).toEqual([{ mode: "void", id: "inv-1", total_cents: 0, status: "void" }]);
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
    expect(p.invoices).toEqual([]); // no matched invoice in deps -> settles nothing (honest no-op)
  });

  it("REQ-083 payment.received (cod) settles the matched invoice to 'paid' when it covers the total; cod_collect UNCHANGED", () => {
    const cod = mkEvent("payment.received", {
      payload: { method: "cod", amount_cents: 120_000, party_id: "party-bill", division: "north" },
    });
    const p = projectMoneyLines(cod, { settleInvoice: { id: "inv-1", total_cents: 120_000 } });
    // The cod_collect money_line is byte-for-byte what it was before REQ-083 (the money math is sacred).
    expect(p.lines).toHaveLength(1);
    expect(p.lines[0]).toMatchObject({ kind: "cod_collect", direction: "ar", amount_cents: -120_000, party_id: "party-bill", division: "north" });
    // ...and the invoice flips to paid (the AR-settlement projection, orthogonal to the money_line).
    expect(p.invoices).toEqual([{ mode: "settle", id: "inv-1", status: "paid" }]);
  });

  it("REQ-083 payment.received settlement is method-agnostic: an ACH payment settles WITHOUT any money_line", () => {
    const ach = mkEvent("payment.received", { payload: { method: "ach", amount_cents: 120_000 } });
    const p = projectMoneyLines(ach, { settleInvoice: { id: "inv-1", total_cents: 120_000 } });
    expect(p.lines).toEqual([]); // non-cod posts no money_line (unchanged) ...
    expect(p.invoices).toEqual([{ mode: "settle", id: "inv-1", status: "paid" }]); // ... but still settles
  });

  // §1267 — WRONG-TYPE payload fields on the MONEY path. `payment.received` is one of doc 10's eight LOOSE
  // JsonObject payloads, so a caller controls the TYPE of every field here; `asInt`/`asString` are the only
  // things standing between that and the projection. Measured: dropping BOTH checks from `asInt`, dropping
  // just `Number.isInteger`, and dropping the `typeof` from `asString` each left this file GREEN — every
  // existing case supplies well-typed values or omits the field, so the guards were exercised by nothing.
  //
  // Three distinct consequences, one test each — they do not stand in for each other:
  describe("§1267 wrong-typed fields on a LOOSE money payload", () => {
    it("a FRACTIONAL amount_cents cannot REACH the projection — `JsonValue` numbers are `SafeInt`", () => {
      // The obvious test here is "10.5 projects a sub-cent money_line without `Number.isInteger`". It cannot be
      // written: `JsonValue` types every number as `SafeInt`, so a float is refused when the EVENT is parsed,
      // long before the projection. `asInt`'s isInteger half is therefore defense-in-depth against an
      // unreachable state — which is why dropping it alone left this file green (§1266's second explanation).
      //
      // "Loose" is loose in TYPE, not in numeric PRECISION. That distinction is the whole reason the two cases
      // below ARE reachable while this one is not, so it is pinned rather than described.
      expect(() => mkEvent("payment.received", { payload: { method: "cod", amount_cents: 10.5 } })).toThrow();
      expect(() => mkEvent("payment.received", { payload: { method: "cod", amount_cents: 50_000 } })).not.toThrow();
    });

    it("a STRING amount_cents does NOT settle an invoice (Math.abs would coerce it)", () => {
      // `Math.abs("120000") >= 120000` is TRUE, so without the typeof an invoice settles off a string.
      const ach = mkEvent("payment.received", { payload: { method: "ach", amount_cents: "120000" } });
      const p = projectMoneyLines(ach, { settleInvoice: { id: "inv-1", total_cents: 120_000 } });
      expect(p.invoices, "a string amount must never flip an invoice to paid").toEqual([]);
      expect(p.lines).toEqual([]);
    });

    it("a NON-STRING party_id falls back to the actor's party — never lands on the money_line", () => {
      const cod = mkEvent("payment.received", { payload: { method: "cod", amount_cents: 50_000, party_id: 42 } });
      const p = projectMoneyLines(cod, {});
      expect(p.lines).toHaveLength(1);
      expect(p.lines[0]?.party_id, "a numeric party_id must not become a money_line's party reference").toBe(
        cod.actor.party,
      );
    });
  });

  it("REQ-083 pay-in-full model: a payment that does NOT cover the total leaves the invoice OPEN (no settle)", () => {
    const partial = mkEvent("payment.received", { payload: { method: "ach", amount_cents: 50_000 } });
    const p = projectMoneyLines(partial, { settleInvoice: { id: "inv-1", total_cents: 120_000 } });
    expect(p.invoices).toEqual([]); // 50_000 < 120_000 -> still outstanding AR (v1 carries no 'partial' state)
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
      // §919 — 0008 IS PART OF THE SHIPPED SCHEMA and this suite omitted it, so every assertion here ran
      // against a database the product never deploys. `workers/api/test/helpers.ts` applies it; the
      // divergence hid a mapper branch that production can never reach.
      { path: "0008_append_only_unique_guards.sql", sql: uniqueGuards },
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

  it("REQ-083 persists due_ts/terms on issue; a covering payment.received flips status='paid'; cod line intact", async () => {
    const issueTs = 1_720_000_000_000;
    const issue = mkEvent("invoice.issued", {
      stream_id: "s:shp-dso", shipment_id: "shp-dso", seq: 0,
      ts: issueTs,
      payload: { invoice_id: "inv-dso", party_id: "party-bill", division: "north", lines: ISSUE_LINES },
    });
    await appendWithMoney(DB, issue, { termsDays: 30 });
    const issued = await DB.prepare("SELECT status, terms, due_ts, total_cents FROM invoices WHERE id = 'inv-dso'").first<{
      status: string; terms: string | null; due_ts: number | null; total_cents: number;
    }>();
    expect(issued).toEqual({ status: "issued", terms: "net30", due_ts: issueTs + 30 * 86_400_000, total_cents: 120_000 });

    // DSO-relevant read: an OPEN invoice is status='issued' with a resolvable due_ts.
    const open = await DB.prepare("SELECT COUNT(*) AS n FROM invoices WHERE id = 'inv-dso' AND status = 'issued' AND due_ts IS NOT NULL").first<{ n: number }>();
    expect(open?.n).toBe(1);

    // The covering COD payment settles the invoice AND posts the unchanged cod_collect money_line.
    const pay = mkEvent("payment.received", {
      stream_id: "s:shp-dso", shipment_id: "shp-dso", seq: 1,
      payload: { method: "cod", amount_cents: 120_000, party_id: "party-bill", division: "north" },
    });
    await appendWithMoney(DB, pay, { settleInvoice: { id: "inv-dso", total_cents: 120_000 } });
    const paid = await DB.prepare("SELECT status FROM invoices WHERE id = 'inv-dso'").first<{ status: string }>();
    expect(paid?.status).toBe("paid");
    const cod = await DB.prepare("SELECT amount_cents, kind FROM money_lines WHERE event_id = ?").bind(pay.id).all<{ amount_cents: number; kind: string }>();
    expect(cod.results).toEqual([{ amount_cents: -120_000, kind: "cod_collect" }]);
  });

  it("Exit audit (REQ-119) read-model consistency: after issue->void the invoices AR (status='issued') == money_lines net (both 0)", async () => {
    const issue = mkEvent("invoice.issued", {
      stream_id: "s:shp-void-rec", shipment_id: "shp-void-rec", seq: 0,
      payload: { invoice_id: "void-rec-1", party_id: "party-bill", division: "north", lines: ISSUE_LINES },
    });
    await appendWithMoney(DB, issue);
    const orig = await loadInEffectLines(issue.id);
    const voidEvt = mkEvent("invoice.corrected", {
      stream_id: "s:shp-void-rec", shipment_id: "shp-void-rec", seq: 1,
      payload: { invoice_id: "void-rec-1", corrects_event_id: issue.id, reason: "void", reissue_lines: [] },
    });
    await appendWithMoney(DB, voidEvt, { originalLines: orig });

    // the invoices AR row flipped OUT of 'issued' to void/0 (was RED: it stayed {status:'issued', 120_000})
    const inv = await DB.prepare("SELECT status, total_cents FROM invoices WHERE id = 'void-rec-1'").first<{ status: string; total_cents: number }>();
    expect(inv).toEqual({ status: "void", total_cents: 0 });

    // THE RECONCILIATION: the two read-models of the SAME invoice AGREE. Open AR (SUM of status='issued'
    // total_cents) and the money_lines net both == 0 — they no longer diverge (the QB/GL export reads
    // money_lines and already reconciled to 0; now the AR surface does too).
    const openAr = await DB.prepare("SELECT COALESCE(SUM(total_cents),0) AS s FROM invoices WHERE id = 'void-rec-1' AND status = 'issued'").first<{ s: number }>();
    const mlNet = await DB.prepare("SELECT COALESCE(SUM(amount_cents),0) AS s FROM money_lines WHERE shipment_id = 'shp-void-rec'").first<{ s: number }>();
    expect(openAr?.s).toBe(0);
    expect(mlNet?.s).toBe(0);
    expect(openAr?.s).toBe(mlNet?.s); // no divergence
  });

  it("Exit audit (REQ-119) read-model: computeDsoDays EXCLUDES a voided invoice (no phantom open AR in DSO)", async () => {
    const issueTs = NOW - 30 * DAY_MS; // 30 days old — a real DSO number while OPEN
    const issue = mkEvent("invoice.issued", {
      stream_id: "s:shp-void-dso", shipment_id: "shp-void-dso", seq: 0, ts: issueTs,
      payload: { invoice_id: "void-dso-1", party_id: "party-bill", division: "north", lines: ISSUE_LINES },
    });
    await appendWithMoney(DB, issue, { termsDays: 30 });
    // while OPEN it IS open AR — DSO is a real number (sanity: the invoice is genuinely in scope).
    expect(await computeDsoDays(DB, { now: NOW, scope: "void-dso-" })).not.toBe("UNKNOWN");

    const orig = await loadInEffectLines(issue.id);
    const voidEvt = mkEvent("invoice.corrected", {
      stream_id: "s:shp-void-dso", shipment_id: "shp-void-dso", seq: 1,
      payload: { invoice_id: "void-dso-1", corrects_event_id: issue.id, reason: "void", reissue_lines: [] },
    });
    await appendWithMoney(DB, voidEvt, { originalLines: orig });
    // after the void the invoice is OUT of 'issued' -> no open AR in scope -> honest UNKNOWN.
    // RED before the fix: the void did NOT flip status, so DSO still counted the full-face invoice.
    expect(await computeDsoDays(DB, { now: NOW, scope: "void-dso-" })).toBe("UNKNOWN");
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
    // The kind is what makes this precise — see mapMoneyProjectionError's note on the shared RAISE text.
    const mapped = mapMoneyProjectionError(caught, "invoice.corrected");
    expect(mapped?.code).toBe("VALIDATION_FAILED");
  });

  it("and the ABORTED batch leaves the read-model untouched — the rollback, not just the error (audit §396)", async () => {
    // WHY THIS IS SEPARATE FROM THE ERROR ASSERTION ABOVE. `INVOICE_VOID_SQL` is UNCONDITIONAL
    // (`UPDATE invoices SET status=?, total_cents=? WHERE id=?`, no `AND status=...`), and its own comment
    // justifies that: "redelivery is already blocked upstream by the ux_ml_corrects UNIQUE on the reversing
    // money_lines (a second void of the same event aborts the whole batch), so this UPDATE never re-runs
    // standalone."
    //
    // So an UNGUARDED money write is safe because of a UNIQUE index on a DIFFERENT table plus the sequencer's
    // single `db.batch()`. The test above proves the UNIQUE fires. It does not prove the ROLLBACK — and the
    // rollback is the half that matters: if the batch were split, or D1's batch stopped being atomic, the
    // invoice row would flip to void/0 while the reversing money_lines never landed. The read model would then
    // say "voided, AR 0" over money_lines that still net positive — a divergence with no event to explain it,
    // on the one money table the append-only guards deliberately exclude.
    const issue = mkEvent("invoice.issued", {
      stream_id: "s:shp-rb", shipment_id: "shp-rb", seq: 0,
      payload: { invoice_id: "inv-rb", party_id: "party-bill", division: "north", lines: ISSUE_LINES },
    });
    await appendWithMoney(DB, issue);
    const orig = await loadInEffectLines(issue.id);

    const c1 = mkEvent("invoice.corrected", {
      stream_id: "s:shp-rb", shipment_id: "shp-rb", seq: 1,
      payload: { invoice_id: "inv-rb", corrects_event_id: issue.id, reason: "first", reissue_lines: ISSUE_LINES },
    });
    await appendWithMoney(DB, c1, { originalLines: orig });

    const snap = async (): Promise<{ inv: unknown; lines: number }> => ({
      inv: await DB.prepare("SELECT status, total_cents, issued_event_id FROM invoices WHERE id = ?").bind("inv-rb").first(),
      lines: (await DB.prepare("SELECT COUNT(*) AS n FROM money_lines WHERE shipment_id = ?").bind("shp-rb").first<{ n: number }>())?.n ?? -1,
    });
    const before = await snap();

    // A VOID (empty reissue_lines) that corrects the SAME event again: the reversing lines collide on
    // ux_ml_corrects, so the batch must abort with NOTHING applied — including the unconditional void UPDATE.
    const c2 = mkEvent("invoice.corrected", {
      stream_id: "s:shp-rb", shipment_id: "shp-rb", seq: 2,
      payload: { invoice_id: "inv-rb", corrects_event_id: issue.id, reason: "second", reissue_lines: [] },
    });
    await expect(appendWithMoney(DB, c2, { originalLines: orig })).rejects.toThrow();

    const after = await snap();
    expect(after.inv, "the invoices row must be unchanged after the aborted batch").toEqual(before.inv);
    expect(after.lines, "no money_line may survive an aborted batch").toBe(before.lines);
  });

  it("a payment.received can NEVER resurrect a VOIDED invoice — the settle guard, mutation-proved (audit §396)", async () => {
    // `INVOICE_SETTLE_SQL` carries `AND status='issued'`, justified as making "a re-projected payment (or a
    // second payment) a harmless no-op". That reason understates it, and the understatement is why nothing
    // tested it: a second payment against a PAID invoice writes 'paid' over 'paid' — removing the guard
    // changes nothing observable, so a test built on the stated reason cannot fail.
    //
    // The transition the guard actually forbids is VOID → PAID. A payment.received that arrives after a void
    // (the customer paid before the credit was raised; the event projects afterwards) would otherwise flip a
    // voided invoice to 'paid' — AR reporting a settled invoice that was cancelled, with no event saying so.
    // Removing `AND status='issued'` left all 618 ledger tests green.
    const issue = mkEvent("invoice.issued", {
      stream_id: "s:shp-vp", shipment_id: "shp-vp", seq: 0,
      payload: { invoice_id: "inv-vp", party_id: "party-bill", division: "north", lines: ISSUE_LINES },
    });
    await appendWithMoney(DB, issue);
    const orig = await loadInEffectLines(issue.id);

    // VOID it: an invoice.corrected with empty reissue_lines flips the row to void/0.
    const voided = mkEvent("invoice.corrected", {
      stream_id: "s:shp-vp", shipment_id: "shp-vp", seq: 1,
      payload: { invoice_id: "inv-vp", corrects_event_id: issue.id, reason: "cancelled", reissue_lines: [] },
    });
    await appendWithMoney(DB, voided, { originalLines: orig });
    const afterVoid = await DB.prepare("SELECT status FROM invoices WHERE id = ?").bind("inv-vp").first<{ status: string }>();
    expect(afterVoid?.status, "precondition: the invoice is voided").toBe("void");

    // Now a payment lands against it — and `settleInvoice` is supplied EXPLICITLY, naming the voided row.
    //
    // NON-VACUITY, and the reason this line exists: `appendWithMoney` defaults its deps to `{}`, so calling it
    // without `settleInvoice` means the projection has nothing to settle and issues NO update at all. The first
    // version of this test did exactly that and passed with the guard REMOVED — it was asserting that nothing
    // happens when nothing is attempted. Supplying the dep simulates precisely the dangerous case: a matcher
    // that handed the projection a voided invoice. `AND status='issued'` is then the only thing standing.
    const paid = mkEvent("payment.received", {
      stream_id: "s:shp-vp", shipment_id: "shp-vp", seq: 2,
      payload: { invoice_id: "inv-vp", party_id: "party-bill", amount_cents: 1, method: "ach", reference: "late-payment" },
    });
    await appendWithMoney(DB, paid, { settleInvoice: { id: "inv-vp", total_cents: 0 } });

    const after = await DB.prepare("SELECT status FROM invoices WHERE id = ?").bind("inv-vp").first<{ status: string }>();
    expect(after?.status, "a voided invoice must stay voided — a late payment cannot settle what was cancelled").toBe("void");
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

  // §919 — THE PRECISION HALF. Both money_lines guards raise the SAME text, so the trigger branch is gated
  // on the event kind. Without that gate an unrelated duplicate-line abort — 0003's id/(event_id,line_no)
  // guard, which fires on a REPLAY of any money-bearing event — would be reported to the client as
  // "invoice already corrected": a confidently wrong answer, which is worse than the 500 it replaced.
  it("the trigger text alone does NOT map — a non-correction keeps surfacing as INTERNAL", () => {
    const abort = new Error("D1_ERROR: I1: projections are append-only: SQLITE_CONSTRAINT");
    expect(mapMoneyProjectionError(abort, "invoice.issued")).toBeNull();
    expect(mapMoneyProjectionError(abort)).toBeNull(); // no kind supplied → unmapped, never guessed
    expect(mapMoneyProjectionError(abort, "invoice.corrected")?.code).toBe("VALIDATION_FAILED");
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
