-- db/tenant/migrations/0007_documents_retention.sql
-- REQ-116 — R2 lifecycle per document kind (7yr POD, shorter others) + the retention SWEEP's bookkeeping.
-- `documents` is a MUTABLE projection table (no append-only guard — a documents row is an R2 REF, not ledger
-- truth), so two forward-only columns are ADDED (I8 intact: NO new table, columns only):
--   created_ts       — the retention CLOCK START (epoch ms). Stamped at write from the recording event's
--                      recorded_at (evidence) / the anchor clock (tsa_receipt). DEFAULT 0 = "ancient" for any
--                      row written before this migration; the sweep only ever deletes NON-POD kinds and every
--                      such row the evidence route writes carries a REAL created_ts, so DEFAULT 0 is never
--                      swept blind (no non-POD doc exists yet at this WP anyway — greenfield).
--   retention_status — the TOMBSTONE marker. 'active' = the R2 bytes exist (the row-iff-bytes invariant);
--                      'expired' = the retention sweep DELETED the R2 bytes and KEPT this row as the audit
--                      record (the doc existed and was retention-deleted). The row is never orphaned (it does
--                      not claim active bytes that are gone) and the bytes are never orphaned (deleted WITH a
--                      row record).
-- CLAUDE.md Law 2 (append-only) is untouched: `documents` is NOT a guarded ledger table, and ADD COLUMN is
-- SQLite metadata-only — an existing row reads the new column as its DEFAULT; no row is rewritten or deleted.
ALTER TABLE documents ADD COLUMN created_ts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN retention_status TEXT NOT NULL DEFAULT 'active' CHECK (retention_status IN ('active','expired'));
