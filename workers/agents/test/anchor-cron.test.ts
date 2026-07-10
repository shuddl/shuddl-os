import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker, { runAllTenants } from "../src/index.js";
import { applyAll, noonOf, resetCounter, seedEvent } from "./helpers.js";

// REQ-014 / REQ-002 — the daily anchor cron. Drives the REAL scheduled() handler; the clock is the
// cron's scheduledTime so "yesterday" is deterministic. FakeTsaClient (ENVIRONMENT != prod) stamps.

const A = env.TENANT_A_DB;

// 2026-07-10T01:00:00Z fire -> anchors up to 2026-07-09.
const FIRE_MS = Date.parse("2026-07-10T01:00:00Z");
function controller(scheduledTime = FIRE_MS): ScheduledController {
  return { scheduledTime, cron: "0 1 * * *", noRetry() {} };
}
// Minimal ExecutionContext — the handler only ever calls runAllTenants (it voids ctx). Cast past the
// full workers-types shape (waitUntil/passThroughOnException/props/tracing) we don't exercise here.
function ctx(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
}

async function anchoredDays(db: D1Database): Promise<string[]> {
  const r = await db.prepare("SELECT id FROM documents WHERE kind='tsa_receipt' ORDER BY id").all<{ id: string }>();
  return r.results.map((x) => x.id.slice("anchor:".length));
}

beforeAll(async () => {
  resetCounter();
  // BOTH tenant DBs get schema — runAllTenants iterates the whole allowlist; tenant-b has no events
  // and must not crash (it returns early on an empty ledger).
  await applyAll(env.TENANT_A_DB);
  await applyAll(env.TENANT_B_DB);
});

describe("REQ-014 — scheduled() cron", () => {
  it("first fire anchors both seeded days; a second fire is a total no-op (INSERT OR IGNORE)", async () => {
    // seed one event on 07-08 and one on 07-09 (distinct streams so seq is fine)
    await seedEvent(A, "stop.arrived", { stream_id: "s:cron-a", shipment_id: "cron-a", seq: 0, recorded_at: noonOf("2026-07-08") });
    await seedEvent(A, "stop.arrived", { stream_id: "s:cron-b", shipment_id: "cron-b", seq: 0, recorded_at: noonOf("2026-07-09") });

    await worker.scheduled(controller(), env, ctx());
    expect(await anchoredDays(A)).toEqual(["2026-07-08", "2026-07-09"]);

    // capture roots, fire again, assert nothing changed
    const before = await A.prepare("SELECT id, hash FROM documents WHERE kind='tsa_receipt' ORDER BY id").all<{ id: string; hash: string }>();
    await worker.scheduled(controller(), env, ctx());
    const after = await A.prepare("SELECT id, hash FROM documents WHERE kind='tsa_receipt' ORDER BY id").all<{ id: string; hash: string }>();
    expect(after.results).toEqual(before.results); // identical rows -> re-run is a no-op
  });

  it("deleting one day's doc row -> the next fire backfills ONLY that day", async () => {
    await seedEvent(A, "stop.arrived", { stream_id: "s:cron-c", shipment_id: "cron-c", seq: 0, recorded_at: noonOf("2026-07-08") });
    await seedEvent(A, "stop.arrived", { stream_id: "s:cron-d", shipment_id: "cron-d", seq: 0, recorded_at: noonOf("2026-07-09") });
    await runAllTenants(env, () => new Date(FIRE_MS));
    expect(await anchoredDays(A)).toEqual(["2026-07-08", "2026-07-09"]);

    // delete 07-08's anchor; 07-09 stays anchored
    await A.prepare("DELETE FROM documents WHERE id = 'anchor:2026-07-08'").run();
    const doc09Before = await A.prepare("SELECT hash FROM documents WHERE id='anchor:2026-07-09'").first<{ hash: string }>();

    await worker.scheduled(controller(), env, ctx());
    expect(await anchoredDays(A)).toEqual(["2026-07-08", "2026-07-09"]); // 07-08 restored
    const doc09After = await A.prepare("SELECT hash FROM documents WHERE id='anchor:2026-07-09'").first<{ hash: string }>();
    expect(doc09After).toEqual(doc09Before); // 07-09 untouched — only the deleted day was backfilled
  });
});
