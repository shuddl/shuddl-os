// REQ-155 / REQ-002: load SEED-1 into a tenant D1. This is the deferred WP-01 slice — the DB load
// waited on the WP-02 schema. It writes through the SAME primitives the sequencer uses (eventToRow +
// the real money/passport/status-cache projections), so the seed exercises the production write path,
// not a shortcut.
//
// FK ORDER IS LOAD-BEARING (do not reorder): parties BEFORE any event, because pod/exception/osd/
// custody accruals write passports.party_id (FK -> parties). An unseeded actor party aborts the whole
// event batch (I1: the event and its projections commit together or not at all). Shipments are inserted
// before their events so the status-cache UPDATE/UPSERT and money_lines.event_id land on existing rows.
//
// Append-only guards are honored: plain INSERTs only, never INSERT OR REPLACE (that would trip the
// BEFORE INSERT guard on events/positions/money_lines). PURE + workerd-safe: no node:*, no wrangler —
// the seed-load test drives this against a real pool-workers D1. The Node CLI lives in load.cli.ts.
import type { LedgerEvent } from "@shuddl/contracts";
import { applyMigrations } from "@shuddl/ledger/migrate";
import { eventToRow } from "@shuddl/ledger/lens";
import { applyMoneyProjection } from "@shuddl/ledger/projection/money";
import { projectPassport } from "@shuddl/ledger/projection/passports";
import { projectStatusCache } from "@shuddl/ledger/projection/status-cache";
import type { Seed } from "./generate.js";

const EVENT_COLUMNS = [
  "stream_id", "seq", "id", "shipment_id", "ts", "recorded_at", "kind",
  "actor_party_id", "actor_user_id", "actor_device_id", "party_refs", "payload",
  "evidence", "prev_hash", "hash", "sig", "visibility", "source", "confidence",
  "device_id", "device_seq", "captured_ts",
] as const;
const EVENT_INSERT_SQL = `INSERT INTO events (${EVENT_COLUMNS.join(",")}) VALUES (${EVENT_COLUMNS.map(() => "?").join(",")})`;

function eventInsertStmt(db: D1Database, e: LedgerEvent): D1PreparedStatement {
  const row = eventToRow(e);
  return db.prepare(EVENT_INSERT_SQL).bind(...EVENT_COLUMNS.map((c) => row[c] ?? null));
}

export interface MigrationFile {
  path: string;
  sql: string;
}

/**
 * Load SEED-1 into a tenant D1: apply migrations, seed parties, insert shipments, then append every
 * event with its real projections in one batch each (mirroring the sequencer). The caller supplies the
 * tenant migration files (this module is fs-free so it works in workerd).
 */
export async function loadSeed(db: D1Database, seed: Seed, migrations: ReadonlyArray<MigrationFile>): Promise<void> {
  await applyMigrations(db, migrations);

  // 1) Parties FIRST — the passports.party_id FK depends on them.
  for (const p of seed.parties) {
    await db
      .prepare("INSERT INTO parties (id, kind, names) VALUES (?, ?, ?)")
      .bind(p.id, p.kind, JSON.stringify({ legal: p.name }))
      .run();
  }

  // 2) Shipments — before their events (status-cache + money projections update existing rows).
  for (const sh of seed.shipments) {
    await db
      .prepare(
        "INSERT INTO shipments (id, division, refs, shipper_party_id, consignee_party_id, bill_to_party_id, commodities, status_cache, created_ts) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?)",
      )
      .bind(
        sh.id,
        sh.division,
        JSON.stringify(sh.refs),
        sh.shipper_party_id,
        sh.consignee_party_id,
        sh.bill_to_party_id,
        JSON.stringify([sh.commodities]),
        sh.created_ts,
      )
      .run();
  }

  // 3) Events in seq order, each with its money/passport/status-cache projection in ONE batch (I1).
  for (const sh of seed.shipments) {
    for (const e of sh.events) {
      await db.batch([
        eventInsertStmt(db, e),
        ...applyMoneyProjection(db, e, {}),
        ...projectPassport(db, e),
        ...projectStatusCache(db, e),
      ]);
    }
  }
}
