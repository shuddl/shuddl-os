import { globSync, readFileSync } from "node:fs";
import { insertIntoRe } from "./invariants.js";
import { EXPECTED_EMPTY_GLOBS, SOURCE_SCAN_GLOBS, isTestPath, stripComments } from "./source-corpus.js";

// §493 — re-exported: this module owned `stripComments` and its tests import it from here.
export { stripComments };

// REQ-030 / I3 — THE APPEND CHOKEPOINT (audit §56).
//
// Every gate in this system lives in one place: the sequencer Durable Object. The POD gate (I2), the booking
// gates, the interline floors, the credit-authorization gate, the visibility stamp, and the seq/prev_hash/hash
// chain are all applied there, on the way to a single `INSERT INTO events`. `CLAUDE.md` rule 3 states the
// consequence as law: *any flow reachable by API must enforce the same gate*.
//
// WHAT MAKES THAT TRUE IS AN ABSENCE, AND NOTHING WAS GUARDING IT. The property held only because no other
// module happened to contain an event INSERT. The database cannot help here: the append-only triggers
// (0003/0008) fire on COLLISIONS — duplicate id, (stream_id,seq), hash, or device slot — and a direct insert
// with a fresh id collides with nothing. It would be accepted, and it would skip every gate above, writing
// whatever `prev_hash` it liked. A second writer would not fail a test, a type check, or a migration lint.
//
// So this is the lint that makes the chokepoint a rule rather than a coincidence. REQ-024 (no LLM in the
// ledger) and REQ-004 (rater purity) already have exactly this shape; the append path — where every gate
// actually lives — had none.
//
// SCOPE + LIMITATION. Static, regex over source text, same class of guarantee as `rater-purity.ts`: it sees a
// literal `INSERT ... INTO events`. It does not resolve a table name assembled at runtime, and it is not a
// substitute for review of anything that builds SQL dynamically. It closes the realistic regression — a new
// route or agent that writes the ledger directly because it is convenient — not a determined author.

/** The ONLY modules permitted to write the events table, each for a stated reason. */
const ALLOWED = new Map<string, string>([
  [
    "workers/api/src/do/sequencer.ts",
    "THE chokepoint — every gate, the visibility stamp, and the hash chain are applied here before the insert.",
  ],
  [
    "tools/seed/load.ts",
    "the seed loader: a developer tool that populates a local/dev tenant. Not reachable by API, and it writes rows the generator already produced through the ledger's own builders.",
  ],
]);

// Audit §120: the .tsx half was missing. A React component is an ordinary place to put a helper, and a
// direct events INSERT bypasses the sequencer DO and with it EVERY gate — the file extension must not decide
// whether that is caught. Probed: before this line existed, a violation in ANY .tsx file was invisible.
// §493 — the glob set is SHARED with invariants.ts (see source-corpus.ts); two hand-maintained copies
// drifted and opened a hole in tools/.
const SCAN_GLOBS = SOURCE_SCAN_GLOBS;

// The globs that match NOTHING today and are kept deliberately (audit §466). Both are FORWARD-SAFE: workers
// and tools are server-side/tooling trees with no TSX, and the patterns exist so a .tsx appearing there is
// scanned from its first commit rather than from whenever someone notices. Listing them is what lets the
// per-glob non-vacuity rule below be strict about every OTHER pattern — the §455 distinction between "empty
// because nothing produces it yet" and "empty because the pattern broke".

// `INSERT [OR ...] INTO [schema.]["]events["]` — the SHARED matcher from invariants.ts, not a copy.
//
// This was a hand-written regex until audit §71, and it required `INTO\s+` — so `INSERT INTO"events"`
// (abutting quote, no whitespace) walked straight past the gate. That is the precise blind spot the
// `share-lint-matchers-with-parity-tests` skill was written about, already covered by the legs evasion
// corpus, and I reproduced it in §56 while building this check. Consuming the shared builder means this
// scanner inherits every delimiter and schema form the migration scanner already handles, and any future
// form is fixed in ONE place.
const EVENT_INSERT = insertIntoRe("events");

export interface ChokepointViolation {
  file: string;
  line: number;
  detail: string;
}


export function findChokepointViolations(cwd: string = process.cwd()): ChokepointViolation[] {
  const violations: ChokepointViolation[] = [];
  const seen = new Set<string>();
  const perGlob = new Map<string, number>();
  for (const glob of SCAN_GLOBS) {
    perGlob.set(glob, 0);
    for (const abs of globSync(glob, { cwd })) {
      perGlob.set(glob, (perGlob.get(glob) ?? 0) + 1);
      const rel = abs.replace(/\\/g, "/");
      if (seen.has(rel)) continue;
      seen.add(rel);
      if (isTestPath(rel)) continue; // §493 — shared with the REPLACE scanner (source-corpus.ts)
      if (ALLOWED.has(rel)) continue;
      const lines = stripComments(readFileSync(`${cwd}/${rel}`, "utf8")).split("\n");
      lines.forEach((text, i) => {
        EVENT_INSERT.lastIndex = 0;
        if (EVENT_INSERT.test(text)) {
          violations.push({
            file: rel,
            line: i + 1,
            detail: "writes the events table directly, bypassing the sequencer DO — and with it EVERY gate (POD/I2, booking, interline floors, credit) plus the visibility stamp and the prev_hash chain",
          });
        }
      });
    }
  }

  // NON-VACUITY, PER GLOB (audit §466). A violation scan that scans NOTHING reports clean: pointing the
  // globs at a missing directory left this gate at exit 0 while it enforced REQ-024/030 over zero files.
  //
  // THE FIRST FIX WAS AN AGGREGATE COUNT, and it did not work — §465's own shape-4 error, committed while
  // closing shape-4 errors. `SCAN_GLOBS` has EIGHT entries; breaking the six product ones still left
  // `tools/**/*.ts` matching 72 files, over a floor of 50, and the gate stayed green with the entire
  // product tree unscanned. A total says nothing about which member contributed it.
  //
  // Per-glob is shape 2: every entry must match something, so ONE broken pattern is loud regardless of what
  // the others find.
  for (const [glob, n] of perGlob) {
    if (n === 0 && !EXPECTED_EMPTY_GLOBS.has(glob)) {
      violations.push({
        file: glob,
        line: 0,
        detail: `this scan glob matched ZERO files — a violation scan that scans nothing reports clean, so a renamed directory or a typo'd pattern silently disarms the append chokepoint (audit §466).`,
      });
    }
  }

  return violations;
}

/** The allowlist, exported so the test can assert it stays deliberate rather than growing quietly. */
export const ALLOWED_EVENT_WRITERS = ALLOWED;

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = findChokepointViolations();
  if (violations.length > 0) {
    console.error(`append-chokepoint — ${violations.length} module(s) write events outside the sequencer DO:\n`);
    for (const v of violations) console.error(`  ${v.file}:${v.line} — ${v.detail}`);
    console.error(
      `\nREQ-030: gates are server-side and every append must traverse the chokepoint. Route the write through` +
        ` the sequencer DO. If a new writer is genuinely justified, it needs an owner-signed register note AND` +
        ` an entry in ALLOWED (tools/checks/append-chokepoint.ts) explaining why it cannot go through the DO.`,
    );
    process.exit(1);
  }
  console.log(
    `append-chokepoint OK — the events table is written by ${ALLOWED.size} allowlisted module(s) and nothing else (REQ-030/I3)`,
  );
}
