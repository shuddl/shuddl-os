---
name: share-lint-matchers-with-parity-tests
description: Use when two SHUDDL checks enforce one rule over different inputs (migration SQL vs TS source, rate-config A vs B), when writing an identifier/schema/delimiter regex, or when reviewing tools/checks. Trigger on any invariant guarded in more than one place.
---

> **Grounding note (added 2026-08-01, on commit — 16 days after writing):** the examples and
> `path:line` citations in this skill are observations FROZEN as-of its writing (2026-07-15/16).
> Several RED examples have since been FIXED in live code — verify against HEAD before treating any
> cited defect as current. The LAW each skill states is current; the citations are its provenance,
> not its proof. Enrolled in the citation ratchet as a dated record (the 2026-07-15 audit precedent).

# Share Lint Matchers, Prove Parity

## Overview
When the same rule is enforced in two places, hand-tuned copies drift. The copy that got less attention becomes an evasion vector. Extract the target-matching fragment ONCE, share it across every input surface, and add a parity test that runs one probe corpus through every scanner.

## When to Use
- You are writing a regex that names a guarded identifier (`events`, `positions`, `money_lines`), a schema qualifier, or an SQL delimiter.
- A rule is checked in more than one place: migration SQL AND TS source; rate-config side A AND side B; a Zod schema AND a DB constraint.
- You are reviewing anything under `tools/checks/`.
- NOT for a rule enforced in exactly one place with no second surface — there is nothing to keep in parity.

## The RED this closes (real defect)
`tools/checks/invariants.ts:520@FORBIDDEN_REPLACE` — `FORBIDDEN_REPLACE` (the TS-source scanner) is a hand-written copy:

```
/\b(INSERT\s+OR\s+REPLACE\s+INTO|REPLACE\s+INTO)\s+["'`[]?(events|positions|money_lines)\b/gi
```

It requires literal `\s+` before the table and a single optional quote, with NO schema fragment. So both of these EVADE it:
- `INSERT OR REPLACE INTO"events"` — no whitespace, abutting quote.
- `INSERT OR REPLACE INTO main.events` — schema-qualified.

The migration matcher at `tools/checks/invariants.ts:112@replaceFamilyRe` catches BOTH, because it is built from shared fragments (`tools/checks/invariants.ts:96@QOPEN`): `DELIM = (?:\s+|(?=["'\`\[]))` allows a zero-width boundary before a quote, and `SCHEMA = (?:["'\`\[]?\w+["'\`\]]?\s*\.\s*)?` absorbs `main.`. Two divergent copies of one rule = one scanner blind to strings the other blocks.

## The pattern
Build the target matcher once, consume it everywhere:

```ts
// shared fragments already exist at tools/checks/invariants.ts:96@QOPEN — REUSE, don't re-author.
const GUARDED = "(events|positions|money_lines)";
// One builder both surfaces call:
export const replaceTarget = (verbs: string) =>
  new RegExp(`\\b(${verbs})${DELIM}${SCHEMA}${Q}${GUARDED}\\b`, "gi");
```

Then `FORBIDDEN_REPLACE` becomes `replaceTarget("INSERT\\s+OR\\s+REPLACE\\s+INTO|REPLACE\\s+INTO")` — same `DELIM`/`SCHEMA`/`Q` the migration matcher uses. The abutting-quote and schema-qualified forms can no longer split the two scanners.

## Parity test (model on `tools/checks/invariants.test.ts:246`)
One probe corpus, asserted against EVERY scanner enforcing the rule:

```ts
const EVASIONS = [
  `INSERT OR REPLACE INTO"events" VALUES(1)`, // abutting quote
  `INSERT OR REPLACE INTO main.events VALUES(1)`, // schema-qualified
  `REPLACE INTO [positions] VALUES(1)`, // bracket delimiter
  "REPLACE INTO `money_lines` VALUES(1)", // backtick
];
for (const sql of EVASIONS) {
  expect(checkMigrationSql([sql]).violations.length).toBeGreaterThan(0);
  expect(scanSourceForForbiddenReplace([{ path: "p.ts", text: sql }])).not.toHaveLength(0);
}
```

If one scanner passes a probe the other blocks, the test fails — divergence cannot merge.

## Quick Reference
| Delimiter form | Example | Copy-regex blind spot |
|---|---|---|
| Abutting quote | `INTO"events"` | `\s+` requires whitespace |
| Schema-qualified | `main.events`, `"main".events` | no SCHEMA fragment |
| Bracket | `[events]` | `["'\`[]?` may match but tail differs |
| Backtick | `` `events` `` | same |

## Common Mistakes
- **Copying the pattern instead of the fragment.** The `tools/checks/invariants.ts:520@FORBIDDEN_REPLACE` copy dropped `SCHEMA` and downgraded `DELIM` to `\s+`. Extract `replaceTarget()`; both surfaces import it. (Both citations in this file read `:204` until 2026-08-04 — audit §175 — and `:392`/`:29` until 2026-08-05, audit §253, when a 20-line insert at the top of that file shifted them again, and `:470` until 2026-08-14, audit §1465, when a 30-line insert shifted them a THIRD time — three drifts from edits elsewhere in the file, none of which touched the cited symbol, which is the argument for `@symbol` anchoring rather than for keeping the numbers fresh; the shared fragments themselves are at `tools/checks/invariants.ts:102@SCHEMA`.)
- **Testing each scanner with its own tailored strings.** That is how the blind spot survived — the source test at `invariants.test.ts:247-259` only fed whitespace-then-bare forms, never an evasion shape. Feed BOTH scanners the SAME corpus.
- **Forgetting the schema-qualified and abutting-delimiter forms.** These are the classic SQLite bypasses; put one of each in the corpus.
- **Adding a new check that re-authors the rule.** Review rule: any new check on a guarded identifier must call the shared builder, never write a fresh regex.

See `reference/shared-target-matcher.ts` for the extractable builder + full probe corpus.
