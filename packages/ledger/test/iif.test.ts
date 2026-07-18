import { describe, expect, it } from "vitest";
import { serializeJournalIIF } from "../src/gl/iif.js";
import type { JournalLine } from "../src/gl/export.js";
import {
  CANONICAL_GL_ACCOUNTS,
  GL_AR_CONTROL,
  GL_AP_CONTROL,
  GL_FREIGHT_AR,
  GL_INTERLINE_AP,
} from "@shuddl/contracts";

// REQ-020 — the QuickBooks-importable journal serializer. A DETERMINISTIC, tab-delimited IIF
// (!TRNS/!SPL/!ENDTRNS GENERAL JOURNAL) artifact from exportJournal's balanced JournalLine[]. It is a
// ONE-WAY journal artifact — NATIVE GL FORBIDDEN (no period close, no balances beyond the double entry).
//
// Shape (the standard IIF journal): a single GENERAL JOURNAL transaction. Lines are sorted
// deterministically (account, event_id, money_line_id, debit-before-credit); the FIRST is the TRNS row,
// every remaining line an SPL row. AMOUNT = debit_cents − credit_cents formatted dollars.cents (debits
// positive, credits negative), so — because Σdebit === Σcredit — the transaction nets to exactly 0.00.
// DATE (UTC MM/DD/YYYY) + DOCNUM come from opts; MEMO = the line's event_id (ledger citation), CLASS =
// division (REQ-057 — the idiomatic QuickBooks class↔division mapping).

const EOL = "\r\n";

// A canonical AR pair (one money_line → two JournalLines: control debit + gl_map credit) and an AP pair.
function arPair(amount: number, division: string, eventId: string, mlId: string): JournalLine[] {
  const shared = { division, event_id: eventId, money_line_id: mlId, kind: "freight" };
  return [
    { account: GL_AR_CONTROL, debit_cents: amount, credit_cents: 0, ...shared },
    { account: GL_FREIGHT_AR, debit_cents: 0, credit_cents: amount, ...shared },
  ];
}
function apPair(amount: number, division: string, eventId: string, mlId: string): JournalLine[] {
  const shared = { division, event_id: eventId, money_line_id: mlId, kind: "interline_split" };
  return [
    { account: GL_INTERLINE_AP, debit_cents: amount, credit_cents: 0, ...shared },
    { account: GL_AP_CONTROL, debit_cents: 0, credit_cents: amount, ...shared },
  ];
}

// Extract the AMOUNT column (index 4) off every TRNS/SPL data row.
function amountsOf(iif: string): string[] {
  return iif
    .split(EOL)
    .filter((l) => l.startsWith("TRNS\t") || l.startsWith("SPL\t"))
    .map((l) => l.split("\t")[4]!);
}
// AMOUNT dollars.cents string → integer cents (no float — used only to assert the SPL net).
function toCents(dollars: string): number {
  const neg = dollars.startsWith("-");
  const [whole, frac] = (neg ? dollars.slice(1) : dollars).split(".");
  const cents = Number(whole) * 100 + Number(frac);
  return neg ? -cents : cents;
}

describe("serializeJournalIIF — exact integer-cents → dollars.cents", () => {
  it("306030 → 3060.30 and the credit side → -3060.30 (no float drift)", () => {
    const iif = serializeJournalIIF(arPair(306030, "main", "evt-1", "ml-1"), { date: Date.UTC(2026, 6, 17) });
    expect(iif).toContain(`\t${GL_AR_CONTROL}\t3060.30\t`);
    expect(iif).toContain(`\t${GL_FREIGHT_AR}\t-3060.30\t`);
  });

  it("penny + dollar boundaries: 5 → 0.05, 100 → 1.00 (integer div/mod, padStart)", () => {
    const iif = serializeJournalIIF(
      [...arPair(5, "main", "evt-a", "ml-a"), ...arPair(100, "main", "evt-b", "ml-b")],
      { date: Date.UTC(2026, 0, 1) },
    );
    expect(iif).toContain("\t0.05\t");
    expect(iif).toContain("\t-0.05\t");
    expect(iif).toContain("\t1.00\t");
    expect(iif).toContain("\t-1.00\t");
  });
});

