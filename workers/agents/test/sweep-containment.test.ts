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
import type { AgentsEnv } from "../src/tenants.js";
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
  const SWEEPS: ReadonlyArray<readonly [string, (e: AgentsEnv) => Promise<void>]> = [
    ["runAllTenants", (e) => runAllTenants(e, () => new Date(FIRE_MS))],
    ["runSlaSweep", (e) => runSlaSweep(e, () => FIRE_MS)],
    ["runReconSweep", (e) => runReconSweep(e, () => FIRE_MS)],
    ["runCreditReconSweep", (e) => runCreditReconSweep(e)],
    ["runCollectorSweep", (e) => runCollectorSweep(e, () => FIRE_MS)],
    ["runWatchtower", (e) => runWatchtower(e, () => FIRE_MS)],
    ["runRetentionSweep", (e) => runRetentionSweep(e, () => FIRE_MS)],
    ["runMirrorSweep", (e) => runMirrorSweep(e, () => FIRE_MS)],
    // Not in index.ts — its own module, same shape. Included here rather than in a second file because the
    // property and the harness are identical; the bound §408 filed counts sweeps, not files.
    //
    // NOTE the DIFFERENT clock: this sweep opens with `if (!isSnapshotDay(at)) return` — a weekly gate
    // (SNAPSHOT_DOW = Monday) that makes a daily cron weekly. Driving it with FIRE_MS (a Wednesday) returns
    // BEFORE the loop, so nothing is swept and nothing is logged. The first version of this row did exactly
    // that and the non-vacuity assertion below caught it: the sweep "resolved", and no tenant had failed
    // because no tenant had been visited (audit §410). SNAPSHOT_MS is a Monday, so the loop actually runs.
    ["runWatchtowerSnapshots", (e) => runWatchtowerSnapshots(e, () => SNAPSHOT_MS)],
  ];

  it.each(SWEEPS)("%s RESOLVES when one tenant's D1 throws — the tick survives", async (_name, run) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(run(poisonOneTenant()), "an uncontained per-tenant failure would reject here").resolves.toBeUndefined();

    // Non-vacuity: the failure must actually have been REACHED and logged, not skipped by an empty roster or
    // an early return. Without this the test would pass against a sweep that iterated nothing at all.
    expect(errors.mock.calls.some((c) => String(c[0]).includes("tenant-a")), "the failing tenant must be named in a loud log").toBe(true);

    vi.restoreAllMocks();
  });
});
