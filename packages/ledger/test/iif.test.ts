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

  // §1271 — THE TIEBREAKS. The fixture above carries FOUR DISTINCT ACCOUNTS, so `account` alone decides its
  // whole order and the remaining three clauses of `compareLines` (event_id → money_line_id → debit-first)
  // never engage. Measured: deleting each of those three left packages/ledger GREEN, while deleting `account`
  // REDs 2 — one clause of four exercised, under a test named "order-insensitive".
  //
  // This journal is the accountant-facing artifact (CLAUDE.md: the QB export reconciles to the penny). An
  // unstable line order does not change any total, which is precisely why it would survive review: it turns a
  // diff of two exports of the SAME period into noise, and that is how a real discrepancy gets skipped.
  //
  // Fixture: every line on ONE account, so account cannot decide anything, and money_line ids DELIBERATELY
  // ordered against event ids (evt-1 holds ml-8/ml-9, evt-2 holds ml-1) — otherwise dropping `event_id` would
  // yield the same sequence by accident and the clause would look defended when it is not (§1260).
  describe("§1271 the tiebreaks below `account` (event_id → money_line_id → debit before credit)", () => {
    const ACC = GL_AR_CONTROL;
    const ln = (event_id: string, money_line_id: string, debit: number, credit: number): JournalLine => ({
      account: ACC, debit_cents: debit, credit_cents: credit, division: "main", event_id, money_line_id, kind: "freight",
    });
    const A = ln("evt-1", "ml-8", 100, 0);
    const B = ln("evt-1", "ml-8", 0, 100);
    const C = ln("evt-1", "ml-9", 50, 0);
    const D = ln("evt-1", "ml-9", 0, 50);
    const E = ln("evt-2", "ml-1", 20, 0);
    const F = ln("evt-2", "ml-1", 0, 20);
    // evt-1 before evt-2; within evt-1, ml-8 before ml-9; within each pair, the DEBIT first.
    const EXPECTED_AMOUNTS = ["1.00", "-1.00", "0.50", "-0.50", "0.20", "-0.20"];
    const amountsOf = (iif: string): string[] =>
      iif
        .split("\r\n")
        .filter((l) => l.startsWith("TRNS\t") || l.startsWith("SPL\t"))
        .map((l) => l.split("\t")[4]!);

    it("orders on every clause, from an input that is neither the answer nor its reverse", () => {
      const input = [D, A, F, C, B, E]; // ≠ expected, and ≠ reverse(expected) — a stable sort cannot imitate it
      const out = amountsOf(serializeJournalIIF(input, opts));
      // PREMISE: one account throughout, so `account` decides nothing here.
      expect(new Set([A, B, C, D, E, F].map((l) => l.account)).size).toBe(1);
      expect(out).toEqual(EXPECTED_AMOUNTS);
    });

    it("two different interleavings of the same lines serialize byte-identically", () => {
      const p1 = serializeJournalIIF([D, A, F, C, B, E], opts);
      const p2 = serializeJournalIIF([E, C, A, F, B, D], opts);
      expect(p1).toBe(p2);
      expect(amountsOf(p1)).toEqual(EXPECTED_AMOUNTS);
    });
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

// §1498 (REQ-020/118) — THE GRID GUARD WAS DEFENDED BY NOTHING.
//
// `clean()` exists because a tab or a record terminator inside any field would corrupt a tab-delimited,
// CRLF-terminated grid: a tab in CLASS shifts every column to its right by one, and a newline in DOCNUM ends
// the record early and starts a fake one. Its header says exactly that. MEASURED at §1498: replacing its body
// with `return s;` leaves the ledger suite **728/728 green** — the same silence `csvField` had in
// `packages/adapters`, and the second instance of one idiom (§1349's rule: at instance two, count the class).
//
// It is not redundant, which is the other explanation for a silent mutation (§1389). The account is canonical
// and the ids are synthetic, but **CLASS carries `division` and DOCNUM carries a caller-supplied label** —
// tenant text, unconstrained. A division named `North<TAB>West` silently moves every amount one column left in
// a file that still imports.
//
// The cases pin the contract as WRITTEN — control characters become a SPACE (not stripped, not escaped, not
// quoted) — so a future "improvement" to strip or quote them is a deliberate change to the artifact rather
// than a silent one. The grid invariant is asserted as a COUNT, computed from the header line, never restated.
describe("§1498 serializeJournalIIF — a hostile field cannot break the tab-delimited grid", () => {
  const OPTS = { date: Date.UTC(2026, 7, 14) };
  const dataRows = (iif: string): string[] => iif.split(EOL).filter((l) => l.startsWith("TRNS\t") || l.startsWith("SPL\t"));
  /** The declared column count, read off the `!TRNS` header rather than restated. */
  const width = (iif: string): number => iif.split(EOL)[0]!.split("\t").length;

  it("a TAB in the division does not add a column", () => {
    const iif = serializeJournalIIF(arPair(306_030, "north\twest", "evt_1", "ml_1"), OPTS);
    const rows = dataRows(iif);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.split("\t")).toHaveLength(width(iif));
    expect(rows[0]!.split("\t").at(-1)).toBe("north west"); // CLASS is last: the tab became a space, in place
  });

  it("a CR/LF/CRLF in the docNum does not create a record", () => {
    for (const brk of ["\r", "\n", "\r\n"]) {
      const iif = serializeJournalIIF(arPair(100, "north", "evt_1", "ml_1"), { ...OPTS, docNum: `P1${brk}P2` });
      expect(dataRows(iif), `a ${JSON.stringify(brk)} split the record`).toHaveLength(2);
      const docnum = dataRows(iif)[0]!.split("\t")[5];
      expect(docnum).toBe(brk === "\r\n" ? "P1  P2" : "P1 P2"); // each control char → one space, none dropped
    }
  });

  it("a control character in the MEMO (event_id) is neutralised in place", () => {
    const iif = serializeJournalIIF(arPair(100, "north", "evt\r\n1", "ml_1"), OPTS);
    expect(dataRows(iif)).toHaveLength(2);
    for (const r of dataRows(iif)) expect(r.split("\t")).toHaveLength(width(iif));
  });

  it("a benign field is passed through untouched (the guard does not rewrite ordinary values)", () => {
    const iif = serializeJournalIIF(arPair(100, "north-west 2", "evt_1", "ml_1"), { ...OPTS, docNum: "2026-08" });
    const cols = dataRows(iif)[0]!.split("\t");
    expect(cols[5]).toBe("2026-08");
    expect(cols.at(-1)).toBe("north-west 2"); // spaces and hyphens are not control characters
  });
});
