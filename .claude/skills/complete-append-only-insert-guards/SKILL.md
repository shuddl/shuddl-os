---
name: complete-append-only-insert-guards
description: Use when writing or reviewing a D1 BEFORE INSERT append-only guard (events, positions, money_lines, or any new ledger/projection table), when a WHEN-clause enumerates conflict keys, or when adding a UNIQUE column/index to a guarded table. Also when a source or migration lint claims to ban INSERT OR REPLACE.
---

> **Grounding note (added 2026-08-01, on commit — 16 days after writing):** the examples and
> `path:line` citations in this skill are observations FROZEN as-of its writing (2026-07-15/16).
> Several RED examples have since been FIXED in live code — verify against HEAD before treating any
> cited defect as current. The LAW each skill states is current; the citations are its provenance,
> not its proof. Enrolled in the citation ratchet as a dated record (the 2026-07-15 audit precedent).

# Complete Append-Only INSERT Guards

## Overview
On D1, `INSERT OR REPLACE` deletes the pre-existing row on **every** UNIQUE key it conflicts with, not just the PK — and because D1 runs `PRAGMA recursive_triggers = 0` (not settable from D1), the implicit DELETE **never fires the BEFORE DELETE guard**. The `BEFORE INSERT` guard is the only backstop, and it protects a table only for the conflict keys its `WHEN` clause enumerates. A guard that omits one unique key is a silent hole, not partial protection.

## When to Use
- Writing/reviewing a `*_guard_ins` trigger `WHEN EXISTS (...)` clause.
- Adding a `UNIQUE` column or `CREATE UNIQUE INDEX` to any guarded table (events/positions/money_lines) — the WHEN clause must grow with it.
- Standing up a new append-only ledger or projection table.
- Touching `FORBIDDEN_REPLACE` or the migration mutation matcher in `tools/checks/invariants.ts`.
- NOT for: read paths, non-guarded scratch tables, or DO-level sequencing logic (that is `cloudflare:durable-objects`).

REQUIRED BACKGROUND: `cloudflare:durable-objects` (the ledger mutex is load-bearing across D1 awaits); MEMORY `d1-append-only-triggers`.

## The mechanical rule
> The `WHEN EXISTS` clause must `OR` together the PRIMARY KEY **and every UNIQUE column** **and every UNIQUE INDEX** the table declares. Enumerate the table's constraints from its `CREATE TABLE`; miss one and REPLACE silently rewrites history through it.

### Grounded example — the real gap in `events_guard_ins`
`db/tenant/migrations/0001_ledger_core.sql` declares on `events`: `PRIMARY KEY (stream_id, seq)` (:26), `id TEXT NOT NULL UNIQUE` (:8), `hash TEXT NOT NULL UNIQUE` (:20), and `CREATE UNIQUE INDEX ux_events_device ON events(stream_id, device_id, device_seq) WHERE device_id IS NOT NULL` (:33) — **four** conflict surfaces.

But the guard at `db/tenant/migrations/0003_insert_guards.sql:9` tests only two:
```sql
CREATE TRIGGER events_guard_ins BEFORE INSERT ON events WHEN EXISTS (
  SELECT 1 FROM events WHERE (stream_id = NEW.stream_id AND seq = NEW.seq) OR id = NEW.id
) BEGIN SELECT RAISE(ABORT,'I3: append-only'); END;
```
An `INSERT OR REPLACE` whose `hash` (or whose `(stream_id, device_id, device_seq)`) collides with an existing chained event does **not** hit `(stream_id,seq)` or `id`, so the WHEN is false, the guard stays silent, and SQLite deletes the conflicting event to make room — a Merkle-chained row vanishes (I3/I1 broken). Per sqlite.org/lang_conflict: *"the REPLACE algorithm deletes pre-existing rows that are causing the [UNIQUE or PRIMARY KEY] constraint violation prior to inserting."*

