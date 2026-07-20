-- db/control/migrations/0002_platform_tenant.sql
-- REQ-123/025 (WP-14 Task 1): provision the reserved PLATFORM revenue tenant's control-plane row.
-- ADDITIVE, DATA-ONLY — it creates ZERO tables (the I8 budget stays 21/22). It reserves the well-known
-- `_platform` tenant the usage/credits billing ledger keys off (packages/contracts/src/platform-tenant.ts).
--
-- Isolation (REQ-025): this row lives in the SEPARATE control plane, and its slug `_platform` is DNS-illegal
-- (a leading underscore can never be a customer slug — see platform-tenant.ts), so it is unreachable from the
-- customer resolver (TENANT_BINDINGS) and from the /pub host allowlist. Its OWN tenant D1 (PLATFORM_TENANT_DB)
-- is a physically separate binding reached only by the internal resolvePlatformTenantDb (server-side).
--
-- plan='platform' — a RESERVED plan value distinct from customer plans (pilot/…); no customer onboarding
-- writes it. INSERT OR IGNORE keeps the migration idempotent (re-running never duplicates or rewrites the row;
-- `tenants` is NOT append-only-guarded, but OR IGNORE avoids clobbering an operator-edited policy).
INSERT OR IGNORE INTO tenants (id, name, slug, plan, policy, divisions, pro_ranges, created_ts)
VALUES ('_platform', 'SHUDDL Platform', '_platform', 'platform', '{}', '[]', '{}', 0);
