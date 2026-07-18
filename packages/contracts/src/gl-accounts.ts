// REQ-020 — the ONE canonical chart-of-accounts for the journal export (the ONLY GL surface SHUDDL
// builds; native GL/period close is do-not-build). Every gl_map string that can reach a money_lines
// row and every control account the double-entry export debits/credits is registered HERE, once, so
// the QB journal export reconciles against a SINGLE chart of accounts (Task-3 qb-journal-month) — a
// divergent hand-typed code cannot slip in on the Biller side, the projection side, or the fixture side.
//
// These STRINGS are FROZEN reality: real invoice.issued events carry the AR codes below in their
// payload gl_map, so renaming one would ORPHAN stored events (append-only, I3/I7). ADD codes here,
// never rename. Pure data — no zod, no I/O (contracts stays the schema boundary; these are constants
// consumed by @shuddl/agents' GL_MAP and @shuddl/ledger's money projection / journal export alike).

// AR revenue accounts — the Biller posts one per billable quote-line kind (@shuddl/agents GL_MAP is
// keyed by line kind and draws its account strings from these three; the compose path emits them onto
// invoice.issued.lines[].gl_map).
export const GL_FREIGHT_AR = "4000-FREIGHT-AR";
export const GL_FSC_AR = "4100-FSC-AR";
export const GL_ACCESSORIAL_AR = "4200-ACCESSORIAL-AR";

// Non-invoice accounts — the money projection assigns these for the money kinds that carry NO invoice
// line (their gl_map is chosen by the projection, not the payload).
export const GL_INTERLINE_AP = "5000-INTERLINE-AP"; // interline_split (AP owed to the executing carrier)
export const GL_COD_CLEARING = "1300-COD-CLEARING"; // cod_collect (cash collected at the door)
export const GL_SETTLEMENT_FEE = "5100-SETTLEMENT-FEE"; // settle_fee (CONFIRM-gated; dormant)

// Control accounts — every double entry debits/credits one of these against the line's gl_map.
export const GL_AR_CONTROL = "1200-AR";
export const GL_AP_CONTROL = "2000-AP";

// The canonical set: membership IS the parity invariant. Any gl_map/control code emitted onto a
// money_line or a journal line that is NOT in here is an unregistered account — the parity test
// (share-lint-matchers-with-parity-tests) turns red before a penny-break can reach the QB export.
export const CANONICAL_GL_ACCOUNTS: ReadonlySet<string> = new Set([
  GL_FREIGHT_AR,
  GL_FSC_AR,
  GL_ACCESSORIAL_AR,
  GL_INTERLINE_AP,
  GL_COD_CLEARING,
  GL_SETTLEMENT_FEE,
  GL_AR_CONTROL,
  GL_AP_CONTROL,
]);

/** True when `code` is a registered canonical GL account. The single membership check both the lint
 *  and the parity test call — never a re-authored comparison (share-lint-matchers). */
export function isCanonicalGlAccount(code: string): boolean {
  return CANONICAL_GL_ACCOUNTS.has(code);
}
