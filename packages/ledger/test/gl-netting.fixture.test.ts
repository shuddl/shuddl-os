import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { eventFixture, type LedgerEvent } from "@shuddl/contracts";
import { applyMigrations } from "../src/migrate.js";
import { type MoneyProjectionDeps, type OriginalLine } from "../src/projection/money.js";
import { exportJournal } from "../src/gl/export.js";
import { appendWithMoney } from "./helpers.js";
import ledgerCore from "../../../db/tenant/migrations/0001_ledger_core.sql?raw";
import domain from "../../../db/tenant/migrations/0002_domain.sql?raw";
import insertGuards from "../../../db/tenant/migrations/0003_insert_guards.sql?raw";
import seedText from "../../../fixtures/gl-netting/seed.json?raw";

// THE WP-02 DoD (I7): correction pairs net to zero through the REAL projection path, and the
// journal reconciles to the uncorrected total to the penny. The seed is the vendored, hash-
// pinned fixture (fixtures/manifest.json gl-netting) — this test replays its exact bytes.

// A `type` (not `interface`) so it carries an implicit index signature — required for the payload
// literal to satisfy the loose JsonObject member of the LedgerEvent payload union.
type SeedLine = {
  line_no: number;
  kind: "freight" | "fsc" | "accessorial";
  amount_cents: number;
  gl_map: string;
};
interface SeedBase {
  id: string;
  hash: string;
  stream_id: string;
  shipment_id: string;
  seq: number;
  division: string;
  party_id: string;
  invoice_id: string;
}
type SeedEvent =
  | (SeedBase & { kind: "invoice.issued"; lines: SeedLine[] })
  | (SeedBase & { kind: "invoice.corrected"; corrects_event_id: string; reissue_lines: SeedLine[] });
interface Seed {
  uncorrected_total_cents: number;
  corrected_shipments: number[];
  divisions: string[];
  events: SeedEvent[];
}

const DB = env.TENANT_A_DB;
const seed = JSON.parse(seedText) as Seed;
const RANGE = { from: 0, to: Number.MAX_SAFE_INTEGER };

function buildEvent(s: SeedEvent): LedgerEvent {
  const common = { id: s.id, hash: s.hash, stream_id: s.stream_id, shipment_id: s.shipment_id, seq: s.seq };
  if (s.kind === "invoice.issued") {
    return eventFixture("invoice.issued", {
      ...common,
      payload: { invoice_id: s.invoice_id, party_id: s.party_id, division: s.division, lines: s.lines },
    });
  }
  return eventFixture("invoice.corrected", {
    ...common,
    payload: {
      invoice_id: s.invoice_id,
      corrects_event_id: s.corrects_event_id,
      reason: "fixture-correction",
      reissue_lines: s.reissue_lines,
    },
  });
}

async function loadInEffectLines(correctsEventId: string): Promise<OriginalLine[]> {
  const r = await DB.prepare(
    "SELECT line_no, amount_cents, gl_map, party_id, division FROM money_lines WHERE event_id = ? AND amount_cents > 0 ORDER BY line_no",
  )
    .bind(correctsEventId)
    .all<OriginalLine>();
  return r.results;
}

beforeAll(async () => {
  await applyMigrations(DB, [
    { path: "0001_ledger_core.sql", sql: ledgerCore },
    { path: "0002_domain.sql", sql: domain },
    { path: "0003_insert_guards.sql", sql: insertGuards },
  ]);
  // Seed strictly in file order through the REAL projection (appendWithMoney == sequencer path).
  for (const s of seed.events) {
    const deps: MoneyProjectionDeps =
      s.kind === "invoice.corrected" ? { originalLines: await loadInEffectLines(s.corrects_event_id) } : {};
    await appendWithMoney(DB, buildEvent(s), deps);
  }
});

describe("I7 DoD — 20 shipments, 8 corrections (4 round-trip pairs): the netting fixture", () => {
  it("(a) every corrected event: reversed originals + correction credits net to exactly 0", async () => {
    const corrected = await DB.prepare(
      "SELECT DISTINCT corrects_event_id AS e FROM money_lines WHERE corrects_event_id IS NOT NULL",
    ).all<{ e: string }>();
    expect(corrected.results).toHaveLength(8); // 4 shipments x 2 corrections each
    for (const { e } of corrected.results) {
      const orig = await DB.prepare(
        "SELECT COALESCE(SUM(amount_cents),0) AS s FROM money_lines WHERE event_id = ? AND amount_cents > 0",
      )
        .bind(e)
        .first<{ s: number }>();
      const credit = await DB.prepare(
        "SELECT COALESCE(SUM(amount_cents),0) AS s FROM money_lines WHERE corrects_event_id = ? AND kind = 'correction_credit'",
      )
        .bind(e)
        .first<{ s: number }>();
      expect((orig?.s ?? 0) + (credit?.s ?? 0)).toBe(0);
    }
  });

  it("(b) the journal balances: sum(debits) === sum(credits)", async () => {
    const journal = await exportJournal(DB, RANGE);
    const debits = journal.reduce((s, l) => s + l.debit_cents, 0);
    const credits = journal.reduce((s, l) => s + l.credit_cents, 0);
    expect(journal.reduce((s, l) => s + l.debit_cents - l.credit_cents, 0)).toBe(0);
    expect(debits).toBe(credits);
  });

  it("(c) the grand AR total equals the uncorrected 20-shipment total, to the penny", async () => {
    const grand = await DB.prepare(
      "SELECT COALESCE(SUM(amount_cents),0) AS s FROM money_lines WHERE direction = 'ar'",
    ).first<{ s: number }>();
    expect(grand?.s).toBe(seed.uncorrected_total_cents);
  });

  it("(d) a division filter partitions the journal with ZERO leakage (REQ-057)", async () => {
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

  it("(d') invoices carry division and filter (REQ-057 'filterable everywhere')", async () => {
    const total = await DB.prepare("SELECT COUNT(*) AS c FROM invoices").first<{ c: number }>();
    expect(total?.c).toBe(20);
    let summed = 0;
    for (const div of seed.divisions) {
      const c = await DB.prepare("SELECT COUNT(*) AS c FROM invoices WHERE division = ?")
        .bind(div)
        .first<{ c: number }>();
      summed += c?.c ?? 0;
    }
    expect(summed).toBe(20); // every invoice lands in exactly one division bucket
  });
});
