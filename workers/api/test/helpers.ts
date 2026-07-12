import { SELF, env as testEnv } from "cloudflare:test";
import { sign } from "hono/jwt";
import { applyMigrations } from "@shuddl/ledger/migrate";
import { ZoneTariff, FloorsConfig, FscConfig, AccessorialSchedule } from "@shuddl/contracts";
import type { Env } from "../src/index.js";
import controlSql from "../../../db/control/migrations/0001_control.sql?raw";
import ledgerCore from "../../../db/tenant/migrations/0001_ledger_core.sql?raw";
import domain from "../../../db/tenant/migrations/0002_domain.sql?raw";
import insertGuards from "../../../db/tenant/migrations/0003_insert_guards.sql?raw";
import partyRefsGuard from "../../../db/tenant/migrations/0004_party_refs_guard.sql?raw";
import eventsOverride from "../../../db/tenant/migrations/0005_events_override.sql?raw";

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
  { path: "0005_events_override.sql", sql: eventsOverride },
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

// ---- rate_config seeding (WP-04 Task 10 / REQ-025 tenant isolation) --------------------------------
// SEED-1-shaped SYNTHETIC rating configs for the /rate suite. Each field is the INPUT type of its Task-1
// @shuddl/contracts schema, so a rename/added field fails at COMPILE time here — not just at the loader's
// runtime .parse(). No tenant data (REQ-167): plain synthetic tariffs. The two configs carry DISTINCT
// payload ids so a priced quote's pinned versions reveal WHICH tenant's config priced it (the REQ-025
// isolation assertion checks the pinned id, not hand-computed cents).
type RatingConfigSeed = {
  zone_tariff: (typeof ZoneTariff)["_input"];
  floors: (typeof FloorsConfig)["_input"];
  fsc: (typeof FscConfig)["_input"];
  accessorials: (typeof AccessorialSchedule)["_input"];
};

// dest "800xx" → Z5 → rg-far; dest "970xx" → Z1 → rg-near. contribution_bps < full_cost_bps < target_or_bps.
export const TEST_RATE_CONFIG: RatingConfigSeed = {
  zone_tariff: {
    kind: "zone_tariff",
    id: "zt-test",
    version: "v1",
    zip_to_zone: { "800": "Z5", "970": "Z1" },
    rate_groups: [
      { id: "rg-near", zones: ["Z1"], breaks: [{ min_lb: 0, cwt_cents: 3800 }, { min_lb: 500, cwt_cents: 3200 }], min_charge_cents: 9500 },
      { id: "rg-far", zones: ["Z5"], breaks: [{ min_lb: 0, cwt_cents: 5200 }, { min_lb: 500, cwt_cents: 4500 }], min_charge_cents: 11500 },
    ],
  },
  floors: { kind: "floors", id: "fl-test", version: "v1", target_or_bps: 9800, full_cost_bps: 9200, contribution_bps: 8500 },
  fsc: { kind: "fsc", id: "fsc-test", version: "v1", pct_bps: 2400 },
  accessorials: { kind: "accessorials", id: "acc-test", version: "v1", items: { liftgate: 3500 } },
};

// A DISTINCT config for tenant-b (different ids AND numbers) — the isolation test proves tenant-a never
// prices against these.
export const TENANT_B_RATE_CONFIG: RatingConfigSeed = {
  zone_tariff: {
    kind: "zone_tariff",
    id: "zt-testb",
    version: "v1",
    zip_to_zone: { "800": "Z5", "970": "Z1" },
    rate_groups: [
      { id: "rg-near-b", zones: ["Z1"], breaks: [{ min_lb: 0, cwt_cents: 9000 }], min_charge_cents: 20000 },
      { id: "rg-far-b", zones: ["Z5"], breaks: [{ min_lb: 0, cwt_cents: 12000 }], min_charge_cents: 30000 },
    ],
  },
  floors: { kind: "floors", id: "fl-testb", version: "v1", target_or_bps: 9700, full_cost_bps: 9100, contribution_bps: 8400 },
  fsc: { kind: "fsc", id: "fsc-testb", version: "v1", pct_bps: 3000 },
  accessorials: { kind: "accessorials", id: "acc-testb", version: "v1", items: { liftgate: 5000 } },
};

// A config whose min charge is absurdly high ($250k) so a 1-lb shipment prices at ~$310k — the
// $222,084/35-lb-class price that MUST trip the REQ-040 anomaly net (over the $2,000/lb cap).
export const ANOMALY_RATE_CONFIG: RatingConfigSeed = {
  zone_tariff: {
    kind: "zone_tariff",
    id: "zt-anom",
    version: "v1",
    zip_to_zone: { "800": "Z5" },
    rate_groups: [{ id: "rg-anom", zones: ["Z5"], breaks: [{ min_lb: 0, cwt_cents: 5200 }], min_charge_cents: 25_000_000 }],
  },
  floors: { kind: "floors", id: "fl-anom", version: "v1", target_or_bps: 9800, full_cost_bps: 9200, contribution_bps: 8500 },
  fsc: { kind: "fsc", id: "fsc-anom", version: "v1", pct_bps: 2400 },
  accessorials: { kind: "accessorials", id: "acc-anom", version: "v1", items: {} },
};

// Replace a tenant DB's rate_config with exactly the four required rows (deterministic — DELETE then
// INSERT, no reliance on prior state). The rate_config table is created by the tenant migrations
// (0002_domain.sql), so the DB must already be migrated (ensureSchema / ensureTenantBSchema).
export async function seedRateConfig(db: D1Database, config: RatingConfigSeed): Promise<void> {
  await db.prepare("DELETE FROM rate_config").run();
  const parts = [config.zone_tariff, config.floors, config.fsc, config.accessorials];
  for (const part of parts) {
    await db
      .prepare("INSERT INTO rate_config (id, version, kind, payload, effective_ts, approved_by) VALUES (?,?,?,?,?,?)")
      .bind(part.id, 1, part.kind, JSON.stringify(part), 0, "seed")
      .run();
  }
}

