import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  eventFixture,
  isCanonicalGlAccount,
  type LedgerEvent,
  GL_AR_CONTROL,
  GL_AP_CONTROL,
  GL_FREIGHT_AR,
  GL_FSC_AR,
  GL_ACCESSORIAL_AR,
  GL_INTERLINE_AP,
  GL_COD_CLEARING,
  GL_SETTLEMENT_FEE,
} from "@shuddl/contracts";
import { applyMigrations } from "../src/migrate.js";
import { type MoneyProjectionDeps } from "../src/projection/money.js";
import { exportJournal, type JournalLine } from "../src/gl/export.js";
import { serializeJournalIIF } from "../src/gl/iif.js";
import { appendWithMoney } from "./helpers.js";
import ledgerCore from "../../../db/tenant/migrations/0001_ledger_core.sql?raw";
import domain from "../../../db/tenant/migrations/0002_domain.sql?raw";
import insertGuards from "../../../db/tenant/migrations/0003_insert_guards.sql?raw";
import seedText from "../../../fixtures/qb/seed.json?raw";

// THE WP-11 Task-3 DoD (REQ-020): a synthetic MONTH of money events replays through the REAL money
// projection + exportJournal and reconciles TO THE PENNY (integer cents) — the double-entry balances,
// the AR side reconciles (control ↔ revenue+clearing), the AP side reconciles (control ↔ interline+
// settle), a division filter partitions with zero leak (REQ-057), and the IIF is byte-stable +
// canonical-only. The seed is the vendored, hash-pinned fixture (fixtures/manifest.json qb-journal-
// month) — this test replays its exact bytes. Corrections/netting are covered by gl-netting; this
// fixture proves the chart-of-accounts BREADTH (AR + COD + interline AP + settle AP across divisions).
//
// The live "QuickBooks sandbox" round-trip (importing the emitted IIF into a real QB sandbox company)
// is an EXTERNAL CONFIRM step — the in-repo proof of penny-reconciliation is THIS test.

// A `type` (not `interface`) so the money line carries an implicit index signature — required for the
// payload literal to satisfy the loose JsonObject member of the LedgerEvent payload union.
type SeedInvoiceLine = {
  line_no: number;
  kind: "freight" | "fsc" | "accessorial";
  amount_cents: number;
  gl_map: string;
};
type SeedAllocation = { party_id: string; share_bps: number };
interface SeedBase {
  id: string;
  hash: string;
  stream_id: string;
  shipment_id: string;
  seq: number;
  division: string;
  ts: number;
  recorded_at: number;
}
type SeedEvent =
  | (SeedBase & { kind: "invoice.issued"; invoice_id: string; party_id: string; lines: SeedInvoiceLine[] })
  | (SeedBase & { kind: "payment.received"; method: "cod" | "ach"; amount_cents: number; party_id: string; settles_invoice_id?: string })
  | (SeedBase & { kind: "split.computed"; total_cents: number; allocations: SeedAllocation[] })
  | (SeedBase & { kind: "settlement.executed"; fee_cents: number; party_id: string });
interface Seed {
  ar_revenue_cents: number;
  cod_collect_cents: number;
  ar_control_net_cents: number;
  ap_total_cents: number;
  invoice_count: number;
  settled_count: number;
  cod_count: number;
  split_count: number;
  settle_fee_count: number;
  range_from: number;
  range_to: number;
  divisions: string[];
  events: SeedEvent[];
}

const DB = env.TENANT_A_DB;
const seed = JSON.parse(seedText) as Seed;
const RANGE = { from: seed.range_from, to: seed.range_to };

// The AR-side accounts a money_line credits (revenue + COD cash clearing) and the AP-side accounts an
// AP line debits (interline owed + settle fee). Drawn from the ONE canonical registry — never re-typed
// — so a code drift on the export side turns this reconcile red, not a hand-copied string.
const AR_REVENUE = new Set<string>([GL_FREIGHT_AR, GL_FSC_AR, GL_ACCESSORIAL_AR]);
const AR_ACCOUNTS = new Set<string>([...AR_REVENUE, GL_COD_CLEARING]);
const AP_ACCOUNTS = new Set<string>([GL_INTERLINE_AP, GL_SETTLEMENT_FEE]);

