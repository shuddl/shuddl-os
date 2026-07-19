import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { runWatchtowerSnapshots, isoWeek, snapshotKey } from "../src/watchtower-snapshot.js";
import { applyAll } from "./helpers.js";

// WP-11 Task 10 (REQ-160 / REQ-025) — the WEEKLY Watchtower snapshot's CRON WRAPPER contract (the per-tenant
// metric compute + R2 manifest is proven end-to-end in workers/api/test/watchtower-snapshot.test.ts, the harness
// with a migrated tenant D1 + seeded ledger data). This file pins the WRAPPER: the day-of-week GATE makes the
// daily cron weekly, the wrapper iterates the tenant allowlist and writes a TENANT-SCOPED R2 key per tenant, and
// scheduled() actually drives it. Both tenant DBs are migrated (empty ledger → unbilled 0 / disputes 0 / the
// flow metrics UNKNOWN — a clean, honest, no-crash snapshot).

// 2026-07-20 is a MONDAY (UTC) = SNAPSHOT_DOW; 2026-07-21 is a Tuesday (the gate must skip it).
const MONDAY_MS = Date.parse("2026-07-20T01:00:00Z");
const TUESDAY_MS = Date.parse("2026-07-21T01:00:00Z");

function controller(scheduledTime: number): ScheduledController {
  return { scheduledTime, cron: "0 1 * * *", noRetry() {} };
}
function ctx(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
}

beforeAll(async () => {
  await applyAll(env.TENANT_A_DB);
  await applyAll(env.TENANT_B_DB);
});

describe("REQ-160 — the weekly Watchtower snapshot cron wrapper", () => {
  it("on the GATE day (Monday) it writes a TENANT-SCOPED snapshot for EVERY allowlisted tenant", async () => {
    await runWatchtowerSnapshots(env, () => MONDAY_MS);
    const week = isoWeek(MONDAY_MS);
    for (const slug of ["tenant-a", "tenant-b"]) {
      const obj = await env.EVIDENCE.get(snapshotKey(slug, week));
      expect(obj, `snapshot must exist for ${slug}`).not.toBeNull();
      const manifest = JSON.parse(await obj!.text()) as { tenant: string; metrics: Record<string, unknown> };
      expect(manifest.tenant).toBe(slug); // the key + body are tenant-scoped (REQ-025)
      // empty ledger → honest metrics: unbilled/disputes are 0, the flow metrics UNKNOWN (never fabricated)
      expect(manifest.metrics.unbilled).toBe(0);
      expect(manifest.metrics.disputes_open).toBe(0);
      expect(manifest.metrics.rating_latency_ms).toBe("UNKNOWN");
    }
  });

  it("on a NON-gate day (Tuesday) it is a total no-op — the WEEKLY gate (no write, no per-tenant log)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runWatchtowerSnapshots(env, () => TUESDAY_MS);
      const wrote = logSpy.mock.calls.some((c) => c.some((a) => typeof a === "string" && a.includes("watchtower-snapshot: tenant")));
      expect(wrote, "the gate must skip a non-SNAPSHOT_DOW tick").toBe(false);
      // and no manifest exists for Tuesday's ISO week (it is a different week than Monday's, so no false positive)
      expect(await env.EVIDENCE.get(snapshotKey("tenant-a", isoWeek(TUESDAY_MS)))).toBeNull();
    } finally {
      logSpy.mockRestore();
    }
  });

  it("IDEMPOTENT — a second gate-day run of the SAME week SKIPS (write-once; never re-clobbers)", async () => {
    // isolatedStorage is ON in this harness (per-test rollback), so establish BOTH runs inside one test: the
    // first WRITES, the second SKIPS (same ISO week → same key → no re-clobber).
    await runWatchtowerSnapshots(env, () => MONDAY_MS); // first run — writes this week
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runWatchtowerSnapshots(env, () => MONDAY_MS); // second run — same week
      const skipped = logSpy.mock.calls.some((c) => c.some((a) => typeof a === "string" && a.includes('"outcome":"skipped"')));
      const wrote = logSpy.mock.calls.some((c) => c.some((a) => typeof a === "string" && a.includes('"outcome":"written"')));
      expect(skipped, "a re-run of the same week must skip").toBe(true);
      expect(wrote, "a re-run must NOT re-write").toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("scheduled() ACTUALLY drives the weekly snapshot on the gate day (per-tenant log emitted) — non-tautological", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await worker.scheduled(controller(MONDAY_MS), env, ctx());
      const drove = logSpy.mock.calls.some((c) => c.some((a) => typeof a === "string" && a.includes("watchtower-snapshot: tenant")));
      expect(drove, "scheduled() must invoke runWatchtowerSnapshots").toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});
