import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import worker, { runReconSweep } from "../src/index.js";
import { applyAll } from "./helpers.js";

// REQ-169 / REQ-025 — the reconciliation sweep's CRON WRAPPER contract (the per-tenant BEHAVIOR is proven end-
// to-end in workers/api/test/recon-sweep.test.ts, the harness with the real ShipmentSequencer DO + migrated D1).
// This file pins that the wrapper iterates the tenant allowlist and that scheduled() drives it. With no unbilled
// PODs the sweep re-enqueues nothing — it never calls AGENT_QUEUE.send — so it must complete cleanly across BOTH
// allowlisted tenants (both DBs migrated so the per-tenant anti-join SELECT does not crash).

const FIRE_MS = Date.parse("2026-07-18T01:00:00Z");
function controller(scheduledTime = FIRE_MS): ScheduledController {
  return { scheduledTime, cron: "0 1 * * *", noRetry() {} };
}
function ctx(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
}

beforeAll(async () => {
  await applyAll(env.TENANT_A_DB);
  await applyAll(env.TENANT_B_DB);
});

describe("REQ-169 — reconciliation sweep cron wrapper", () => {
  it("runReconSweep resolves across every allowlisted tenant when nothing is unbilled (no re-enqueue)", async () => {
    await expect(runReconSweep(env, () => FIRE_MS)).resolves.toBeUndefined();
  });

  it("scheduled() ACTUALLY drives the sweep (per-tenant sweep log emitted) — non-tautological", async () => {
    // Spy the per-tenant sweep log so deleting the runReconSweep call from scheduled() fails this test (not a
    // did-not-throw tautology). runReconSweep logs `recon-sweep: tenant <slug> → …` for every tenant.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await worker.scheduled(controller(), env, ctx());
      const sweepLogged = logSpy.mock.calls.some((call) => call.some((a) => typeof a === "string" && a.includes("recon-sweep: tenant")));
      expect(sweepLogged, "scheduled() must invoke runReconSweep").toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});
