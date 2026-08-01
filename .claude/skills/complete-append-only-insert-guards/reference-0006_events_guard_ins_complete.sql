-- reference-0006_events_guard_ins_complete.sql
-- ANNOTATED REFERENCE for skill "complete-append-only-insert-guards". Not a merge-ready file:
-- author a real, sequentially-numbered migration in db/tenant/migrations/ and `pnpm db:lock`.
--
-- WHY THIS EXISTS -------------------------------------------------------------------------------
-- D1 runs `PRAGMA recursive_triggers = 0` (not settable from D1). So the implicit row-DELETE that
-- `INSERT OR REPLACE` performs to clear a conflict NEVER fires events_guard_del (the BEFORE DELETE
-- guard from 0001). The BEFORE INSERT guard is the ONLY backstop — and it fires only for the
-- conflict keys its WHEN clause names.
--
-- Per sqlite.org/lang_conflict.html: "When a UNIQUE or PRIMARY KEY constraint violation occurs, the
-- REPLACE algorithm deletes pre-existing rows that are causing the constraint violation prior to
-- inserting or updating the current row." => REPLACE deletes through EVERY unique key, not just PK.
--
-- events (from 0001_ledger_core.sql) has FOUR conflict surfaces:
--   1. PRIMARY KEY (stream_id, seq)                                            0001:26
--   2. id   TEXT NOT NULL UNIQUE                                               0001:8
--   3. hash TEXT NOT NULL UNIQUE                                               0001:20
--   4. CREATE UNIQUE INDEX ux_events_device
--        ON events(stream_id, device_id, device_seq) WHERE device_id IS NOT NULL   0001:33
--
-- The shipped events_guard_ins (0003_insert_guards.sql:9) enumerates only #1 and #2:
--     WHEN EXISTS (SELECT 1 FROM events WHERE (stream_id=NEW.stream_id AND seq=NEW.seq) OR id=NEW.id)
-- An INSERT OR REPLACE that collides on hash (#3) or the device index (#4) does not satisfy that
-- WHEN, the guard stays silent, and SQLite deletes the conflicting CHAINED event => I3/I1 broken,
-- a Merkle-linked row silently disappears.
--
-- Migrations are FORWARD-ONLY (db/migrations.lock.json, anchored to git HEAD by checkLock in
-- tools/checks/invariants.ts). NEVER edit 0003. Ship a new migration that enumerates all four.
-- Note: a guard trigger cannot be DROPped (invariants.ts:108-114 forbids DROP TRIGGER on a guard),
-- so this ADDS a complete second BEFORE INSERT guard alongside the existing one; both fire, the
-- stricter (more complete) WHEN wins. Bodies stay exactly one RAISE(ABORT).

CREATE TRIGGER events_guard_ins_complete
BEFORE INSERT ON events
WHEN EXISTS (
  SELECT 1 FROM events WHERE
       (stream_id = NEW.stream_id AND seq = NEW.seq)          -- #1 PRIMARY KEY
    OR id   = NEW.id                                          -- #2 UNIQUE(id)
    OR hash = NEW.hash                                        -- #3 UNIQUE(hash)  <-- was missing
    OR (                                                      -- #4 ux_events_device (partial)
         NEW.device_id IS NOT NULL                            -- mirror the index's WHERE predicate:
         AND stream_id = NEW.stream_id                        -- rows with NULL device_id are not in
         AND device_id = NEW.device_id                        -- the unique index, so REPLACE cannot
         AND device_seq = NEW.device_seq                      -- conflict there — do not abort them.
       )
)
BEGIN
  SELECT RAISE(ABORT, 'I3: append-only');
END;

-- ------------------------------------------------------------------------------------------------
-- WHY NOT the positions shape (`... AND hash <> NEW.hash`)?
-- positions_guard_ins (0003:14) deliberately aborts only on same-PK, DIFFERING-hash, because
-- Decision 14 sanctions idempotent INSERT OR IGNORE re-ingest (a byte-identical replay has
-- hash = NEW.hash and must dedupe silently). That narrower shape is safe ONLY because positions
-- has no secondary UNIQUE key beyond its PK (shipment_id, device_id, ts). events has three more
-- unique surfaces, so the `hash <>` relaxation would re-open all of them. Do not copy it here.
--
-- TEST OBLIGATION: one RAISE(ABORT) assertion per unique key — force an INSERT OR REPLACE that
-- conflicts on PK, then id, then hash, then (stream_id, device_id, device_seq); each must ABORT.
