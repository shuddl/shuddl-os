-- db/tenant/migrations/0003_insert_guards.sql
-- I3/I1 completeness: D1 runs PRAGMA recursive_triggers = 0 (not settable from D1), so
-- INSERT OR REPLACE's implicit row-DELETE never fires the BEFORE DELETE guards — REPLACE
-- could silently rewrite ledger history. BEFORE INSERT guards fire while the old row still
-- exists, closing REPLACE (and ON CONFLICT ... DO UPDATE, and a would-be OR IGNORE overwrite)
-- regardless of recursive_triggers. Bodies stay exactly one RAISE(ABORT); the WHEN clause
-- decides *when* to abort. Forward-only: guards for events/positions/money_lines shipped in
-- 0001/0002 remain untouched — this is a NEW migration (never edit a pinned file).
CREATE TRIGGER events_guard_ins BEFORE INSERT ON events WHEN EXISTS (SELECT 1 FROM events WHERE (stream_id = NEW.stream_id AND seq = NEW.seq) OR id = NEW.id) BEGIN SELECT RAISE(ABORT,'I3: append-only'); END;
CREATE TRIGGER money_lines_guard_ins BEFORE INSERT ON money_lines WHEN EXISTS (SELECT 1 FROM money_lines WHERE id = NEW.id OR (event_id = NEW.event_id AND line_no = NEW.line_no)) BEGIN SELECT RAISE(ABORT,'I1: projections are append-only'); END;
-- positions: Decision 14 sanctions idempotent INSERT OR IGNORE re-ingest, so abort only on a
-- genuine overwrite — an existing row at the same PK whose data (hash) differs. A byte-identical
-- re-ingest has hash = NEW.hash, so the guard stays silent and OR IGNORE dedupes it cleanly.
CREATE TRIGGER positions_guard_ins BEFORE INSERT ON positions WHEN EXISTS (SELECT 1 FROM positions WHERE shipment_id = NEW.shipment_id AND device_id = NEW.device_id AND ts = NEW.ts AND hash <> NEW.hash) BEGIN SELECT RAISE(ABORT,'I3: append-only'); END;
