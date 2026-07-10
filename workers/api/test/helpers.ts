import { sign } from "hono/jwt";
import { applyMigrations } from "@shuddl/ledger/migrate";
import type { Env } from "../src/index.js";
import controlSql from "../../../db/control/migrations/0001_control.sql?raw";
import ledgerCore from "../../../db/tenant/migrations/0001_ledger_core.sql?raw";
import domain from "../../../db/tenant/migrations/0002_domain.sql?raw";
import insertGuards from "../../../db/tenant/migrations/0003_insert_guards.sql?raw";
import partyRefsGuard from "../../../db/tenant/migrations/0004_party_refs_guard.sql?raw";

export async function token(claims: Record<string, unknown>, secret = "test-secret-do-not-use-in-prod"): Promise<string> {
  return sign({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims }, secret);
}

// ---- shared ledger fixture (Task 13+: the sequencer, routes, and anchor suites all consume this) ----

export const TENANT_SLUG = "tenant-a";
export const TEST_DEVICE_ID = "device-1";

// A FIXED P-256 test keypair. Deterministic so ANY test file can sign an event and have the sequencer
// verify it against the ONE registered public JWK — pool-workers gives each file a fresh module scope,
// so a per-file generated key wouldn't match the shared seed. Test-only; never a real credential.
export const TEST_DEVICE_PUBLIC_JWK: JsonWebKey = {
  kty: "EC",
  crv: "P-256",
  x: "4Fiu7RC9gvD7wbSkV3sumOCBU1nnrBZWXll4jomr5cE",
  y: "1A4Zv77d-4yA-I4X-o3PbE6YO5ryjzRGEll1cvmF0xI",
};
const TEST_DEVICE_PRIVATE_JWK: JsonWebKey = { ...TEST_DEVICE_PUBLIC_JWK, d: "AVHaqhOOSQmgexOvGC6DN4bBPQ_6kJHVVo5hcT4_a34" };

export function testDeviceSigningKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", TEST_DEVICE_PRIVATE_JWK, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

const TENANT_MIGRATIONS = [
  { path: "0001_ledger_core.sql", sql: ledgerCore },
  { path: "0002_domain.sql", sql: domain },
  { path: "0003_insert_guards.sql", sql: insertGuards },
  { path: "0004_party_refs_guard.sql", sql: partyRefsGuard },
];

// Passport accrual (pod/exception/osd/custody) has an FK to parties(id): the party MUST exist before any
// event that accrues, or the batch aborts. Seed the standard cast once.
const PARTIES: [string, string][] = [
  ["party-shipper", "shipper"],
  ["party-carrier", "carrier"],
  ["party-consignee", "consignee"],
  ["party-bill-to", "broker"],
  ["party-interline", "carrier"],
];

async function tableExists(db: D1Database, name: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name = ?").bind(name).first();
  return row !== null;
}

let schemaReady: Promise<void> | null = null;

/**
 * Idempotent shared setup for every ledger-touching api test file. isolatedStorage is OFF (a SQLite-backed
 * Durable Object can't be snapshotted by pool-workers — see workers/api/vitest.config.ts), so all files
 * share ONE D1. A file that blindly re-ran the pinned, forward-only migrations would hit "table already
 * exists" (proven). This applies each migration ONLY when its anchor table is absent (checked via
 * sqlite_master — the migration files are never edited) and seeds the control plane + parties with INSERT
 * OR IGNORE. Paired with `singleWorker: true`, files run sequentially in one isolate, so the module memo
 * makes this run exactly once; the sqlite_master + OR IGNORE guards keep it correct even without the memo.
 *
 * Data-isolation contract for the NEXT test author: this seeds ONLY the shared tenant (`tenant-a`), its
 * driver `u-driver` + device `device-1`, and the parties above. Scope every test to its OWN (tenant|
 * streamId) and its own shipment/party ids, and NEVER assume an empty table — other files' rows persist.
 */
export function ensureSchema(env: Env): Promise<void> {
  schemaReady ??= applyOnce(env);
  return schemaReady;
}

async function applyOnce(env: Env): Promise<void> {
  if (!(await tableExists(env.CONTROL_DB, "tenants"))) {
    await applyMigrations(env.CONTROL_DB, [{ path: "0001_control.sql", sql: controlSql }]);
  }
  if (!(await tableExists(env.TENANT_A_DB, "events"))) {
    await applyMigrations(env.TENANT_A_DB, TENANT_MIGRATIONS);
  }
  await env.CONTROL_DB.prepare("INSERT OR IGNORE INTO tenants (id, name, slug, plan, policy, created_ts) VALUES (?,?,?,?,?,?)")
    .bind("t-a", "Tenant A", TENANT_SLUG, "pilot", "{}", 0)
    .run();
  await env.CONTROL_DB.prepare("INSERT OR IGNORE INTO users (id, tenant_id, email, role, auth, device_keys) VALUES (?,?,?,?,?,?)")
    .bind("u-driver", "t-a", "driver@tenant-a.test", "driver", "{}", JSON.stringify([{ device_id: TEST_DEVICE_ID, public_jwk: TEST_DEVICE_PUBLIC_JWK }]))
    .run();
  for (const [id, kind] of PARTIES) {
    await env.TENANT_A_DB.prepare("INSERT OR IGNORE INTO parties (id, kind, names) VALUES (?,?,?)").bind(id, kind, "{}").run();
  }
}
