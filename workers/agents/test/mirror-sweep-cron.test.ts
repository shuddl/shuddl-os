import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import worker, { runMirrorSweep } from "../src/index.js";
import { applyAll } from "./helpers.js";

// REQ-021/022/035 / REQ-025 — the legacy-mirror sweep's CRON WRAPPER contract (the per-tenant BEHAVIOR is proven
// in test/mirror-sweep.test.ts against a migrated D1 + an injected recording sequencer). This file pins that the
// wrapper iterates the tenant allowlist and that scheduled() drives it. FAIL-CLOSED: with no wired feed/
// integration row the sweep no-ops (never calls the stubbed SHIPMENT_SEQ), so it completes cleanly across BOTH
// allowlisted tenants (both DBs migrated so the per-tenant integrations SELECT does not crash).

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

describe("REQ-021/022/035 — legacy-mirror sweep cron wrapper", () => {
  it("runMirrorSweep resolves across every allowlisted tenant when no feed is wired (fail-closed no-op)", async () => {
    await expect(runMirrorSweep(env, () => FIRE_MS)).resolves.toBeUndefined();
  });

  it("scheduled() ACTUALLY drives the sweep (per-tenant log emitted) — non-tautological", async () => {
    // Spy the per-tenant log so deleting the runMirrorSweep call from scheduled() fails this test (not a
    // did-not-throw tautology). runMirrorSweep logs `legacy-mirror: tenant <slug> → …` for every tenant.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await worker.scheduled(controller(), env, ctx());
      const swept = logSpy.mock.calls.some((call) => call.some((a) => typeof a === "string" && a.includes("legacy-mirror: tenant")));
      expect(swept, "scheduled() must invoke runMirrorSweep").toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});
