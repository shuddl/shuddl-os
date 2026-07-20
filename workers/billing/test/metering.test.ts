import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { runMeteringSweep, sweepTenantMetering, periodOf } from "../src/metering.js";
import { TENANT_SLUGS } from "../src/tenants.js";
import {
  applyTenant,
  applyControl,
  resetCounter,
  resetStreams,
  seedRun,
  seedOrphanRun,
  readMetered,
  countActedInPeriod,
} from "./helpers.js";

// WP-14 Task 6 · REQ-123 / REQ-025 — THE CROSS-DB METERING RECOMPUTE SWEEP. The metered unit is the AI action
// = the frozen `agent.acted` event; `agent_runs` is the idempotent one-row-per-`agent.acted` meter (INSERT OR
// IGNORE on the event id), so COUNT(agent_runs) == COUNT(agent.acted) EXACTLY. The events ledger is per-tenant
// D1; usage_credits is control-plane D1 (a SEPARATE database) — so the metering write is a scheduled recompute
// that OVERWRITES usage_credits.metered per (tenant, period), never a += counter (drift-free by construction).
// This suite drives runMeteringSweep / sweepTenantMetering — the SAME code path scheduled() runs.

// Two UTC-month periods. `periodOf` buckets by UTC calendar month (mirrors workers/mcp/src/caps.ts).
const JUN = Date.UTC(2026, 5, 15, 9, 0); // "2026-06"
const JUL = Date.UTC(2026, 6, 15, 9, 0); // "2026-07"
const P_JUN = "2026-06";
const P_JUL = "2026-07";

function controller(): ScheduledController {
  return { scheduledTime: JUL, cron: "0 * * * *", noRetry() {} };
}
function ctx(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
}

// The DoD gate, asserted directly: for a (tenant, period), the metered blob's per-agent counts must SUM to the
// EXACT COUNT(agent.acted) in that period's ledger — `sum over agents of metered == COUNT(agent.acted)`.
async function expectReconciles(db: D1Database, tenant: string, period: string): Promise<number> {
  const metered = await readMetered(env.CONTROL_DB, tenant, period);
  const truth = await countActedInPeriod(db, period);
  const sum = metered === null ? 0 : Object.values(metered).reduce((a, b) => a + b, 0);
  expect(sum).toBe(truth);
  return truth;
}

beforeAll(async () => {
  await applyTenant(env.TENANT_A_DB);
  await applyTenant(env.TENANT_B_DB);
  await applyControl(env.CONTROL_DB);
});
beforeEach(() => {
  resetCounter();
  resetStreams();
});

