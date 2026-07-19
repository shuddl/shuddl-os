// Shared setup for the Translator pool-workers suite (NOT a *.test.ts). Applies the tenant migrations to a D1
// and seeds ledger events + an `edi_partner` integrations row directly (bypassing the sequencer — the 214
// sweep reads records, it does not append). Mirrors workers/agents/test/helpers.ts.
import { applyMigrations } from "@shuddl/ledger/migrate";
import { eventToRow } from "@shuddl/ledger/lens";
import { eventFixture, type EventKind, type LedgerEvent } from "@shuddl/contracts";
import ledgerCore from "../../../db/tenant/migrations/0001_ledger_core.sql?raw";
import domain from "../../../db/tenant/migrations/0002_domain.sql?raw";
import insertGuards from "../../../db/tenant/migrations/0003_insert_guards.sql?raw";
import partyRefsGuard from "../../../db/tenant/migrations/0004_party_refs_guard.sql?raw";
import documentsRetention from "../../../db/tenant/migrations/0007_documents_retention.sql?raw";

const MIGRATIONS = [
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

export async function applyAll(db: D1Database): Promise<void> {
  if (!(await tableExists(db, "events"))) await applyMigrations(db, MIGRATIONS);
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

// Insert one event directly. Callers must pass a distinct (stream_id, seq) — the append-only insert guard
// aborts a duplicate. Returns the event so a test can read back its id/ts/payload.
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

// Seed an `edi_partner` integrations row (id = partnerId). cert_status/config are what the sweep reads to
// decide whether to build + transmit a 214 for this partner's tendered shipments.
export async function seedEdiPartner(
  db: D1Database,
  partnerId: string,
  certStatus: string | null,
  config = "{}",
): Promise<void> {
  await db
    .prepare("INSERT INTO integrations (id, kind, config, cert_status) VALUES (?, 'edi_partner', ?, ?)")
    .bind(partnerId, config, certStatus)
    .run();
}
