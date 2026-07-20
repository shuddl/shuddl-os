-- db/control/migrations/0003_tenant_pool.sql
-- REQ-121/025 (WP-14 Task 2): pre-provisioned tenant-D1 POOL slots for DARK, flag-gated dynamic provisioning.
-- ADDITIVE, DATA-ONLY — it creates ZERO tables (the I8 budget stays 21/22). Bindings are static in a Worker,
-- so self-serve signup cannot MINT a per-tenant D1; instead ops pre-provisions & migrates a pool of tenant D1s
-- out-of-band and provisionTenant() CLAIMS an unclaimed slot at signup (workers/api/src/provision.ts).
--
-- The claimed-registry is THIS existing `tenants` control table — no new table. Each pool slot is a reserved
-- `tenants` row whose id/slug is a sentinel `_pool_0N` and whose policy.pool_binding names the physical D1
-- binding key (TENANT_POOL_0N_DB in wrangler.toml). A CLAIM atomically FLIPS the row to the customer.
--
-- WHY the sentinels can NEVER collide with / be claimed as a customer (mirrors _platform, platform-tenant.ts):
--   1. SHAPE — a customer slug is a DNS-hostname label ([a-z0-9] with internal hyphens, no leading "_"). The
--      `_pool_0N` sentinel begins with "_", so it is outside the customer slug space by construction — no
--      onboarding can mint it, and provisionTenant's DNS-label validation rejects it as INVALID_INPUT.
--   2. PLAN — plan='unclaimed' is a RESERVED plan value distinct from every customer plan (pilot/pro/…); no
--      customer onboarding writes it, and provisionTenant refuses a reserved plan on a customer.
--   3. ALLOWLIST — the customer resolver (workers/api/src/tenants.ts TENANT_BINDINGS) never keys a pool slot;
--      the pool is resolved only server-side (resolveClaimedTenantDb) via a control-plane read whose returned
--      binding key is constrained to the static POOL_BINDINGS allowlist. So the REQ-025 ISO-pub-5 subset-parity
--      (HOST_TENANTS ⊆ TENANT_BINDINGS) is UNTOUCHED — no /pub host maps to a pool tenant until R4.
--
-- INSERT OR IGNORE keeps the migration idempotent (re-running never duplicates a slot or clobbers a claimed one;
-- `tenants` is not append-only-guarded, but OR IGNORE avoids rewriting an already-claimed row).
INSERT OR IGNORE INTO tenants (id, name, slug, plan, policy, divisions, pro_ranges, created_ts)
VALUES
  ('_pool_01', 'SHUDDL Pool Slot 01', '_pool_01', 'unclaimed', '{"pool_binding":"TENANT_POOL_01_DB"}', '[]', '{}', 0),
  ('_pool_02', 'SHUDDL Pool Slot 02', '_pool_02', 'unclaimed', '{"pool_binding":"TENANT_POOL_02_DB"}', '[]', '{}', 0);