const sumDebit = (j: JournalLine[], pred: (l: JournalLine) => boolean): number =>
  j.reduce((s, l) => s + (pred(l) ? l.debit_cents : 0), 0);
const sumCredit = (j: JournalLine[], pred: (l: JournalLine) => boolean): number =>
  j.reduce((s, l) => s + (pred(l) ? l.credit_cents : 0), 0);

function buildEvent(s: SeedEvent): LedgerEvent {
  const common = {
    id: s.id,
    hash: s.hash,
    stream_id: s.stream_id,
    shipment_id: s.shipment_id,
    seq: s.seq,
    ts: s.ts,
    recorded_at: s.recorded_at,
  };
  switch (s.kind) {
    case "invoice.issued":
      return eventFixture("invoice.issued", {
        ...common,
        payload: { invoice_id: s.invoice_id, party_id: s.party_id, division: s.division, lines: s.lines },
      });
    case "payment.received":
      return eventFixture("payment.received", {
        ...common,
        payload: {
          method: s.method,
          amount_cents: s.amount_cents,
          party_id: s.party_id,
          division: s.division,
          ...(s.settles_invoice_id !== undefined ? { invoice_id: s.settles_invoice_id } : {}),
        },
      });
    case "split.computed":
      return eventFixture("split.computed", {
        ...common,
        payload: { total_cents: s.total_cents, allocations: s.allocations },
      });
    case "settlement.executed":
      return eventFixture("settlement.executed", {
        ...common,
        payload: { fee_cents: s.fee_cents, party_id: s.party_id, division: s.division },
      });
    default: {
      const _never: never = s;
      return _never;
    }
  }
}

// The deps the sequencer resolves SERVER-SIDE for each kind: split/settle/cod carry the shipment
// division (their payloads don't drive it through the money projection's division fallback here we set
// it explicitly), and a settling ACH payment carries the OPEN invoice it covers — loaded from the
// invoices read-model exactly as the sequencer matches it (by the payment's invoice_id).
async function depsFor(s: SeedEvent): Promise<MoneyProjectionDeps> {
  if (s.kind === "split.computed" || s.kind === "settlement.executed") return { division: s.division };
  if (s.kind === "payment.received") {
    if (s.method === "cod") return { division: s.division };
    if (s.settles_invoice_id !== undefined) {
      const inv = await DB.prepare("SELECT id, total_cents FROM invoices WHERE id = ?")
        .bind(s.settles_invoice_id)
        .first<{ id: string; total_cents: number }>();
      return inv !== null ? { settleInvoice: { id: inv.id, total_cents: inv.total_cents } } : {};
    }
  }
  return {};
}

beforeAll(async () => {
  await applyMigrations(DB, [
    { path: "0001_ledger_core.sql", sql: ledgerCore },
    { path: "0002_domain.sql", sql: domain },
    { path: "0003_insert_guards.sql", sql: insertGuards },
  ]);
  // Seed strictly in file order through the REAL projection (appendWithMoney == sequencer path).
  for (const s of seed.events) {
    await appendWithMoney(DB, buildEvent(s), await depsFor(s));
  }
});