**Fix** — enumerate all four (correction is a NEW forward-only migration, never edit 0003):
```sql
-- 0006_events_guard_ins_complete.sql
CREATE TRIGGER events_guard_ins_v2 BEFORE INSERT ON events WHEN EXISTS (
  SELECT 1 FROM events WHERE (stream_id = NEW.stream_id AND seq = NEW.seq)
    OR id = NEW.id
    OR hash = NEW.hash
    OR (NEW.device_id IS NOT NULL AND stream_id = NEW.stream_id
        AND device_id = NEW.device_id AND device_seq = NEW.device_seq)
) BEGIN SELECT RAISE(ABORT,'I3: append-only'); END;
```
(The `NEW.device_id IS NOT NULL` mirror of the partial index avoids aborting rows the index does not cover.)

### The positions carve-out — deliberate, do NOT copy blindly
`positions_guard_ins` (0003:14) aborts only on **same-PK, differing-hash** (`shipment_id=… AND device_id=… AND ts=… AND hash <> NEW.hash`). That is intentional: Decision 14 sanctions idempotent `INSERT OR IGNORE` re-ingest, so a byte-identical replay (`hash = NEW.hash`) must stay silent and dedupe. This narrower shape is correct **only** because positions has no secondary UNIQUE key beyond its PK. Never transplant the `hash <>` pattern onto a table (like events) that has extra unique keys — you would re-open every one of them.

## Source-lint parity
`FORBIDDEN_REPLACE` (`tools/checks/invariants.ts:455@FORBIDDEN_REPLACE`) is the app-source backstop banning `INSERT OR REPLACE` against guarded tables. It uses a hand-rolled regex `...INTO)\s+["'`[]?(events|...)` that requires whitespace before the (single, non-schema) delimiter. The migration matcher on the same file (:63-66) uses shared fragments `DELIM` (allows a name **abutting** an opening quote/bracket) + `SCHEMA` (allows `main.` / `"main".`) + `Q`/`QCLOSE`. So the migration scanner catches `INTO main.events`, `INTO"events"`, `INTO[events]`; the source scanner **misses all three** — asymmetric, a real hole. Rebuild `FORBIDDEN_REPLACE` from the same `SCHEMA`/`Q`/`DELIM` fragments and add a parity test asserting both scanners flag the identical corpus of delimiter/schema variants.

## Quick reference
| Conflict surface on the table | Must appear in WHEN? |
|---|---|
| PRIMARY KEY | Always |
| Each `UNIQUE` column | Always |
| Each `CREATE UNIQUE INDEX` (incl. partial) | Always; mirror the `WHERE` predicate |
| Non-unique index | No (REPLACE never deletes through it) |
| Idempotent re-ingest key (positions only) | Narrow to same-PK `hash <> NEW.hash` |

## Common mistakes
- **WHEN clause tests only PK + `id`, misses `hash`/device index** — the live `events_guard_ins` gap. Enumerate every unique key.
- **Editing 0003 to fix it** — migrations are forward-only (lock in `db/migrations.lock.json`, anchored to git HEAD, `checkLock`). Ship a new migration.
- **Copying the positions `hash <>` shape to events** — re-opens every secondary UNIQUE key.
- **Adding a `UNIQUE INDEX` without extending the guard** — the new key becomes an un-backstopped REPLACE target the moment it merges.
- **Trusting `FORBIDDEN_REPLACE` alone** — it currently misses `main.events` / `"events"`. Two scanners, one regex builder, one parity test.
- **Assuming `recursive_triggers` can be turned on** — it cannot from D1; never rely on the BEFORE DELETE guard to catch a REPLACE.

## Checklist for any new/changed guarded table or unique key
1. List every conflict surface from `CREATE TABLE` + `CREATE UNIQUE INDEX` (PK, UNIQUE cols, unique indexes with their partial `WHERE`).
2. Confirm the `*_guard_ins` WHEN clause `OR`s all of them (mirror partial-index predicates).
3. Verify `*_guard_upd` and `*_guard_del` exist too (invariants.ts requires all three).
4. Add the table to `GUARDED_TABLES` and the `FORBIDDEN_REPLACE` alternation.
5. Add a test that an `INSERT OR REPLACE` conflicting on **each** unique key RAISE(ABORT)s.
6. Ship as a new forward-only migration; run `pnpm db:lock` + full invariants check.