describe("REQ-123 — metering matches event counts EXACTLY", () => {
  it("periodOf buckets an event ts into its UTC calendar month", () => {
    expect(periodOf(JUN)).toBe(P_JUN);
    expect(periodOf(JUL)).toBe(P_JUL);
    expect(periodOf(Date.UTC(2026, 11, 31, 23, 59))).toBe("2026-12");
    expect(periodOf(Date.UTC(2027, 0, 1, 0, 0))).toBe("2027-01");
  });

  it("recomputes {agent: count} per (tenant, period) and the metered blob sums to COUNT(agent.acted) EXACTLY", async () => {
    // 2026-06: rater×3, biller×2 (=5). 2026-07: rater×1, watchtower×4 (=5).
    for (let i = 0; i < 3; i++) await seedRun(env.TENANT_A_DB, "rater", JUN);
    for (let i = 0; i < 2; i++) await seedRun(env.TENANT_A_DB, "biller", JUN);
    await seedRun(env.TENANT_A_DB, "rater", JUL);
    for (let i = 0; i < 4; i++) await seedRun(env.TENANT_A_DB, "watchtower", JUL);

    await sweepTenantMetering(env.TENANT_A_DB, env.CONTROL_DB, "tenant-a");

    // Exact per-agent recompute…
    expect(await readMetered(env.CONTROL_DB, "tenant-a", P_JUN)).toEqual({ biller: 2, rater: 3 });
    expect(await readMetered(env.CONTROL_DB, "tenant-a", P_JUL)).toEqual({ rater: 1, watchtower: 4 });
    // …and the DoD reconciliation gate: sum(metered) == COUNT(agent.acted) for each period.
    expect(await expectReconciles(env.TENANT_A_DB, "tenant-a", P_JUN)).toBe(5);
    expect(await expectReconciles(env.TENANT_A_DB, "tenant-a", P_JUL)).toBe(5);
  });

  it("is IDEMPOTENT — re-running the sweep OVERWRITES to the identical result, no drift, no double-count", async () => {
    for (let i = 0; i < 7; i++) await seedRun(env.TENANT_A_DB, "rater", JUN);
    await seedRun(env.TENANT_A_DB, "biller", JUL);

    await sweepTenantMetering(env.TENANT_A_DB, env.CONTROL_DB, "tenant-a");
    const first = await readMetered(env.CONTROL_DB, "tenant-a", P_JUN);
    // Re-run twice more — an overwrite yields byte-identical metered, never 7→14→21 (which a += would give).
    await sweepTenantMetering(env.TENANT_A_DB, env.CONTROL_DB, "tenant-a");
    await sweepTenantMetering(env.TENANT_A_DB, env.CONTROL_DB, "tenant-a");
    expect(await readMetered(env.CONTROL_DB, "tenant-a", P_JUN)).toEqual(first);
    expect(await readMetered(env.CONTROL_DB, "tenant-a", P_JUN)).toEqual({ rater: 7 });
    expect(await expectReconciles(env.TENANT_A_DB, "tenant-a", P_JUN)).toBe(7);
  });

  it("RECOMPUTES, never INCREMENTS — a run added AFTER the first sweep, re-swept, reflects the NEW true total (not old+new)", async () => {
    for (let i = 0; i < 3; i++) await seedRun(env.TENANT_A_DB, "rater", JUN);
    await sweepTenantMetering(env.TENANT_A_DB, env.CONTROL_DB, "tenant-a");
    expect(await readMetered(env.CONTROL_DB, "tenant-a", P_JUN)).toEqual({ rater: 3 });

    // One more real metered action lands in the same period, THEN re-sweep.
    await seedRun(env.TENANT_A_DB, "rater", JUN);
    await sweepTenantMetering(env.TENANT_A_DB, env.CONTROL_DB, "tenant-a");

    // Overwrite → exactly 4 (the new true total). A += counter would read 3 + 4 = 7 here and FAIL this gate.
    expect(await readMetered(env.CONTROL_DB, "tenant-a", P_JUN)).toEqual({ rater: 4 });
    expect(await expectReconciles(env.TENANT_A_DB, "tenant-a", P_JUN)).toBe(4);
  });

  it("is TENANT-SCOPED — tenant-a's sweep reads only tenant-a's D1 and writes only tenant-a's usage_credits; tenant-b untouched (REQ-025)", async () => {
    await seedRun(env.TENANT_A_DB, "rater", JUN);
    await seedRun(env.TENANT_A_DB, "rater", JUN);
    // tenant-b has its OWN runs — they must NOT be swept when we sweep only tenant-a.
    await seedRun(env.TENANT_B_DB, "biller", JUN);

    await sweepTenantMetering(env.TENANT_A_DB, env.CONTROL_DB, "tenant-a");

    // tenant-a metered correctly…
    expect(await readMetered(env.CONTROL_DB, "tenant-a", P_JUN)).toEqual({ rater: 2 });
    // …and NOT a single control row exists for tenant-b (its sweep never ran), nor was tenant-b's D1 touched.
    const bRows = await env.CONTROL_DB.prepare("SELECT COUNT(*) AS n FROM usage_credits WHERE tenant_id = 'tenant-b'").first<{ n: number }>();
    expect(bRows?.n).toBe(0);
    // Every control row this sweep wrote is scoped to tenant-a (id `<tenant>:<period>`, tenant_id = tenant-a).
    const rows = (await env.CONTROL_DB.prepare("SELECT id, tenant_id FROM usage_credits").all<{ id: string; tenant_id: string }>()).results;
    for (const r of rows) {
      expect(r.tenant_id).toBe("tenant-a");
      expect(r.id.startsWith("tenant-a:")).toBe(true);
    }
  });

  it("the full sweep meters BOTH tenants independently, each reconciling exactly", async () => {
    await seedRun(env.TENANT_A_DB, "rater", JUN);
    await seedRun(env.TENANT_A_DB, "rater", JUN);
    await seedRun(env.TENANT_B_DB, "biller", JUN);
    await seedRun(env.TENANT_B_DB, "biller", JUN);
    await seedRun(env.TENANT_B_DB, "biller", JUN);

    await runMeteringSweep(env);

    expect(await readMetered(env.CONTROL_DB, "tenant-a", P_JUN)).toEqual({ rater: 2 });
    expect(await readMetered(env.CONTROL_DB, "tenant-b", P_JUN)).toEqual({ biller: 3 });
    expect(await expectReconciles(env.TENANT_A_DB, "tenant-a", P_JUN)).toBe(2);
    expect(await expectReconciles(env.TENANT_B_DB, "tenant-b", P_JUN)).toBe(3);
  });

  it("does NOT meter _platform or pool sentinels — they are not in the iteration roster", async () => {
    // The roster is exactly the paying customer tenants; no reserved/sentinel slug is ever swept.
    expect([...TENANT_SLUGS]).toEqual(["tenant-a", "tenant-b"]);
    for (const slug of TENANT_SLUGS) {
      expect(slug.startsWith("_")).toBe(false);
    }
    await seedRun(env.TENANT_A_DB, "rater", JUN);
    await runMeteringSweep(env);
    // No control row is ever written for a reserved/sentinel tenant (tenant_id beginning with "_").
    const reserved = await env.CONTROL_DB.prepare("SELECT COUNT(*) AS n FROM usage_credits WHERE tenant_id LIKE '\\_%' ESCAPE '\\'").first<{ n: number }>();
    expect(reserved?.n).toBe(0);
  });

  it("an orphan agent_runs row (no matching event) is NOT metered — the INNER JOIN drops it, so metering stays == COUNT(agent.acted)", async () => {
    await seedRun(env.TENANT_A_DB, "rater", JUN);
    await seedRun(env.TENANT_A_DB, "rater", JUN);
    // A run row whose event id does not exist in `events` (a corrupt/partial write). It must never be counted.
    await seedOrphanRun(env.TENANT_A_DB, "00000000-0000-4000-8000-ffffffffffff", "ghost");

    await sweepTenantMetering(env.TENANT_A_DB, env.CONTROL_DB, "tenant-a");

    const metered = await readMetered(env.CONTROL_DB, "tenant-a", P_JUN);
    expect(metered).toEqual({ rater: 2 }); // no `ghost` — the orphan is invisible to the JOIN
    expect(await expectReconciles(env.TENANT_A_DB, "tenant-a", P_JUN)).toBe(2);
  });

  it("OVERWRITES only `metered` — a `stripe_refs` set out-of-band survives a re-sweep", async () => {
    await seedRun(env.TENANT_A_DB, "rater", JUN);
    await sweepTenantMetering(env.TENANT_A_DB, env.CONTROL_DB, "tenant-a");

    // A Stripe reconciliation stamps stripe_refs on the SAME (tenant, period) control row (same deterministic id).
    await env.CONTROL_DB.prepare("UPDATE usage_credits SET stripe_refs = ? WHERE id = 'tenant-a:2026-06'")
      .bind(JSON.stringify({ invoice: "in_123" }))
      .run();

    // Another metered action + a re-sweep must overwrite metered but NOT clobber stripe_refs.
    await seedRun(env.TENANT_A_DB, "rater", JUN);
    await sweepTenantMetering(env.TENANT_A_DB, env.CONTROL_DB, "tenant-a");

    const row = await env.CONTROL_DB.prepare("SELECT metered, stripe_refs FROM usage_credits WHERE id = 'tenant-a:2026-06'").first<{ metered: string; stripe_refs: string }>();
    expect(JSON.parse(row!.metered)).toEqual({ rater: 2 }); // recomputed
    expect(JSON.parse(row!.stripe_refs)).toEqual({ invoice: "in_123" }); // preserved
  });

  it("drives end-to-end through the worker's scheduled() handler", async () => {
    await seedRun(env.TENANT_A_DB, "rater", JUL);
    await seedRun(env.TENANT_A_DB, "biller", JUL);
    await worker.scheduled(controller(), env, ctx());
    expect(await readMetered(env.CONTROL_DB, "tenant-a", P_JUL)).toEqual({ biller: 1, rater: 1 });
    expect(await expectReconciles(env.TENANT_A_DB, "tenant-a", P_JUL)).toBe(2);
  });
});