describe("REQ-020 DoD — a synthetic month reconciles to the penny (the QB journal export)", () => {
  it("(a) the journal balances: Σdebit === Σcredit (double-entry, by construction)", async () => {
    const journal = await exportJournal(DB, RANGE);
    expect(journal.length).toBeGreaterThan(0);
    const debits = journal.reduce((s, l) => s + l.debit_cents, 0);
    const credits = journal.reduce((s, l) => s + l.credit_cents, 0);
    expect(debits).toBe(credits);
    expect(journal.reduce((s, l) => s + l.debit_cents - l.credit_cents, 0)).toBe(0);
  });

  it("(b) the AR side reconciles: Σ debits to 1200-AR === Σ AR revenue+clearing credits, to the penny", async () => {
    const journal = await exportJournal(DB, RANGE);
    const debitToControl = sumDebit(journal, (l) => l.account === GL_AR_CONTROL);
    const creditToArAccounts = sumCredit(journal, (l) => AR_ACCOUNTS.has(l.account));
    expect(debitToControl).toBe(seed.ar_control_net_cents);
    expect(creditToArAccounts).toBe(seed.ar_control_net_cents);
    // No AR debit ever lands on a revenue/clearing account, and no AR credit on the control.
    expect(sumDebit(journal, (l) => AR_ACCOUNTS.has(l.account))).toBe(0);
    expect(sumCredit(journal, (l) => l.account === GL_AR_CONTROL)).toBe(0);
  });

  it("(c) the AP side reconciles: Σ credits to 2000-AP === Σ interline+settle debits, to the penny", async () => {
    const journal = await exportJournal(DB, RANGE);
    const creditToControl = sumCredit(journal, (l) => l.account === GL_AP_CONTROL);
    const debitToApAccounts = sumDebit(journal, (l) => AP_ACCOUNTS.has(l.account));
    expect(creditToControl).toBe(seed.ap_total_cents);
    expect(debitToApAccounts).toBe(seed.ap_total_cents);
    expect(sumCredit(journal, (l) => AP_ACCOUNTS.has(l.account))).toBe(0);
    expect(sumDebit(journal, (l) => l.account === GL_AP_CONTROL)).toBe(0);
  });

  it("(d) the journal reconciles to the invoices read-model: revenue credits === Σ invoices.total_cents", async () => {
    const journal = await exportJournal(DB, RANGE);
    const revenueCredits = sumCredit(journal, (l) => AR_REVENUE.has(l.account));
    expect(revenueCredits).toBe(seed.ar_revenue_cents);

    const inv = await DB.prepare(
      "SELECT COUNT(*) AS c, COALESCE(SUM(total_cents),0) AS t FROM invoices",
    ).first<{ c: number; t: number }>();
    expect(inv?.t).toBe(seed.ar_revenue_cents); // the AR grand total === Σ issued invoice totals
    expect(inv?.c).toBe(seed.invoice_count);

    const paid = await DB.prepare(
      "SELECT COUNT(*) AS c FROM invoices WHERE status = 'paid'",
    ).first<{ c: number }>();
    expect(paid?.c).toBe(seed.settled_count); // every settling ACH payment flipped exactly one invoice
  });

  it("(e) a division filter partitions the journal with ZERO leakage (REQ-057)", async () => {
    const full = await exportJournal(DB, RANGE);
    const fullDebits = full.reduce((s, l) => s + l.debit_cents, 0);
    let partitionedDebits = 0;
    let partitionedRows = 0;
    for (const div of seed.divisions) {
      const j = await exportJournal(DB, RANGE, { division: div });
      expect(j.every((l) => l.division === div)).toBe(true); // no foreign division leaks in
      partitionedDebits += j.reduce((s, l) => s + l.debit_cents, 0);
      partitionedRows += j.length;
    }
    expect(partitionedDebits).toBe(fullDebits); // the partitions reconstitute the whole
    expect(partitionedRows).toBe(full.length); // no row dropped, none double-counted
  });

  it("(f) the IIF serialization is deterministic (byte-stable) and every account is canonical", async () => {
    const iif1 = serializeJournalIIF(await exportJournal(DB, RANGE), { date: seed.range_from, docNum: "MONTH" });
    const iif2 = serializeJournalIIF(await exportJournal(DB, RANGE), { date: seed.range_from, docNum: "MONTH" });
    expect(iif1).toBe(iif2); // two independent export→serialize passes are byte-identical
    expect(iif1.startsWith("!TRNS")).toBe(true);
    const full = await exportJournal(DB, RANGE);
    for (const l of full) expect(isCanonicalGlAccount(l.account)).toBe(true);
  });

  it("(g) the month created_ts window captures the whole fixture (no event outside the range)", async () => {
    const windowed = await exportJournal(DB, RANGE);
    const openEnded = await exportJournal(DB, { from: 0, to: Number.MAX_SAFE_INTEGER });
    expect(windowed.length).toBe(openEnded.length);
  });
});
