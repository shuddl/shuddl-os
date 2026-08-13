import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  runAllTenants,
  runCollectorSweep,
  runCreditReconSweep,
  runMirrorSweep,
  runReconSweep,
  runRetentionSweep,
  runSlaSweep,
  runWatchtower,
} from "../src/index.js";
import { runWatchtowerSnapshots } from "../src/watchtower-snapshot.js";
import { TENANT_SLUGS, type AgentsEnv } from "../src/tenants.js";
import { applyAll } from "./helpers.js";

// REQ-025 / REQ-278 — ONE TENANT'S FAILURE MUST NOT KILL THE TICK (audit §409).
//
// Eleven per-tenant sweeps across four workers share one shape: a try/catch INSIDE
// `for (const slug of await allTenantSlugs(env))`, with `resolveTenantDb` within the guard and the roster
// load outside it. That containment is the only thing making a multi-tenant cron fair — without it the FIRST
// tenant whose data throws aborts the loop, and every tenant after it in slug order is silently never swept.
//
// WHY THIS FILE EXISTS. §408 removed the containment from `billing/metering.ts` and all 57 billing tests
// stayed GREEN: the property eleven guards exist for was asserted nowhere. It pinned one of the eleven and
// filed the rest as a counted bound, noting the work was "mechanical and identical". This is that work, for
// the eight in `workers/agents` — the largest cluster, and the one where a lost tick costs the most (SLA
// notices, dunning drafts, retention deletes, the authority-drift watch).
//
// THE ASSERTION IS DELIBERATELY THE WEAK ONE. "Later tenants are still swept" is the property we want; it is
// also entangled with slug order and log spies (§408 could not make it work quickly, and shipping a test one
// cannot make correct is how a vacuous test gets written — §396). What discriminates containment from its
// absence is simpler and total: an uncontained loop REJECTS, a contained one RESOLVES. The mutation proves
// each of these fires, which is the whole requirement for a pin.

const FIRE_MS = Date.parse("2026-07-15T01:00:00Z");
/** A MONDAY — `runWatchtowerSnapshots` is gated on SNAPSHOT_DOW and returns immediately on any other day. */
const SNAPSHOT_MS = Date.parse("2026-07-13T01:00:00Z");

/** A tenant binding that throws the moment the sweep touches it — a D1 outage for exactly one tenant. */
function poisonOneTenant(): AgentsEnv {
  return {
    ...env,
    TENANT_A_DB: {
      prepare: () => {
        throw new Error("D1_DOWN");
      },
    },
  } as unknown as AgentsEnv;
}

beforeAll(async () => {
  await applyAll(env.TENANT_A_DB);
  await applyAll(env.TENANT_B_DB);
});

describe("REQ-278: every agents sweep contains a per-tenant failure (audit §409)", () => {
  // Each entry is a sweep and how it is invoked. Signatures differ (`now` is a Date for runAllTenants, a
  // number elsewhere, absent on runCreditReconSweep), so the call is written per row rather than inferred —
  // an it.each over a shared caller would silently skip a sweep whose signature drifted.
  // §1311 — the third column is the HEALTHY tenant's success log, the continuation half §409 deferred (see
  // the CONTINUATION note above). `null` where a sweep emits no per-tenant success line.
  const SWEEPS: ReadonlyArray<readonly [string, (e: AgentsEnv) => Promise<void>, string | null]> = [
    // The anchor logs ONLY on failure — no per-tenant success line exists to observe, so continuation is
    // unobservable through logs here (measured §1310; its fault surfaces as `[REQ-014] anchor run (tenant …)`
    // from runDailyAnchor, which contains its own faults and RETURNS rather than throwing).
    ["runAllTenants", (e) => runAllTenants(e, () => new Date(FIRE_MS)), null],
    ["runSlaSweep", (e) => runSlaSweep(e, () => FIRE_MS), "concierge sla-sweep: tenant tenant-b"],
    ["runReconSweep", (e) => runReconSweep(e, () => FIRE_MS), "recon-sweep: tenant tenant-b"],
    ["runCreditReconSweep", (e) => runCreditReconSweep(e), "credit-recon-sweep: tenant tenant-b"],
    ["runCollectorSweep", (e) => runCollectorSweep(e, () => FIRE_MS), "collector dunning-sweep: tenant tenant-b"],
    ["runWatchtower", (e) => runWatchtower(e, () => FIRE_MS), "watchtower: tenant tenant-b"],
    ["runRetentionSweep", (e) => runRetentionSweep(e, () => FIRE_MS), "retention-sweep: tenant tenant-b"],
    ["runMirrorSweep", (e) => runMirrorSweep(e, () => FIRE_MS), "legacy-mirror: tenant tenant-b"],
    // Not in index.ts — its own module, same shape. Included here rather than in a second file because the
    // property and the harness are identical; the bound §408 filed counts sweeps, not files.
    //
    // NOTE the DIFFERENT clock: this sweep opens with `if (!isSnapshotDay(at)) return` — a weekly gate
    // (SNAPSHOT_DOW = Monday) that makes a daily cron weekly. Driving it with FIRE_MS (a Wednesday) returns
    // BEFORE the loop, so nothing is swept and nothing is logged. The first version of this row did exactly
    // that and the non-vacuity assertion below caught it: the sweep "resolved", and no tenant had failed
    // because no tenant had been visited (audit §410). SNAPSHOT_MS is a Monday, so the loop actually runs.
    ["runWatchtowerSnapshots", (e) => runWatchtowerSnapshots(e, () => SNAPSHOT_MS), "watchtower-snapshot: tenant tenant-b"],
  ];

  it.each(SWEEPS)("%s RESOLVES when one tenant's D1 throws — the tick survives", async (_name, run, okLog) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(run(poisonOneTenant()), "an uncontained per-tenant failure would reject here").resolves.toBeUndefined();

    // Non-vacuity: the failure must actually have been REACHED and logged, not skipped by an empty roster or
    // an early return. Without this the test would pass against a sweep that iterated nothing at all.
    expect(errors.mock.calls.some((c) => String(c[0]).includes("tenant-a")), "the failing tenant must be named in a loud log").toBe(true);

    // §1311 — CONTINUATION, the half §409 named as "the property we want" and deferred as entangled. It is
    // only observable because the POISONED tenant is iterated FIRST (`TENANT_SLUGS[0]`, pinned below): poison
    // the LAST tenant instead and this assertion passes with the containment DELETED, since the throw would
    // land after the healthy tenant was already swept. That is why the premise gets its own test.
    if (okLog !== null) {
      expect(
        logs.mock.calls.some((c) => c.some((a) => typeof a === "string" && a.includes(okLog))),
        "the healthy tenant was never swept — the first tenant's fault aborted the loop",
      ).toBe(true);
    }

    vi.restoreAllMocks();
  });

  it("the poisoned tenant is iterated FIRST — the premise every continuation assertion rests on", () => {
    // Reordering TENANT_BINDINGS would not fail any assertion above; it would quietly turn each of them into
    // "the last tenant threw", which a deleted containment also satisfies. Pinning the premise keeps that
    // degradation loud (§1281 shared-outcome blindness).
    expect(TENANT_SLUGS[0], "poisonOneTenant() breaks TENANT_A_DB, which is no longer swept first").toBe("tenant-a");
    expect(TENANT_SLUGS.length, "a single-tenant roster makes continuation unobservable").toBeGreaterThanOrEqual(2);
  });
});
