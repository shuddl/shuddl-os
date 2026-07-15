import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import worker, { runSlaSweep } from "../src/index.js";
import { applyAll } from "./helpers.js";

// REQ-095 / REQ-025 — the SLA sweep's CRON WRAPPER contract (the per-tenant BEHAVIOR is proven end-to-end
// in workers/api/test/sla-sweep.test.ts, the harness with the real ShipmentSequencer DO + migrated D1). This
// file pins that the wrapper iterates the tenant allowlist and that scheduled() drives it. With no overdue
// rows the sweep records nothing — it never calls the DO append (this package binds only a STUB sequencer),
// so it must complete cleanly across BOTH allowlisted tenants.

const FIRE_MS = Date.parse("2026-07-15T01:00:00Z");
function controller(scheduledTime = FIRE_MS): ScheduledController {
  return { scheduledTime, cron: "0 1 * * *", noRetry() {} };
}
function ctx(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
}

beforeAll(async () => {
  // runSlaSweep iterates the WHOLE allowlist — both tenant DBs need the `messages`/`events` schema so the
  // per-tenant SELECT does not crash (tenant-b has no overdue rows and must be a clean no-op).
  await applyAll(env.TENANT_A_DB);
  await applyAll(env.TENANT_B_DB);
});

describe("REQ-095 — SLA sweep cron wrapper", () => {
  it("runSlaSweep resolves across every allowlisted tenant when nothing is overdue (no DO append)", async () => {
    await expect(runSlaSweep(env, () => FIRE_MS)).resolves.toBeUndefined();
  });

  it("scheduled() ACTUALLY drives the sweep (per-tenant sweep log emitted) — non-tautological", async () => {
    // Spy the per-tenant sweep log so deleting the runSlaSweep call from scheduled() fails this test (not a
    // did-not-throw tautology). runSlaSweep logs `concierge sla-sweep: tenant <slug> → …` for every tenant.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await worker.scheduled(controller(), env, ctx());
      const sweepLogged = logSpy.mock.calls.some((call) => call.some((a) => typeof a === "string" && a.includes("concierge sla-sweep: tenant")));
      expect(sweepLogged, "scheduled() must invoke runSlaSweep").toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});
