-- db/tenant/migrations/0002_domain.sql
-- Doc 10 §03 entries 5-8, 10-21: the 16 remaining tenant-plane tables (events + positions
-- shipped in 0001). STRICT; integers only (cents, microdegrees, bps); JSON columns marked -- j.
-- money_lines is an append-only projection (I1): event_id FK + RAISE(ABORT) guards.
CREATE TABLE parties (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('shipper','consignee','carrier','broker','cartage','factor','insurer')),
  names TEXT NOT NULL, addresses TEXT NOT NULL DEFAULT '[]', contacts TEXT NOT NULL DEFAULT '[]',  -- j
  credit_status TEXT, credit_limit_cents INTEGER, credit_terms TEXT,
  division TEXT, bill_terms_default TEXT, external_refs TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE TABLE passports (
  party_id TEXT PRIMARY KEY REFERENCES parties(id),
  identity TEXT NOT NULL DEFAULT '{}', authority TEXT NOT NULL DEFAULT '{}',
  insurance TEXT NOT NULL DEFAULT '{}', scores TEXT NOT NULL DEFAULT '{}', consents TEXT NOT NULL DEFAULT '{}',  -- j (REQ-009)
  updated_at INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE shipments (
  id TEXT PRIMARY KEY, division TEXT NOT NULL DEFAULT 'main',
  refs TEXT NOT NULL DEFAULT '{}',  -- j {pro,bol,master_job,partner}
  shipper_party_id TEXT NOT NULL, consignee_party_id TEXT NOT NULL, bill_to_party_id TEXT NOT NULL,
  bill_terms TEXT, service TEXT, mode TEXT NOT NULL DEFAULT 'LTL' CHECK (mode IN ('LTL','TL','brokered','cartage','dray','transload')),
  commodities TEXT NOT NULL DEFAULT '[]', service_flags TEXT NOT NULL DEFAULT '{}',  -- j
  status_cache TEXT NOT NULL DEFAULT '{}',  -- j: {state, assigned_driver, out_for_delivery} — projection, not truth
  created_ts INTEGER NOT NULL
) STRICT;
CREATE INDEX ix_shipments_division ON shipments(division);
CREATE TABLE legs (
  id TEXT PRIMARY KEY, shipment_id TEXT NOT NULL REFERENCES shipments(id), seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pickup','linehaul','interline','cartage','delivery','dray')),
  executor_party_id TEXT NOT NULL, custody_state TEXT, split_bps INTEGER, geo TEXT NOT NULL DEFAULT '{}'  -- j
) STRICT;
CREATE TABLE documents (
  id TEXT PRIMARY KEY, shipment_id TEXT, party_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('BOL','POD','photo','WI_cert','invoice','ratecon','COI','W9','claim','tsa_receipt')),
  r2_key TEXT NOT NULL, hash TEXT NOT NULL, lifecycle_class TEXT NOT NULL DEFAULT 'default',
  visibility TEXT NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal','counterparty','public'))
) STRICT;
CREATE TABLE money_lines (
  id TEXT PRIMARY KEY,
  shipment_id TEXT,
  event_id TEXT NOT NULL REFERENCES events(id),   -- I1: no line without event, ever
  line_no INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('ar','ap')),
  kind TEXT NOT NULL CHECK (kind IN ('freight','fsc','accessorial','correction_credit','correction_debit','interline_split','cod_collect','settle_fee','credit_purchase')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents != 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  party_id TEXT NOT NULL,
  division TEXT NOT NULL,                          -- REQ-057
  gl_map TEXT NOT NULL,
  corrects_event_id TEXT,
  basis TEXT NOT NULL DEFAULT '{}',                -- j
  created_ts INTEGER NOT NULL,
  UNIQUE (event_id, line_no)
) STRICT;
CREATE UNIQUE INDEX ux_ml_corrects ON money_lines(corrects_event_id, line_no) WHERE corrects_event_id IS NOT NULL;
CREATE INDEX ix_ml_division ON money_lines(division, direction);
CREATE INDEX ix_ml_shipment ON money_lines(shipment_id);
CREATE TRIGGER money_lines_guard_upd BEFORE UPDATE ON money_lines BEGIN SELECT RAISE(ABORT,'I1: projections are append-only'); END;
CREATE TRIGGER money_lines_guard_del BEFORE DELETE ON money_lines BEGIN SELECT RAISE(ABORT,'I1: projections are append-only'); END;
CREATE TABLE invoices (
  id TEXT PRIMARY KEY, party_id TEXT NOT NULL, division TEXT NOT NULL DEFAULT 'main',
  shipment_ids TEXT NOT NULL DEFAULT '[]',  -- j
  total_cents INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'issued',
  issued_event_id TEXT NOT NULL, pdf_doc_id TEXT, terms TEXT, due_ts INTEGER
) STRICT;
CREATE INDEX ix_invoices_division ON invoices(division);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, channel TEXT NOT NULL CHECK (channel IN ('email','sms','voice','portal','note')),
  direction TEXT NOT NULL, party_id TEXT, shipment_id TEXT,
  resolved_conf INTEGER, thread TEXT, body_ref TEXT, drafted_by_agent TEXT, sla_due_ts INTEGER
) STRICT;
CREATE TABLE approvals (
  id TEXT PRIMARY KEY, object_kind TEXT NOT NULL, object_id TEXT NOT NULL, rule TEXT NOT NULL,
  required_role TEXT NOT NULL, requested_event_id TEXT NOT NULL, decided_event_id TEXT, status TEXT NOT NULL DEFAULT 'open'
) STRICT;
CREATE TABLE facilities (
  id TEXT PRIMARY KEY, party_id TEXT, kind TEXT NOT NULL CHECK (kind IN ('terminal','dock','yard')),
  lat_e6 INTEGER, lon_e6 INTEGER, hours TEXT NOT NULL DEFAULT '{}', capacity_slots TEXT NOT NULL DEFAULT '[]', appointment_rules TEXT NOT NULL DEFAULT '{}'  -- j
) STRICT;
CREATE TABLE assets (
  id TEXT PRIMARY KEY, unit_no TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('tractor','trailer','pup')),
  status TEXT NOT NULL DEFAULT 'active', home_facility_id TEXT
) STRICT;
CREATE TABLE rate_config (
  id TEXT PRIMARY KEY, version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('zone_tariff','floors','fsc','accessorials','transit_matrix','class_adapter')),
  payload TEXT NOT NULL, effective_ts INTEGER NOT NULL, approved_by TEXT  -- j payload; I5: quotes pin ids
) STRICT;
CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY, agent TEXT NOT NULL, trigger_event_id TEXT,
  actions TEXT NOT NULL DEFAULT '[]', basis TEXT NOT NULL DEFAULT '[]',  -- j (REQ-005/039)
  confidence INTEGER, cost TEXT NOT NULL DEFAULT '{}', latency_ms INTEGER, outcome TEXT
) STRICT;
CREATE TABLE authority_map (
  module TEXT PRIMARY KEY CHECK (module IN ('rating','invoicing','dispatch','settlement','comms')),
  authority TEXT NOT NULL DEFAULT 'legacy' CHECK (authority IN ('native','legacy')),
  gates_status TEXT NOT NULL DEFAULT '{}', flipped_events TEXT NOT NULL DEFAULT '[]'  -- j (L8)
) STRICT;
CREATE TABLE anomalies (
  id TEXT PRIMARY KEY, rule TEXT NOT NULL, object_kind TEXT, object_id TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('info','warn','critical')), detail TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'open'
) STRICT;
CREATE TABLE integrations (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('edi_partner','eld','quickbooks','email_inbox','tiles','tsa')),
  config TEXT NOT NULL DEFAULT '{}', cert_status TEXT, replay_fixture_ref TEXT
) STRICT;
