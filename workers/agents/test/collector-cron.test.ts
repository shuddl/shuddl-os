import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import worker, { runCollectorSweep } from "../src/index.js";
import { applyAll } from "./helpers.js";

// REQ-032 / REQ-025 — the Collector dunning sweep's CRON WRAPPER contract (the per-tenant DRAFTING behavior is
// proven end-to-end in workers/api/test/collector-cron.test.ts, the harness with migrated tenant D1). This
// file pins that the wrapper iterates the tenant allowlist and that scheduled() drives it. With no overdue
// invoices the sweep drafts nothing and completes cleanly across BOTH allowlisted tenants (it appends no event
// and calls no sender — it only reads `invoices`/`parties` and writes `messages`).

const FIRE_MS = Date.parse("2026-07-15T01:00:00Z");
function controller(scheduledTime = FIRE_MS): ScheduledController {
  return { scheduledTime, cron: "0 1 * * *", noRetry() {} };
}
function ctx(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
}

beforeAll(async () => {
  // runCollectorSweep iterates the WHOLE allowlist — both tenant DBs need the `invoices`/`parties`/`messages`
  // schema so the per-tenant SELECT does not crash (neither has overdue invoices → a clean no-op).
  await applyAll(env.TENANT_A_DB);
  await applyAll(env.TENANT_B_DB);
});

describe("REQ-032 — Collector dunning sweep cron wrapper", () => {
  it("runCollectorSweep resolves across every allowlisted tenant when nothing is overdue (no draft, no send)", async () => {
    await expect(runCollectorSweep(env, () => FIRE_MS)).resolves.toBeUndefined();
  });

  it("scheduled() ACTUALLY drives the dunning sweep (per-tenant sweep log emitted) — non-tautological", async () => {
    // Spy the per-tenant sweep log so deleting the runCollectorSweep call from scheduled() fails this test (not
    // a did-not-throw tautology). runCollectorSweep logs `collector dunning-sweep: tenant <slug> → …` per tenant.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await worker.scheduled(controller(), env, ctx());
      const sweepLogged = logSpy.mock.calls.some((call) => call.some((a) => typeof a === "string" && a.includes("collector dunning-sweep: tenant")));
      expect(sweepLogged, "scheduled() must invoke runCollectorSweep").toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});
