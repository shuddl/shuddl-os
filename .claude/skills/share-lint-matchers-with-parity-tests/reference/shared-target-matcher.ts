/**
 * reference/shared-target-matcher.ts
 *
 * Extractable "one matcher, every surface" pattern for SHUDDL guarded-table lints.
 * Grounded in tools/checks/invariants.ts (SCHEMA/DELIM/Q fragments at :22-31, the
 * migration matcher at :63-66, the divergent source scanner FORBIDDEN_REPLACE at :204).
 *
 * The defect this closes: FORBIDDEN_REPLACE was hand-copied with literal `\s+` and no
 * SCHEMA fragment, so `INSERT OR REPLACE INTO"events"` (abutting quote) and
 * `INSERT OR REPLACE INTO main.events` (schema-qualified) evaded the SOURCE scanner
 * while the MIGRATION matcher (built from the shared fragments) caught both.
 *
 * Fix: define the identifier/schema/delimiter fragments ONCE, expose a builder both
 * surfaces call, and lock it with a parity test over a shared probe corpus.
 */

// ── Shared fragments (these already live at invariants.ts:22-31 — import from there;
//    duplicated here only so this reference file reads standalone). ────────────────
const QOPEN = `["'\`\\[]`; // opening quote / backtick / bracket
const Q = `${QOPEN}?`; // optional opening delimiter before an identifier
const QCLOSE = `["'\`\\]]?`; // optional closing delimiter after an identifier
// Optional schema qualifier: main.  "main".  [main].  `main`.  (whitespace around dot ok)
const SCHEMA = `(?:${Q}\\w+${QCLOSE}\\s*\\.\\s*)?`;
// A name may follow whitespace OR abut a delimiter with none (zero-width lookahead).
const DELIM = `(?:\\s+|(?=${QOPEN}))`;

// The three append-only tables (invariants.ts:16). Guarded everywhere.
export const GUARDED = "(events|positions|money_lines)";

/**
 * Build a "verb → guarded target" matcher ONCE. Every surface — migration SQL and
 * TS source alike — must consume this, never re-author a regex.
 *
 * @param verbs alternation of leading verbs, e.g. "INSERT\\s+OR\\s+REPLACE\\s+INTO|REPLACE\\s+INTO"
 */
export const guardedTargetMatcher = (verbs: string): RegExp =>
  new RegExp(`\\b(${verbs})${DELIM}${SCHEMA}${Q}${GUARDED}\\b`, "gi");

// The REPLACE rule, now derived from the shared builder on BOTH surfaces:
export const FORBIDDEN_REPLACE = guardedTargetMatcher("INSERT\\s+OR\\s+REPLACE\\s+INTO|REPLACE\\s+INTO");

// ── Parity probe corpus ───────────────────────────────────────────────────────────
// Each probe MUST be flagged by EVERY scanner enforcing the rule. The first two are the
// exact strings that split the two copies in the real defect.
export const REPLACE_EVASION_CORPUS: readonly string[] = [
  `INSERT OR REPLACE INTO"events" VALUES(1)`, // abutting quote — beat literal \s+
  `INSERT OR REPLACE INTO main.events VALUES(1)`, // schema-qualified — beat missing SCHEMA
  `INSERT OR REPLACE INTO "main".events VALUES(1)`, // quoted schema
  `REPLACE INTO [positions] VALUES(1)`, // bracket delimiter
  "REPLACE INTO `money_lines` VALUES(1)", // backtick delimiter
  `insert   or   replace   into events VALUES(1)`, // multi-space, lowercase
];

/**
 * Parity assertion helper. Pass the scanners that enforce the rule; every probe must
 * be flagged by every scanner or the rule has diverged.
 *
 * Usage in a *.test.ts (model: tools/checks/invariants.test.ts:246):
 *
 *   assertParity(REPLACE_EVASION_CORPUS, [
 *     (sql) => checkMigrationSql([sql]).violations.length > 0,
 *     (sql) => scanSourceForForbiddenReplace([{ path: "p.ts", text: sql }]).length > 0,
 *   ]);
 */
export function findParityGaps(
  corpus: readonly string[],
  scanners: ReadonlyArray<(probe: string) => boolean>,
): string[] {
  const gaps: string[] = [];
  for (const probe of corpus) {
    const results = scanners.map((s) => s(probe));
    if (results.some((r) => r) && !results.every((r) => r)) {
      const blind = results.map((r, i) => (r ? null : i)).filter((i) => i !== null);
      gaps.push(`probe "${probe}" flagged by some scanners but NOT scanner(s) ${blind.join(",")}`);
    }
  }
  return gaps; // empty === parity holds
}
