-- db/tenant/migrations/0006_booking.sql
-- WP-08 T5 (REQ-028/052): dock-slot appointment claim on legs (unguarded/mutable table).
--
-- APPEND-ONLY (CLAUDE.md Law 2 / I3): `legs` is a MUTABLE domain read-model, NOT an append-only-guarded
-- table (only events/positions/money_lines are). A nullable `ADD COLUMN` is SQLite metadata-only — old
-- leg rows read the new columns as NULL, no existing row is rewritten — so this is invariants-legal (the
-- same sanctioned form as 0005's events override column; precedent `ux_ml_corrects` for the partial index).
-- Forward-only: 0001-0005 stay untouched — this is a NEW file.
ALTER TABLE legs ADD facility_id TEXT;
ALTER TABLE legs ADD appt_slot_key TEXT;
ALTER TABLE legs ADD appt_service_date TEXT;       -- canonical YYYY-MM-DD in the facility tz = the OCCURRENCE key
ALTER TABLE legs ADD appt_window_start_ts INTEGER; -- epoch ms, read-model/UX only
ALTER TABLE legs ADD appt_window_end_ts INTEGER;
-- The atomic double-book backstop. service_date is IN the key so a RECURRING slot is claimable
-- once PER DATE, not once for all time (slots carry dow?/minute-of-day templates, facilities.ts).
-- The partial WHERE excludes UNCLAIMED skeleton legs (appt_slot_key IS NULL), so two un-appointed
-- pickup legs never collide; only a real slot claim participates in the uniqueness.
CREATE UNIQUE INDEX ux_legs_slot ON legs (facility_id, appt_slot_key, appt_service_date) WHERE appt_slot_key IS NOT NULL;
