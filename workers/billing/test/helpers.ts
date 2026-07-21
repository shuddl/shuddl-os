// Shared setup for the Billing pool-workers suite (NOT a *.test.ts). Applies the tenant migrations to a tenant
// D1 (so `events` + `agent_runs` exist), applies the control migration to CONTROL_DB (so `usage_credits`
// exists), and seeds ledger `agent.acted` events + their `agent_runs` rows the SAME way the ledger does — via
// projectAgentRuns (INSERT OR IGNORE on the event id), so the test's meter matches the production meter EXACTLY.
// Mirrors workers/agents/test/helpers.ts + workers/mcp/test/helpers.ts.
import { applyMigrations } from "@shuddl/ledger/migrate";
import { eventToRow } from "@shuddl/ledger/lens";
import { projectAgentRuns } from "@shuddl/ledger/projection/agent-runs";
import { eventFixture, type EventKind, type JsonObject, type LedgerEvent } from "@shuddl/contracts";
import ledgerCore from "../../../db/tenant/migrations/0001_ledger_core.sql?raw";
import domain from "../../../db/tenant/migrations/0002_domain.sql?raw";
import insertGuards from "../../../db/tenant/migrations/0003_insert_guards.sql?raw";
import partyRefsGuard from "../../../db/tenant/migrations/0004_party_refs_guard.sql?raw";
import documentsRetention from "../../../db/tenant/migrations/0007_documents_retention.sql?raw";
import controlSql from "../../../db/control/migrations/0001_control.sql?raw";

const TENANT_MIGRATIONS = [
  { path: "0001_ledger_core.sql", sql: ledgerCore },
  { path: "0002_domain.sql", sql: domain },
  { path: "0003_insert_guards.sql", sql: insertGuards },
  { path: "0004_party_refs_guard.sql", sql: partyRefsGuard },
  { path: "0007_documents_retention.sql", sql: documentsRetention },
];

async function tableExists(db: D1Database, name: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name = ?").bind(name).first();
  return row !== null;
}

// Apply the tenant migrations once (idempotent — skipped if `events` already exists in this isolate).
export async function applyTenant(db: D1Database): Promise<void> {
  if (!(await tableExists(db, "events"))) await applyMigrations(db, TENANT_MIGRATIONS);
}

// Apply 0001_control.sql once (idempotent — skipped if `usage_credits` already exists in this isolate).
export async function applyControl(db: D1Database): Promise<void> {
  if (!(await tableExists(db, "usage_credits"))) await applyMigrations(db, [{ path: "0001_control.sql", sql: controlSql }]);
}

// WP-14 Task 7 — apply the tenant migrations to the reserved PLATFORM tenant's D1 (so `events` + `money_lines` +
// `invoices` exist), where the credit-purchase money events land. Same migration set as applyTenant (the platform
// tenant carries the same ledger schema); override_json (0005) is intentionally out of this set, matching the
// D1PlatformLedger insert column list. Idempotent.
export async function applyPlatform(db: D1Database): Promise<void> {
  if (!(await tableExists(db, "events"))) await applyMigrations(db, TENANT_MIGRATIONS);
}

const EVENT_COLUMNS = [
  "stream_id", "seq", "id", "shipment_id", "ts", "recorded_at", "kind",
  "actor_party_id", "actor_user_id", "actor_device_id", "party_refs", "payload",
  "evidence", "prev_hash", "hash", "sig", "visibility", "source", "confidence",
  "device_id", "device_seq", "captured_ts",
] as const;

let counter = 0;
export function resetCounter(): void {
  counter = 0;
}
function nextIds(): { id: string; hash: string } {
  counter += 1;
  const hex = counter.toString(16);
  return { id: `00000000-0000-4000-8000-${hex.padStart(12, "0")}`, hash: hex.padStart(64, "0") };
}

// Insert one event directly (bypassing the sequencer — the sweep reads records, it does not append). Callers
// pass a distinct (stream_id, seq); the append-only insert guard aborts a duplicate. Returns the event.
export async function seedEvent(db: D1Database, kind: EventKind, over: Partial<LedgerEvent> = {}): Promise<LedgerEvent> {
  const { id, hash } = nextIds();
  const e = eventFixture(kind, { id, hash, ...over } as Partial<LedgerEvent>);
  const row = eventToRow(e);
  await db
    .prepare(`INSERT INTO events (${EVENT_COLUMNS.join(",")}) VALUES (${EVENT_COLUMNS.map(() => "?").join(",")})`)
    .bind(...EVENT_COLUMNS.map((c) => row[c] ?? null))
    .run();
  return e;
}

let streamN = 0;
export function resetStreams(): void {
  streamN = 0;
}

// Seed ONE metered AI action: a committed `agent.acted` event for `agent` at `ts` (epoch ms), PLUS its
// `agent_runs` row projected the SAME way the ledger projects it (projectAgentRuns → INSERT OR IGNORE on the
// event id). Each call gets a fresh (stream_id, seq=0) so the append-only guard never trips. Returns the event.
export async function seedRun(db: D1Database, agent: string, ts: number): Promise<LedgerEvent> {
  streamN += 1;
  const payload: JsonObject = {
    agent,
    action: "acted",
    basis: [{ kind: "config", id: "rc" }],
    confidence_bps: 10_000,
  };
  // The events CHECK constraint requires stream_id = 's:' || shipment_id, so keep the two in lockstep.
  const shipmentId = `run-${streamN}`;
  const e = await seedEvent(db, "agent.acted", {
    stream_id: `s:${shipmentId}`,
    shipment_id: shipmentId,
    seq: 0,
    ts,
    payload,
  });
  await db.batch(projectAgentRuns(db, e));
  return e;
}

// Insert a raw agent_runs row NOT tied to a real event (for the "stray run with a missing event" edge — the
// INNER JOIN to `events` must drop it, so it is never metered). id is the (absent) event id it claims.
export async function seedOrphanRun(db: D1Database, id: string, agent: string): Promise<void> {
  await db
    .prepare(
      "INSERT OR IGNORE INTO agent_runs (id, agent, trigger_event_id, actions, basis, confidence, cost, latency_ms, outcome) " +
        "VALUES (?, ?, NULL, '[]', '[]', NULL, '{}', NULL, NULL)",
    )
    .bind(id, agent)
    .run();
}

// Read back a (tenant, period)'s metered blob from CONTROL_DB (NULL if the sweep wrote no row for it).
export async function readMetered(control: D1Database, tenant: string, period: string): Promise<Record<string, number> | null> {
  const row = await control
    .prepare("SELECT metered FROM usage_credits WHERE tenant_id = ? AND period = ?")
    .bind(tenant, period)
    .first<{ metered: string }>();
  return row === null ? null : (JSON.parse(row.metered) as Record<string, number>);
}

// COUNT(agent.acted) in a tenant's ledger for a UTC-month period — the ground truth the metered blob must sum
// to. Uses strftime over ts/1000 (epoch ms → seconds) purely as an INDEPENDENT oracle of the JS period bucket.
export async function countActedInPeriod(db: D1Database, period: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'agent.acted' AND strftime('%Y-%m', ts / 1000, 'unixepoch') = ?")
    .bind(period)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
