-- db/tenant/migrations/0008_append_only_unique_guards.sql
-- I3/I1 COMPLETENESS (REQ-002, REQ-011): D1 runs PRAGMA recursive_triggers = 0, so an INSERT OR REPLACE
-- that collides on a UNIQUE key the BEFORE INSERT guard's WHEN-clause does NOT enumerate slips PAST the
-- guard (its WHEN is false), and REPLACE's implicit row-DELETE — which never fires the BEFORE DELETE guard
-- when recursive_triggers=0 — SILENTLY erases the chained victim row (a history rewrite / chain break).
-- 0003's events_guard_ins enumerated ONLY (stream_id, seq) and id; it OMITTED the `hash` UNIQUE column
-- (the chained event hash) and the ux_events_device UNIQUE index. money_lines_guard_ins omitted the
-- ux_ml_corrects UNIQUE index. These NEW BEFORE INSERT guards enumerate every REMAINING uniqueness surface
-- so no REPLACE can delete a row through an un-guarded key. Bodies stay EXACTLY one RAISE(ABORT); the WHEN
-- clause decides when to abort. Forward-only: 0001-0007 stay untouched — this is a NEW file (never edit a
-- pinned migration). No new table (I8 intact: 21/22).
--
-- events: `hash` is UNIQUE (events row 20) and ux_events_device is UNIQUE(stream_id, device_id, device_seq)
-- WHERE device_id IS NOT NULL (0001). The device disjunct is itself gated on NEW.device_id IS NOT NULL so it
-- mirrors the PARTIAL index exactly — a NULL-device row cannot collide there (and never trips this guard).
CREATE TRIGGER events_guard_ins_unique BEFORE INSERT ON events WHEN EXISTS (SELECT 1 FROM events WHERE hash = NEW.hash OR (NEW.device_id IS NOT NULL AND stream_id = NEW.stream_id AND device_id = NEW.device_id AND device_seq = NEW.device_seq)) BEGIN SELECT RAISE(ABORT,'I3: append-only'); END;
-- money_lines: ux_ml_corrects is UNIQUE(corrects_event_id, line_no) WHERE corrects_event_id IS NOT NULL
-- (0002) — a correcting money-line may claim a (corrected event, line) pair once; a REPLACE colliding there
-- would erase the prior correction. Gated on NEW.corrects_event_id IS NOT NULL to mirror the partial index.
CREATE TRIGGER money_lines_guard_ins_corrects BEFORE INSERT ON money_lines WHEN EXISTS (SELECT 1 FROM money_lines WHERE NEW.corrects_event_id IS NOT NULL AND corrects_event_id = NEW.corrects_event_id AND line_no = NEW.line_no) BEGIN SELECT RAISE(ABORT,'I1: projections are append-only'); END;