describe("serializeJournalIIF — deterministic byte-identical output", () => {
  // A fixed journal: one AR pair (306030) + one AP pair (4500), across two divisions/events, supplied
  // OUT of sorted order. The serializer must produce EXACTLY these bytes, every time.
  const lines: JournalLine[] = [
    ...arPair(306030, "main", "evt-1", "ml-1"), // AR control debit / freight credit
    ...apPair(4500, "east", "evt-2", "ml-2"), // interline debit / AP control credit
  ];
  const opts = { date: Date.UTC(2026, 6, 17) }; // 07/17/2026 UTC

  const expected = [
    "!TRNS\tTRNSTYPE\tDATE\tACCOUNT\tAMOUNT\tDOCNUM\tMEMO\tCLASS",
    "!SPL\tTRNSTYPE\tDATE\tACCOUNT\tAMOUNT\tDOCNUM\tMEMO\tCLASS",
    "!ENDTRNS",
    "TRNS\tGENERAL JOURNAL\t07/17/2026\t1200-AR\t3060.30\t\tevt-1\tmain",
    "SPL\tGENERAL JOURNAL\t07/17/2026\t2000-AP\t-45.00\t\tevt-2\teast",
    "SPL\tGENERAL JOURNAL\t07/17/2026\t4000-FREIGHT-AR\t-3060.30\t\tevt-1\tmain",
    "SPL\tGENERAL JOURNAL\t07/17/2026\t5000-INTERLINE-AP\t45.00\t\tevt-2\teast",
    "ENDTRNS",
  ].map((l) => l + EOL).join("");

  it("byte-equals the pinned fixture", () => {
    expect(serializeJournalIIF(lines, opts)).toBe(expected);
  });

  it("is order-insensitive: a shuffled input serializes byte-identically", () => {
    const shuffled = [lines[3]!, lines[0]!, lines[2]!, lines[1]!];
    expect(serializeJournalIIF(shuffled, opts)).toBe(expected);
    expect(serializeJournalIIF(shuffled, opts)).toBe(serializeJournalIIF(lines, opts));
  });
});

describe("serializeJournalIIF — the transaction balances (SPL lines net to 0)", () => {
  it("Σ(TRNS+SPL amounts) === 0 to the penny", () => {
    const lines = [
      ...arPair(306030, "main", "evt-1", "ml-1"),
      ...apPair(4500, "east", "evt-2", "ml-2"),
      ...arPair(99, "west", "evt-3", "ml-3"),
    ];
    const net = amountsOf(serializeJournalIIF(lines, { date: Date.UTC(2026, 6, 17) })).reduce((s, a) => s + toCents(a), 0);
    expect(net).toBe(0);
  });

  it("unbalanced input (Σdebit !== Σcredit) throws — never emits a lopsided journal", () => {
    const bad: JournalLine[] = [
      { account: GL_AR_CONTROL, debit_cents: 100, credit_cents: 0, division: "main", event_id: "e", money_line_id: "m", kind: "freight" },
      { account: GL_FREIGHT_AR, debit_cents: 0, credit_cents: 99, division: "main", event_id: "e", money_line_id: "m", kind: "freight" },
    ];
    expect(() => serializeJournalIIF(bad, { date: Date.UTC(2026, 6, 17) })).toThrow(/unbalanced/i);
  });
});

describe("serializeJournalIIF — every account is canonical; native-GL is forbidden", () => {
  it("every ACCOUNT token in the output is a registered canonical GL account", () => {
    const iif = serializeJournalIIF(
      [...arPair(306030, "main", "evt-1", "ml-1"), ...apPair(4500, "east", "evt-2", "ml-2")],
      { date: Date.UTC(2026, 6, 17) },
    );
    const accounts = iif
      .split(EOL)
      .filter((l) => l.startsWith("TRNS\t") || l.startsWith("SPL\t"))
      .map((l) => l.split("\t")[3]!);
    expect(accounts.length).toBeGreaterThan(0);
    for (const a of accounts) expect(CANONICAL_GL_ACCOUNTS.has(a)).toBe(true);
  });

  it("a non-canonical account throws (a hand-typed GL code cannot slip into the artifact)", () => {
    const bad: JournalLine[] = [
      { account: "9999-MADE-UP", debit_cents: 100, credit_cents: 0, division: "main", event_id: "e", money_line_id: "m", kind: "freight" },
      { account: GL_FREIGHT_AR, debit_cents: 0, credit_cents: 100, division: "main", event_id: "e", money_line_id: "m", kind: "freight" },
    ];
    expect(() => serializeJournalIIF(bad, { date: Date.UTC(2026, 6, 17) })).toThrow(/canonical/i);
  });
});

describe("serializeJournalIIF — degenerate + docnum", () => {
  it("an empty journal emits only the !TRNS/!SPL/!ENDTRNS header block (no transaction)", () => {
    const iif = serializeJournalIIF([], { date: Date.UTC(2026, 6, 17) });
    expect(iif).toBe(["!TRNS\tTRNSTYPE\tDATE\tACCOUNT\tAMOUNT\tDOCNUM\tMEMO\tCLASS", "!SPL\tTRNSTYPE\tDATE\tACCOUNT\tAMOUNT\tDOCNUM\tMEMO\tCLASS", "!ENDTRNS"].map((l) => l + EOL).join(""));
    expect(iif).not.toContain("\nTRNS\t");
    expect(iif).not.toContain("ENDTRNS\r\nTRNS");
  });

  it("a docNum rides every TRNS/SPL row deterministically", () => {
    const iif = serializeJournalIIF(arPair(306030, "main", "evt-1", "ml-1"), { date: Date.UTC(2026, 6, 17), docNum: "JE-2026-07" });
    for (const l of iif.split(EOL).filter((x) => x.startsWith("TRNS\t") || x.startsWith("SPL\t"))) {
      expect(l.split("\t")[5]).toBe("JE-2026-07");
    }
  });
});
