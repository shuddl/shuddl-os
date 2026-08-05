// Shared setup for the anchor-cron pool-workers suite (NOT a *.test.ts). Applies the tenant
// migrations to a D1 and seeds ledger events directly (bypassing the sequencer — these tests exercise
// the anchor job, not the append path).
import { applyMigrations } from "@shuddl/ledger/migrate";
import { eventToRow } from "@shuddl/ledger/lens";
import { eventFixture, type EventKind, type LedgerEvent } from "@shuddl/contracts";
import ledgerCore from "../../../db/tenant/migrations/0001_ledger_core.sql?raw";
import domain from "../../../db/tenant/migrations/0002_domain.sql?raw";
import insertGuards from "../../../db/tenant/migrations/0003_insert_guards.sql?raw";
import partyRefsGuard from "../../../db/tenant/migrations/0004_party_refs_guard.sql?raw";
import eventsOverride from "../../../db/tenant/migrations/0005_events_override.sql?raw";
import booking from "../../../db/tenant/migrations/0006_booking.sql?raw";
import documentsRetention from "../../../db/tenant/migrations/0007_documents_retention.sql?raw";
import uniqueGuards from "../../../db/tenant/migrations/0008_append_only_unique_guards.sql?raw";
import controlSql from "../../../db/control/migrations/0001_control.sql?raw";

const MIGRATIONS = [
  { path: "0001_ledger_core.sql", sql: ledgerCore },
  { path: "0002_domain.sql", sql: domain },
  { path: "0003_insert_guards.sql", sql: insertGuards },
  { path: "0004_party_refs_guard.sql", sql: partyRefsGuard },
  { path: "0005_events_override.sql", sql: eventsOverride },
  { path: "0006_booking.sql", sql: booking },
  { path: "0007_documents_retention.sql", sql: documentsRetention },
  { path: "0008_append_only_unique_guards.sql", sql: uniqueGuards },
];

async function tableExists(db: D1Database, name: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name = ?").bind(name).first();
  return row !== null;
}

export async function applyAll(db: D1Database): Promise<void> {
  if (!(await tableExists(db, "events"))) await applyMigrations(db, MIGRATIONS);
}

// WP-14 Task 8 (REQ-122/125) — apply the control-plane migration to CONTROL_DB (so `tenants` exists) once.
// Idempotent — skipped if `tenants` already exists in this isolate. Mirrors workers/mcp/test/helpers.ts.
export async function applyControl(db: D1Database): Promise<void> {
  if (!(await tableExists(db, "tenants"))) await applyMigrations(db, [{ path: "0001_control.sql", sql: controlSql }]);
}

// Seed a control-plane `tenants` row (idempotent). The Spark cap resolves plan/policy by SLUG. `plan='spark'`
// makes the tenant metered; `policy` carries the `spark_ai_allotment` (a JSON string). Distinct slugs per case
// keep rows from bleeding across `it`s.
export async function seedControlTenant(
  db: D1Database,
  opts: { id: string; slug: string; plan: string; policy?: string },
): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO tenants (id, name, slug, plan, policy, created_ts) VALUES (?,?,?,?,?,?)")
    .bind(opts.id, opts.slug, opts.slug, opts.plan, opts.policy ?? "{}", 0)
    .run();
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

// Insert one event directly. Callers must pass a distinct (stream_id, seq) — the append-only insert
// guard aborts a duplicate. Returns the event so a test can read back its hash.
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

// A UTC midnight+noon epoch-ms for a given day, for seeding recorded_at deterministically.
export function noonOf(day: string): number {
  return Date.parse(`${day}T12:00:00.000Z`);
}
