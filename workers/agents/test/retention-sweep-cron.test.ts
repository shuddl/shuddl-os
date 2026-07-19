import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { runRetentionSweep } from "../src/index.js";
import { sweepTenantExpiredDocuments } from "@shuddl/ledger/documents/retention";
import { applyAll } from "./helpers.js";

// WP-11 Task 12 (REQ-116 / REQ-025) — the R2 RETENTION sweep's CRON WRAPPER + tenant isolation. The pure sweep
// (delete expired non-POD bytes + tombstone the row, POD kept 7yr, idempotent) is proven in
// packages/ledger/test/retention.test.ts; this file pins the WRAPPER: the fan-out iterates the tenant allowlist
// over each tenant's D1 + its `evidence/<tenant>/` key scope, scheduled() actually drives it, and a tenant-a
// sweep never touches tenant-b's bytes or rows. isolatedStorage is ON (per-test rollback) — each test seeds fresh.

const DAY_MS = 86_400_000;
const YEAR_MS = 365 * DAY_MS;
const NOW = Date.parse("2026-07-18T00:00:00Z");

function controller(scheduledTime: number): ScheduledController {
  return { scheduledTime, cron: "0 1 * * *", noRetry() {} };
}
function ctx(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
}

let seedN = 0;
async function seedDoc(db: D1Database, tenant: string, id: string, kind: string, hash: string, createdTs: number, lifecycleClass: string): Promise<string> {
  const key = `evidence/${tenant}/${id}/${hash}`;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (seedN + i) & 0xff;
  seedN += 1;
  await env.EVIDENCE.put(key, bytes);
  await db
    .prepare(
      "INSERT INTO documents (id, shipment_id, party_id, kind, r2_key, hash, lifecycle_class, visibility, created_ts, retention_status) VALUES (?,?,?,?,?,?,?,?,?, 'active')",
    )
    .bind(id, id, null, kind, key, hash, lifecycleClass, "counterparty", createdTs)
    .run();
  return key;
}

async function status(db: D1Database, id: string): Promise<string | null> {
  const row = await db.prepare("SELECT retention_status FROM documents WHERE id = ?").bind(id).first<{ retention_status: string }>();
  return row?.retention_status ?? null;
}

beforeAll(async () => {
  await applyAll(env.TENANT_A_DB);
  await applyAll(env.TENANT_B_DB);
});

describe("REQ-116 — the retention sweep cron wrapper (per-tenant fan-out)", () => {
  it("deletes an EXPIRED non-POD doc's bytes + tombstones the row across the allowlist", async () => {
    const key = await seedDoc(env.TENANT_A_DB, "tenant-a", "cron-photo", "photo", "a".repeat(64), NOW - 2 * YEAR_MS, "default");
    await runRetentionSweep(env, () => NOW);
    expect(await env.EVIDENCE.head(key), "expired bytes deleted").toBeNull();
    expect(await status(env.TENANT_A_DB, "cron-photo")).toBe("expired");
  });

  it("a POD is KEPT (7yr) even when older than any default hold", async () => {
    const key = await seedDoc(env.TENANT_A_DB, "tenant-a", "cron-pod", "POD", "b".repeat(64), NOW - 10 * YEAR_MS, "pod-7yr");
    await runRetentionSweep(env, () => NOW);
    expect(await env.EVIDENCE.head(key), "a POD's bytes are never retention-deleted").not.toBeNull();
    expect(await status(env.TENANT_A_DB, "cron-pod")).toBe("active");
  });

  it("scheduled() ACTUALLY drives the retention sweep (per-tenant log emitted) — non-tautological", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await worker.scheduled(controller(NOW), env, ctx());
      const drove = logSpy.mock.calls.some((c) => c.some((a) => typeof a === "string" && a.includes("retention-sweep: tenant")));
      expect(drove, "scheduled() must invoke runRetentionSweep").toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("REQ-116/025 — the sweep is TENANT-BOUND: a tenant-a sweep never touches tenant-b", () => {
  it("running ONLY tenant-a's sweep deletes tenant-a's expired photo but leaves tenant-b's identical-age photo intact", async () => {
    const aKey = await seedDoc(env.TENANT_A_DB, "tenant-a", "iso-a", "photo", "1".repeat(64), NOW - 2 * YEAR_MS, "default");
    const bKey = await seedDoc(env.TENANT_B_DB, "tenant-b", "iso-b", "photo", "2".repeat(64), NOW - 2 * YEAR_MS, "default");

    // The exact per-tenant unit the fan-out invokes, run for tenant-a ALONE (its D1 + its `evidence/tenant-a/`
    // key scope). Even against the SHARED R2 with a same-age tenant-b object present, it must not cross.
    const res = await sweepTenantExpiredDocuments(env.TENANT_A_DB, env.EVIDENCE, "tenant-a", NOW);
    expect(res.deleted).toBe(1);

    // tenant-a's expired photo is deleted + tombstoned; tenant-b's object + row are completely untouched.
    expect(await env.EVIDENCE.head(aKey)).toBeNull();
    expect(await status(env.TENANT_A_DB, "iso-a")).toBe("expired");
    expect(await env.EVIDENCE.head(bKey), "tenant-b's bytes survive a tenant-a sweep").not.toBeNull();
    expect(await status(env.TENANT_B_DB, "iso-b"), "tenant-b's row stays active").toBe("active");
  });
});
