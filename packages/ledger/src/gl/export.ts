// REQ-112 — journal export (the ONLY GL surface SHUDDL builds; native GL/period close is do-not-
// build). Each money_line becomes a balanced double entry: an AR line debits 1200-AR and credits
// its gl_map; an AP line debits its gl_map and credits 2000-AP. A signed amount flows to BOTH sides,
// so the export is balanced BY CONSTRUCTION — and we assert Σdebits === Σcredits before returning.
// INTEGER CENTS ONLY (no float touches a journal amount).

const AR_CONTROL = "1200-AR";
const AP_CONTROL = "2000-AP";

export interface JournalLine {
  account: string;
  debit_cents: number;
  credit_cents: number;
  division: string;
  event_id: string;
  money_line_id: string;
  kind: string;
}

export interface JournalRange {
  from: number; // inclusive created_ts (epoch ms)
  to: number; // inclusive created_ts
}

export interface JournalFilter {
  division?: string;
}

interface MoneyLineRecord {
  id: string;
  event_id: string;
  direction: string;
  kind: string;
  amount_cents: number;
  division: string;
  gl_map: string;
}

/**
 * Export the double-entry journal for money_lines whose created_ts is within `range`, optionally
 * scoped to a single division (REQ-057: a division filter partitions the journal with no leakage).
 */
export async function exportJournal(
  db: D1Database,
  range: JournalRange,
  filter?: JournalFilter,
): Promise<JournalLine[]> {
  const clauses = ["created_ts >= ?", "created_ts <= ?"];
  const params: (string | number)[] = [range.from, range.to];
  if (filter?.division !== undefined) {
    clauses.push("division = ?");
    params.push(filter.division);
  }
  const res = await db
    .prepare(
      `SELECT id, event_id, direction, kind, amount_cents, division, gl_map FROM money_lines WHERE ${clauses.join(" AND ")} ORDER BY created_ts, event_id, line_no`,
    )
    .bind(...params)
    .all<MoneyLineRecord>();

  const journal: JournalLine[] = [];
  for (const m of res.results) {
    const control = m.direction === "ap" ? AP_CONTROL : AR_CONTROL;
    // AR: debit the control account, credit the revenue gl_map. AP: debit the expense gl_map,
    // credit the control account. Signed amounts carry corrections through unchanged.
    const debitAccount = m.direction === "ap" ? m.gl_map : control;
    const creditAccount = m.direction === "ap" ? control : m.gl_map;
    const shared = { division: m.division, event_id: m.event_id, money_line_id: m.id, kind: m.kind };
    journal.push({ account: debitAccount, debit_cents: m.amount_cents, credit_cents: 0, ...shared });
    journal.push({ account: creditAccount, debit_cents: 0, credit_cents: m.amount_cents, ...shared });
  }

  const debits = journal.reduce((s, l) => s + l.debit_cents, 0);
  const credits = journal.reduce((s, l) => s + l.credit_cents, 0);
  if (debits !== credits) {
    throw new Error(`exportJournal: double-entry violated — Σdebits ${debits} !== Σcredits ${credits}`);
  }
  return journal;
}
