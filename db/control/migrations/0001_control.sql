-- db/control/migrations/0001_control.sql
-- Doc 10 §02: the 4 control-plane tables. Separate database from any tenant D1 (the
-- control plane is never a tenant). STRICT; JSON columns marked -- j.
CREATE TABLE tenants (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, plan TEXT NOT NULL,
  policy TEXT NOT NULL DEFAULT '{}',      -- j: floors/margins/gates/visibility
  divisions TEXT NOT NULL DEFAULT '[]',   -- j
  pro_ranges TEXT NOT NULL DEFAULT '{}',  -- j
  created_ts INTEGER NOT NULL
) STRICT;
CREATE TABLE users (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin','ops','finance','read','driver','portal')),
  auth TEXT NOT NULL DEFAULT '{}',        -- j: {magic, sso}
  device_keys TEXT NOT NULL DEFAULT '[]'  -- j
) STRICT;
CREATE TABLE pairings (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('mcp','api','webhook','edi')),
  scopes TEXT NOT NULL DEFAULT '[]',      -- j
  caps TEXT NOT NULL DEFAULT '{}',        -- j: {spend, velocity, lanes}
  secret_ref TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active'
) STRICT;
CREATE TABLE usage_credits (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, period TEXT NOT NULL,
  metered TEXT NOT NULL DEFAULT '{}',     -- j: per agent-action (Spark/credits meter, REQ-123)
  stripe_refs TEXT NOT NULL DEFAULT '{}'  -- j
) STRICT;
