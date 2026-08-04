import { globSync, readFileSync } from "node:fs";
import { insertIntoRe } from "./invariants.js";

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
const SCAN_GLOBS = [
  "workers/*/src/**/*.ts",
  "workers/*/src/**/*.tsx",
  "packages/*/src/**/*.ts",
  "packages/*/src/**/*.tsx",
  "apps/*/src/**/*.ts",
  "apps/*/src/**/*.tsx",
  "tools/**/*.ts",
  "tools/**/*.tsx",
];

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

// Blank out comment BODIES, preserving newlines so reported line numbers stay true. Without this the check
// flags its own header and `invariants.ts`'s explanation of the same rule — a lint that cannot describe
// itself is a lint nobody can document. Quote/template state is tracked so a `//` inside a string literal
// (a URL, a SQL fragment) is not mistaken for a comment.
export function stripComments(src: string): string {
  let out = "";
  let state: "code" | "line" | "block" | "'" | '"' | "`" = "code";
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    const next = src[i + 1];
    if (state === "code") {
      if (c === "/" && next === "/") { state = "line"; out += "  "; i++; continue; }
      if (c === "/" && next === "*") { state = "block"; out += "  "; i++; continue; }
      if (c === "'" || c === '"' || c === "`") state = c;
      out += c;
      continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; out += c; } else out += " ";
      continue;
    }
    if (state === "block") {
      if (c === "*" && next === "/") { state = "code"; out += "  "; i++; } else out += c === "\n" ? c : " ";
      continue;
    }
    // inside a string/template: a backslash escapes the next character, so a quote cannot close early
    if (c === "\\") { out += c + (next ?? ""); i++; continue; }
    if (c === state) state = "code";
    out += c;
  }
  return out;
}

export function findChokepointViolations(cwd: string = process.cwd()): ChokepointViolation[] {
  const violations: ChokepointViolation[] = [];
  const seen = new Set<string>();
  for (const glob of SCAN_GLOBS) {
    for (const abs of globSync(glob, { cwd })) {
      const rel = abs.replace(/\\/g, "/");
      if (seen.has(rel)) continue;
      seen.add(rel);
      if (rel.includes("/test/") || rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) continue;
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
