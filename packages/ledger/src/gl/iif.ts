// REQ-020 — the QuickBooks-importable JOURNAL serializer. A DETERMINISTIC IIF (Intuit Interchange Format)
// journal-import artifact from exportJournal's balanced JournalLine[]. IIF is QuickBooks' tab-delimited
// import format: a `!TRNS`/`!SPL`/`!ENDTRNS` header block declaring the columns, then transaction data rows.
//
// This is a ONE-WAY journal artifact — NATIVE GL FORBIDDEN (the only GL surface SHUDDL builds). No period
// close, no running balances, nothing beyond the double entry: the file carries exactly the balanced lines
// exportJournal already produced, formatted for QuickBooks' General Journal importer.
//
// THE SHAPE (the standard IIF journal): a SINGLE `GENERAL JOURNAL` transaction. The lines are sorted
// deterministically (account, then event_id — with money_line_id + debit-before-credit as total-order
// tiebreaks); the FIRST sorted line is emitted as the `TRNS` row, every remaining line as an `SPL` row.
// Each row's AMOUNT is `debit_cents − credit_cents` (debits positive, credits negative — the IIF sign
// convention) formatted dollars.cents. Because exportJournal guarantees Σdebit === Σcredit, the whole
// transaction nets to exactly 0.00 — QuickBooks' balancing requirement for a journal entry.
//
// PURE: takes JournalLine[] + opts, returns a string. No I/O, no D1, no clock — the same input serializes
// byte-identically forever (the Task-5 tenant export reuses it). INTEGER CENTS ONLY: the cents→dollars.cents
// formatting divides with integer div/mod + padStart, so no float ever touches an amount.

import { isCanonicalGlAccount } from "@shuddl/contracts";
import type { JournalLine } from "./export.js";

export interface IifJournalOptions {
  /** Entry date stamped on every TRNS/SPL row, epoch ms. Formatted MM/DD/YYYY in UTC — deterministic. */
  date: number;
  /** Optional DOCNUM for the single journal entry (e.g. a period label). Defaults to "" (empty column). */
  docNum?: string;
}

const EOL = "\r\n"; // the canonical IIF/Windows record terminator; every record is terminated, incl. the last.
const TAB = "\t";
const TRNSTYPE = "GENERAL JOURNAL";
// The declared columns (after the row tag). MEMO carries the line's event_id (the ledger citation); CLASS
// carries the division (the idiomatic QuickBooks class↔division mapping — REQ-057).
const COLUMNS = ["TRNSTYPE", "DATE", "ACCOUNT", "AMOUNT", "DOCNUM", "MEMO", "CLASS"] as const;

// Defensive: a tab/newline in any field would corrupt the tab-delimited/record-terminated grid. The account
// is canonical (no such chars) and ids are synthetic, but strip control chars so a malformed value can never
// break the format.
function clean(s: string): string {
  return s.replace(/[\t\r\n]/g, " ");
}

// Integer cents → "dollars.cents". No float division: split off the last two digits with %/− and integer
// /100, then padStart the fractional part. 306030 → "3060.30"; 5 → "0.05"; -4500 → "-45.00".
function formatCents(cents: number): string {
  const negative = cents < 0;
  const abs = negative ? -cents : cents;
  const frac = abs % 100;
  const whole = (abs - frac) / 100; // exact: (abs - frac) is a multiple of 100
  return `${negative ? "-" : ""}${whole}.${String(frac).padStart(2, "0")}`;
}

// epoch ms → "MM/DD/YYYY" in UTC (deterministic — no local timezone drift).
function formatDate(ms: number): string {
  const d = new Date(ms);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${mm}/${dd}/${String(d.getUTCFullYear())}`;
}

// Total-order comparator: account, then event_id, then money_line_id, then debit-before-credit. Uses raw
// code-unit string comparison (NOT localeCompare — locale-independent, so the bytes are stable everywhere).
function compareLines(a: JournalLine, b: JournalLine): number {
  if (a.account !== b.account) return a.account < b.account ? -1 : 1;
  if (a.event_id !== b.event_id) return a.event_id < b.event_id ? -1 : 1;
  if (a.money_line_id !== b.money_line_id) return a.money_line_id < b.money_line_id ? -1 : 1;
  const an = a.debit_cents - a.credit_cents;
  const bn = b.debit_cents - b.credit_cents;
  return bn - an; // larger net (the debit side) sorts first
}

/**
 * Serialize a balanced JournalLine[] as a deterministic QuickBooks IIF General Journal artifact.
 * Throws if any account is not a canonical GL account, or if the lines are unbalanced (Σdebit !== Σcredit).
 */
export function serializeJournalIIF(lines: JournalLine[], opts: IifJournalOptions): string {
  // Guard 1 — every account is canonical (a hand-typed/native GL code can never slip into the artifact).
  // Guard 2 — the double entry balances, so the emitted transaction nets to 0.00 (IIF's requirement).
  let debits = 0;
  let credits = 0;
  for (const l of lines) {
    if (!isCanonicalGlAccount(l.account)) {
      throw new Error(`serializeJournalIIF: non-canonical GL account "${l.account}" (native GL forbidden)`);
    }
    debits += l.debit_cents;
    credits += l.credit_cents;
  }
  if (debits !== credits) {
    throw new Error(`serializeJournalIIF: unbalanced journal — Σdebits ${debits} !== Σcredits ${credits}`);
  }

  const rows: string[] = [
    `!TRNS${TAB}${COLUMNS.join(TAB)}`,
    `!SPL${TAB}${COLUMNS.join(TAB)}`,
    `!ENDTRNS`,
  ];

  // An empty journal is the header block ONLY — no TRNS/ENDTRNS transaction (a zero-line entry is invalid).
  if (lines.length > 0) {
    const date = formatDate(opts.date);
    const docNum = clean(opts.docNum ?? "");
    const sorted = [...lines].sort(compareLines);
    sorted.forEach((l, i) => {
      const tag = i === 0 ? "TRNS" : "SPL"; // the first line opens the entry; the rest are splits
      const amount = formatCents(l.debit_cents - l.credit_cents);
      rows.push([tag, TRNSTYPE, date, clean(l.account), amount, docNum, clean(l.event_id), clean(l.division)].join(TAB));
    });
    rows.push("ENDTRNS");
  }

  return rows.map((r) => r + EOL).join("");
}
