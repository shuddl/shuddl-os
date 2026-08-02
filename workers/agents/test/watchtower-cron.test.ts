import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { LedgerEvent } from "@shuddl/contracts";
import worker, { runWatchtower } from "../src/index.js";
import { applyAll, seedEvent } from "./helpers.js";

// WP-15 Task 8 (REQ-008) — the parity_drift auto-fallback CRON WRAPPER contract. The per-module BEHAVIOR is proven
// in workers/api/test/watchtower.test.ts (a migrated D1 + the projection-applying recording sequencer). This file
// pins the WIRING: scheduled() drives runWatchtower across the tenant allowlist, AND runWatchtower THREADS
// sequencerFor(env) into the sweep so the enforcement (auto-fallback) path is actually reachable — a regression
// dropping that 5th arg would silently disable auto-fallback in prod with no other failing test.
//
// NOTE: this package's SHIPMENT_SEQ is a STUB (vitest.config.ts — the real DO lives in the api worker), and actually
// touching it (instantiating the stub DO's SQLite storage) breaks the harness's isolated-storage rollback — which is
// why the mirror-cron test only exercises no-op sweeps. So we INTERCEPT SHIPMENT_SEQ.get: its being CALLED proves
// runWatchtower threaded the seq into the sweep's enforcement path (a native drift reached the append seam), and its
// throwing is contained by the rule's per-module try/catch — WITHOUT ever instantiating the stub DO. Dropping the 5th
// arg ⇒ seq undefined ⇒ no append ⇒ get never called ⇒ this test fails loudly. The agents D1 is ISOLATED per test
// (isolatedStorage on), so the seeded drift is deterministic (no cross-test pollution).

const FIRE_MS = Date.parse("2026-07-18T01:00:00Z");
function controller(scheduledTime = FIRE_MS): ScheduledController {
  return { scheduledTime, cron: "0 1 * * *", noRetry() {} };
}
function ctx(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
}

// A valid QuotePricedPayload whose sell (single line, Σ === sell) is the rating metric.
function ratingPayload(sell: number): Record<string, unknown> {
  return {
    sell,
    lines: [{ kind: "freight", code: "LINEHAUL", amount_cents: sell }],
    floors: { contribution: 1, full: 1, target: 1 },
    versions: { rate_config_ids: ["zt-cron"] },
    basis: {},
  };
}

let sn = 0;
async function seedRating(source: LedgerEvent["source"], sell: number): Promise<void> {
  await seedEvent(env.TENANT_A_DB, "quote.priced", {
    stream_id: `s:pdc-${source}-${sn}`,
    shipment_id: `pdc-${source}-${sn}`,
    seq: 0,
    source,
    payload: ratingPayload(sell),
  } as Partial<LedgerEvent>);
  sn += 1;
}

beforeAll(async () => {
  await applyAll(env.TENANT_A_DB);
  await applyAll(env.TENANT_B_DB);
});

describe("REQ-008 — parity_drift auto-fallback cron wrapper", () => {
  it("scheduled() ACTUALLY drives runWatchtower (per-tenant log emitted) — non-tautological", async () => {
    // Spy the per-tenant log so deleting the runWatchtower call from scheduled() fails this test (not a
    // did-not-throw tautology). runWatchtower logs `watchtower: tenant <slug> → …` for every tenant.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await worker.scheduled(controller(), env, ctx());
      const swept = logSpy.mock.calls.some((call) => call.some((a) => typeof a === "string" && a.includes("watchtower: tenant")));
      expect(swept, "scheduled() must invoke runWatchtower").toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("runWatchtower THREADS sequencerFor(env) into the sweep — a native drifting module ATTEMPTS the fallback append (dropping the 5th arg would skip enforcement)", async () => {
    // TENANT_A: rating promoted native + a native/legacy quote.priced divergence beyond the ±10% rating tolerance.
    await env.TENANT_A_DB.prepare(
      "INSERT INTO authority_map (module, authority, gates_status, flipped_events) VALUES ('rating','native','{}',json_array(?)) " +
        "ON CONFLICT(module) DO UPDATE SET authority = 'native', flipped_events = json_array(?)",
    )
      .bind("promo-cron", "promo-cron")
      .run();
    await seedRating("native", 1_000_000);
    await seedRating("legacy", 1_000);

    // Intercept SHIPMENT_SEQ.get so the append seam is reached WITHOUT instantiating the stub DO (which would break
    // isolated-storage rollback). Its being CALLED proves the seq was threaded; its throwing stands in for the stub's
    // inability to append and is contained by the rule's per-module try/catch (so runWatchtower still resolves).
    const getSpy = vi.spyOn(env.SHIPMENT_SEQ, "get").mockImplementation(() => {
      throw new Error("append seam reached (stubbed — real DO lives in the api worker)");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(runWatchtower(env, () => FIRE_MS)).resolves.toBeUndefined();
      // seq WAS threaded ⇒ the enforcement reached SHIPMENT_SEQ.get for the native drifting rating module.
      expect(getSpy, "runWatchtower must thread sequencerFor(env) so a native drift reaches the append seam").toHaveBeenCalled();
      // ...and the fault was CONTAINED (logged, not thrown) — the per-module + per-tenant try/catch.
      const contained = errSpy.mock.calls.some((c) =>
        c.some((a) => typeof a === "string" && a.includes("watchtower parity_drift") && a.includes("tenant-a/rating") && a.includes("fallback append failed")),
      );
      expect(contained).toBe(true);

      // 2026-08-02 §20 — CONTAINMENT IS NOT A REASON TO UNDER-REPORT. The alarm is raised BEFORE the
      // fallback is attempted, so on a failure the row used to say only "this module has drifted" while
      // omitting the more urgent half: it is STILL ON NATIVE AUTHORITY. "Retry next tick" is right for a
      // TRANSIENT fault, but not every fault is transient — a tenant whose control-plane policy is unusable
      // has every append REFUSED (§18/§19), so this append fails deterministically and every later tick
      // fails identically, silently, with only a log line. The alarm must carry the outcome.
      const alarm = await env.TENANT_A_DB.prepare(
        "SELECT detail FROM anomalies WHERE rule = 'parity_drift' AND object_id = 'rating' LIMIT 1",
      ).first<{ detail: string }>();
      expect(alarm, "the drift alarm must exist").not.toBeNull();
      const detail = JSON.parse(alarm!.detail) as { fell_back?: boolean; still_on_native?: boolean; fallback_error?: string };
      expect(detail.fell_back, "the alarm must say the fallback did NOT happen").toBe(false);
      expect(detail.still_on_native, "…and that the module is still on native authority").toBe(true);
      expect(detail.fallback_error, "…and carry the cause an operator needs").toContain("append seam reached");
    } finally {
      getSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
