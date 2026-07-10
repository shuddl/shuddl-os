import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { LedgerEvent } from "@shuddl/contracts";
import { hashEvent, verifyChain } from "../src/chain.js";
import { rowToEvent } from "../src/lens.js";
import { generateSeed } from "../../../tools/seed/generate.js";
import { loadSeed } from "../../../tools/seed/load.js";
import ledgerCore from "../../../db/tenant/migrations/0001_ledger_core.sql?raw";
import domain from "../../../db/tenant/migrations/0002_domain.sql?raw";
import insertGuards from "../../../db/tenant/migrations/0003_insert_guards.sql?raw";
import partyRefsGuard from "../../../db/tenant/migrations/0004_party_refs_guard.sql?raw";

// REQ-155 (WP-01 deferred slice) + REQ-002 DoD: SEED-1 loads into a REAL D1 through the production
// write path (eventToRow + real projections, FK-ordered), and every stored event chain verifies —
// the hash the DB reads back is the hash the generator chained (rowToEvent must reproduce it exactly).
const DB = env.TENANT_A_DB;
const MIGRATIONS = [
  { path: "0001_ledger_core.sql", sql: ledgerCore },
  { path: "0002_domain.sql", sql: domain },
  { path: "0003_insert_guards.sql", sql: insertGuards },
  { path: "0004_party_refs_guard.sql", sql: partyRefsGuard },
];

beforeAll(async () => {
  const seed = await generateSeed();
  await loadSeed(DB, seed, MIGRATIONS);
});

describe("SEED-1 → D1 loader (REQ-155, REQ-002)", () => {
  it("loads exactly 20 shipments", async () => {
    const row = await DB.prepare("SELECT COUNT(*) AS n FROM shipments").first<{ n: number }>();
    expect(row?.n).toBe(20);
  });

  it("every event stream verifyChains green from GENESIS", async () => {
    const streams = await DB.prepare("SELECT DISTINCT stream_id FROM events ORDER BY stream_id").all<{ stream_id: string }>();
    expect(streams.results.length).toBe(20);
    for (const { stream_id } of streams.results) {
      const rows = await DB.prepare("SELECT * FROM events WHERE stream_id = ? ORDER BY seq").bind(stream_id).all<Record<string, string | number | null>>();
      const events = rows.results.map((r) => rowToEvent(r));
      const result = await verifyChain(events);
      expect(result.ok, `chain ${stream_id}: ${JSON.stringify(result)}`).toBe(true);
      expect(result.ok && result.count).toBe(events.length);
    }
  });

  it("hashEvent(rowToEvent(row)) === row.hash for every stored event (D1 read-back is hash-stable)", async () => {
    const rows = await DB.prepare("SELECT * FROM events").all<Record<string, string | number | null>>();
    expect(rows.results.length).toBeGreaterThan(0);
    for (const r of rows.results) {
      const e: LedgerEvent = rowToEvent(r);
      expect(await hashEvent(e)).toBe(r.hash);
    }
  });

  it("the real projections replayed — invoices + passport accruals landed in the same load", async () => {
    const inv = await DB.prepare("SELECT COUNT(*) AS n FROM invoices").first<{ n: number }>();
    expect(inv?.n).toBeGreaterThan(0);
    const lines = await DB.prepare("SELECT COUNT(*) AS n FROM money_lines").first<{ n: number }>();
    expect(lines?.n).toBeGreaterThan(0);
    const passport = await DB.prepare("SELECT scores FROM passports WHERE party_id = 'party-7'").first<{ scores: string }>();
    expect(passport).not.toBeNull();
    const scores = JSON.parse(passport?.scores ?? "{}") as Record<string, number>;
    expect((scores.deliveries ?? 0) + (scores.custody_events ?? 0)).toBeGreaterThan(0);
  });
});
