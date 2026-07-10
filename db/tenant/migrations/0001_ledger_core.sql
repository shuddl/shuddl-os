-- db/tenant/migrations/0001_ledger_core.sql
-- Doc 10 entry 9: events + positions partition. I3: append-only, guard-trigger enforced.
-- STRICT tables; integer times (epoch ms), geo (microdegrees), confidence (basis points);
-- NO REAL columns (Decision 6). NO IF NOT EXISTS — wrangler tracks applied migrations.
CREATE TABLE events (
  stream_id   TEXT NOT NULL,             -- 's:{shipment_id}' | 'q:{quote_id}' | 't:root'
  seq         INTEGER NOT NULL,          -- dense per stream, assigned by the sequencer DO
  id          TEXT NOT NULL UNIQUE,      -- uuid, client-generated, idempotency anchor
  shipment_id TEXT,
  ts          INTEGER NOT NULL,          -- actor-claimed epoch ms (advisory for offline capture)
  recorded_at INTEGER NOT NULL,          -- server clock at append; Merkle day bucketing (REQ-014)
  kind        TEXT NOT NULL,
  actor_party_id  TEXT NOT NULL,
  actor_user_id   TEXT,
  actor_device_id TEXT,
  party_refs  TEXT NOT NULL DEFAULT '[]',
  payload     TEXT NOT NULL DEFAULT '{}',
  evidence    TEXT NOT NULL DEFAULT '[]',
  prev_hash   TEXT NOT NULL,
  hash        TEXT NOT NULL UNIQUE,      -- sha256 hex of canonical hash-view
  sig         TEXT,                      -- base64url P-256 over clientView; NULL for server actors (I4 tested)
  visibility  TEXT NOT NULL CHECK (visibility IN ('internal','counterparty','public')),
  source      TEXT NOT NULL DEFAULT 'native' CHECK (source IN ('native','legacy','edi','email')),
  confidence  INTEGER NOT NULL DEFAULT 10000,  -- basis points
  device_id   TEXT, device_seq INTEGER, captured_ts INTEGER,  -- offline reserve (REQ-016, WP-05)
  PRIMARY KEY (stream_id, seq),
  CHECK (device_id IS NULL OR device_seq IS NOT NULL),
  CHECK (shipment_id IS NULL OR stream_id = 's:' || shipment_id)
) STRICT;
CREATE INDEX ix_events_kind_ts ON events(kind, ts);
CREATE INDEX ix_events_shipment ON events(shipment_id) WHERE shipment_id IS NOT NULL;
CREATE INDEX ix_events_recorded ON events(recorded_at);
CREATE UNIQUE INDEX ux_events_device ON events(stream_id, device_id, device_seq) WHERE device_id IS NOT NULL;
CREATE TRIGGER events_guard_upd BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'I3: append-only'); END;
CREATE TRIGGER events_guard_del BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'I3: append-only'); END;

CREATE TABLE positions (
  shipment_id TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  ts          INTEGER NOT NULL,          -- capture epoch ms
  recorded_at INTEGER NOT NULL,
  lat_e6      INTEGER NOT NULL,          -- microdegrees (integer-only canonical law)
  lon_e6      INTEGER NOT NULL,
  accuracy_m  INTEGER,
  speed_cms   INTEGER,                   -- cm/s, integer
  hash        TEXT NOT NULL,             -- sha256 of canonical position row (Merkle leaf)
  PRIMARY KEY (shipment_id, device_id, ts)
) STRICT;
CREATE INDEX ix_positions_recorded ON positions(recorded_at);
CREATE TRIGGER positions_guard_upd BEFORE UPDATE ON positions BEGIN SELECT RAISE(ABORT,'I3: append-only'); END;
CREATE TRIGGER positions_guard_del BEFORE DELETE ON positions BEGIN SELECT RAISE(ABORT,'I3: append-only'); END;
