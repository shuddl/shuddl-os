// Shared setup for the mcp pool-workers suites (NOT a *.test.ts). Applies the control-plane migration to the
// mcp worker's CONTROL_DB and seeds `pairings` / `tenants` rows directly — mirrors the translator suite's
// control-DB seeding (workers/translator/test/inbound.test.ts beforeAll). The control plane is auth-resolution
// only; it is never a tenant data path (REQ-025).
import { applyMigrations } from "@shuddl/ledger/migrate";
import controlSql from "../../../db/control/migrations/0001_control.sql?raw";

// Apply 0001_control.sql once (idempotent — skipped if `pairings` already exists in this isolate).
export async function applyControl(db: D1Database): Promise<void> {
  const has = await db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='pairings'").first();
  if (has === null) await applyMigrations(db, [{ path: "0001_control.sql", sql: controlSql }]);
}

// Seed a tenant row (idempotent). tenant_id is what a minted principal's `tenant` claim must equal.
export async function seedTenant(db: D1Database, id: string, slug: string): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO tenants (id, name, slug, plan, policy, created_ts) VALUES (?,?,?,?,?,?)")
    .bind(id, slug, slug, "pilot", "{}", 0)
    .run();
}

// Seed a `pairings` row (idempotent). kind/status/secret_ref drive the fail-closed resolution paths.
export async function seedPairing(
  db: D1Database,
  opts: { id: string; tenantId: string; kind?: string; secretRef?: string; status?: string; scopes?: string; caps?: string },
): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO pairings (id, tenant_id, kind, scopes, caps, secret_ref, status) VALUES (?,?,?,?,?,?,?)")
    .bind(
      opts.id,
      opts.tenantId,
      opts.kind ?? "mcp",
      opts.scopes ?? "[]",
      opts.caps ?? "{}",
      opts.secretRef ?? "mcp-secret-ref",
      opts.status ?? "active",
    )
    .run();
}
