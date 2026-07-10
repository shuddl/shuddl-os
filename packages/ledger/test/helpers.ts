// Shared test helpers (NOT a *.test.ts, so vitest never runs it as a suite). Builds valid
// LedgerEvents with unique id/hash and appends them WITH their money projection in one batch,
// exactly as the Task-13 sequencer will — so the projection tests exercise the real path.
import {
  eventFixture,
  type EventKind,
  type LedgerEvent,
} from "@shuddl/contracts";
import { eventToRow } from "../src/lens.js";
import { applyMoneyProjection, type MoneyProjectionDeps } from "../src/projection/money.js";

let counter = 0;
export function resetEventCounter(): void {
  counter = 0;
}

// Deterministic unique uuid + 64-hex hash from a monotonic counter (no Date.now/Math.random).
export function nextIds(): { id: string; hash: string } {
  counter += 1;
  const hex = counter.toString(16);
  return {
    id: `00000000-0000-4000-8000-${hex.padStart(12, "0")}`,
    hash: hex.padStart(64, "0"),
  };
}

export function mkEvent(kind: EventKind, over: Partial<LedgerEvent> = {}): LedgerEvent {
  const { id, hash } = nextIds();
  return eventFixture(kind, { id, hash, ...over });
}

const EVENT_COLUMNS = [
  "stream_id", "seq", "id", "shipment_id", "ts", "recorded_at", "kind",
  "actor_party_id", "actor_user_id", "actor_device_id", "party_refs", "payload",
  "evidence", "prev_hash", "hash", "sig", "visibility", "source", "confidence",
  "device_id", "device_seq", "captured_ts",
] as const;

export function eventInsertStmt(db: D1Database, e: LedgerEvent): D1PreparedStatement {
  const row = eventToRow(e);
  const placeholders = EVENT_COLUMNS.map(() => "?").join(",");
  return db
    .prepare(`INSERT INTO events (${EVENT_COLUMNS.join(",")}) VALUES (${placeholders})`)
    .bind(...EVENT_COLUMNS.map((c) => row[c] ?? null));
}

// Append an event and its money-line/invoice projection in ONE batch (I1 both directions:
// no event without its lines, no line without its event).
export async function appendWithMoney(
  db: D1Database,
  e: LedgerEvent,
  deps: MoneyProjectionDeps = {},
): Promise<void> {
  const stmts = applyMoneyProjection(db, e, deps);
  await db.batch([eventInsertStmt(db, e), ...stmts]);
}