// Empty a tenant DB's rate_config (the REQ-151 "no tariff = no sell" cold-start test).
export async function clearRateConfig(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM rate_config").run();
}

let schemaReadyB: Promise<void> | null = null;

// tenant-b full tenant-plane schema (events + domain, incl. rate_config), applied ONCE and guarded like
// ensureSchema. Needed by the REQ-025 isolation test: it must query TENANT_B_DB.events to assert a
// tenant-a append never lands there. Idempotent across the shared D1 (isolatedStorage off).
export function ensureTenantBSchema(env: Env): Promise<void> {
  schemaReadyB ??= applyTenantB(env);
  return schemaReadyB;
}

async function applyTenantB(env: Env): Promise<void> {
  if (!(await tableExists(env.TENANT_B_DB, "events"))) {
    await applyMigrations(env.TENANT_B_DB, TENANT_MIGRATIONS);
  }
  for (const [id, kind] of PARTIES) {
    await env.TENANT_B_DB.prepare("INSERT OR IGNORE INTO parties (id, kind, names) VALUES (?,?,?)").bind(id, kind, "{}").run();
  }
}

// ---- shared REAL-append HTTP + gate/seeding fixtures (Task 9 consolidation) --------------------------
// The append-route path, the delivery-fence fixture + 150 m radius, the required_evidence reader, and
// the evidence-byte formula were byte-identical across pod.test / gates.test / airplane-soak.test — a
// drift trap (touch the route path or the fence and three files had to move in lockstep). They live
// here now; every file that drives the real sequencer imports them. Per-file-unique helpers (gates'
// input/signedInput/consentPayload/rawRows, the soak's streamRows/deviceSeqs) stay local by design.

// One delivery fence at FENCE_CENTER; INSIDE sits on it (distance 0 ≪ the 150 m default radius), OUTSIDE
// sits ~1.5 km north (well outside). BOTH derive to operating state "CA" (deriveOperatingState), so ONE
// ConsentAck("CA") covers every GPS stamp on a stream.
export const FENCE_CENTER = { lat_e6: 37_421_000, lon_e6: -122_084_000 };
export const INSIDE = { lat_e6: 37_421_000, lon_e6: -122_084_000, accuracy_m: 5 };
export const OUTSIDE = { lat_e6: 37_435_000, lon_e6: -122_084_000, accuracy_m: 5 };
// The EXACT four-field .strict() ConsentAck (doc 10) for "CA" — any extra key fails the gate's safeParse.
export const CONSENT = { doc_kind: "consent", policy_version: "v1", operating_state: "CA", acknowledged: true } as const;

export interface Res {
  status: number;
  json: Record<string, unknown> | null;
}

// The REAL append path: POST /v1/shipments/:id/events → sequencer DO → Gatekeeper. A fresh idempotency
// key per call, so a caller opts into dedupe only by re-posting the SAME event id (never accidentally).
export async function post(shipmentId: string, body: unknown, tok: string): Promise<Res> {
  const res = await SELF.fetch(`https://api.local/v1/shipments/${shipmentId}/events`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

// The gate's required_evidence list off a GATE_BLOCKED response body (empty when the field is absent).
export function requiredEvidence(r: Res): string[] {
  return ((r.json?.gate as { required_evidence?: string[] } | undefined)?.required_evidence) ?? [];
}

export async function seedShipment(id: string): Promise<void> {
  await testEnv.TENANT_A_DB.prepare(
    "INSERT OR IGNORE INTO shipments (id, shipper_party_id, consignee_party_id, bill_to_party_id, created_ts) VALUES (?,?,?,?,0)",
  )
    .bind(id, "party-shipper", "party-consignee", "party-bill-to")
    .run();
}

// Seed a leg — the SERVER-SOURCED gate context (a delivery leg's dest geo IS the fence; an interline leg
// makes isInterline true). geo=null stores "{}" (no coords). NEVER from the client event: a driver
// cannot spoof "the fence is here" or "this isn't interline".
export async function seedLeg(shipmentId: string, seq: number, kind: string, geo: Record<string, number> | null): Promise<void> {
  await testEnv.TENANT_A_DB.prepare(
    "INSERT OR IGNORE INTO legs (id, shipment_id, seq, kind, executor_party_id, geo) VALUES (?,?,?,?,?,?)",
  )
    .bind(`leg-${shipmentId}-${seq}`, shipmentId, seq, kind, "party-carrier", geo === null ? "{}" : JSON.stringify(geo))
    .run();
}

// The delivery-fence leg (seq 0, kind delivery, dest geo = FENCE_CENTER) — the fixture pod/soak seed.
export async function seedDeliveryLeg(shipmentId: string): Promise<void> {
  await seedLeg(shipmentId, 0, "delivery", FENCE_CENTER);
}

export async function streamCount(shipmentId: string): Promise<number> {
  const row = await testEnv.TENANT_A_DB.prepare("SELECT COUNT(*) AS n FROM events WHERE stream_id = ?")
    .bind(`s:${shipmentId}`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// Deterministic 32-byte evidence pattern keyed by a capture-ordinal counter (never Math.random): the
// captured content-hash is self-consistent (hash === sha256(bytes)) and reproducible within a run. No
// test pins a fixed hash literal, so the shared counter is safe across files (order is deterministic).
let evidenceCounter = 0;
export function nextEvidenceBytes(): Uint8Array {
  const n = evidenceCounter++;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (n + i * 7 + 3) & 0xff;
  return bytes;
}
