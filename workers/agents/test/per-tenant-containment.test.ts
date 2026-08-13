import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  runAllTenants,
  runSlaSweep,
  runReconSweep,
  runCreditReconSweep,
  runCollectorSweep,
  runWatchtower,
  runRetentionSweep,
  runMirrorSweep,
} from "../src/index.js";
import { TENANT_SLUGS, type AgentsEnv } from "../src/tenants.js";
import { applyAll } from "./helpers.js";

// §1310 (REQ-025/032/042/095/169) — ONE TENANT'S FAULT MUST NOT STALL THE REST, ASSERTED FOR EVERY WRAPPER.
//
// Eight cron wrappers in `index.ts` carry the identical sentence — *"a per-tenant fault is contained + logged so
// one tenant never stalls the rest"* — and §1309 measured that NO cron test injected a failing tenant. The
// per-PARTY catch one level down was pinned at §1309; this is the same claim one level up, and audit §1308's
// starvation analysis rests on it (a tenant that exhausts the subrequest budget is exactly a throwing tenant).
//
// WHY BREAK TENANT-A AND NOT TENANT-B. `TENANT_SLUGS = Object.keys(TENANT_BINDINGS)` is insertion-ordered, so
// `tenant-a` is iterated FIRST. Breaking the LAST tenant would leave every assertion below passing with the
// catch deleted — the throw would happen after the healthy tenant had already been swept, which is the
// shared-outcome blindness §1281 named. Breaking the FIRST tenant makes the healthy tenant's success log
// reachable ONLY through the catch.
//
// TWO ASSERTIONS PER WRAPPER, and they prove different things:
//   1. the wrapper RESOLVES rather than rejects — the containment itself, order-independent;
//   2. the healthy tenant's log still appears — the CONTINUATION, which (1) alone cannot distinguish.
// The daily anchor has no per-tenant success log (it logs only on failure), so it gets (1) plus the error log,
// and that limit is stated rather than papered over.

const FIRE_MS = Date.parse("2026-07-18T01:00:00Z");

/** A D1 whose every statement throws at `prepare` — the coarsest possible tenant-level fault. */
function brokenDb(): D1Database {
  const boom = (): never => {
    throw new Error("D1_DOWN");
  };
  return { prepare: boom, batch: boom, exec: boom, dump: boom, withSession: boom } as unknown as D1Database;
}

/** The real env with tenant-a's binding replaced — every other binding (R2, DOs, queues) stays live. */
function envWithBrokenA(): AgentsEnv {
  return { ...env, TENANT_A_DB: brokenDb() } as unknown as AgentsEnv;
}

interface Wrapper {
  readonly name: string;
  readonly run: (e: AgentsEnv) => Promise<void>;
  /** Substring proving the FAILING tenant was contained (console.error). */
  readonly errLog: string;
  /** Substring proving the HEALTHY tenant still ran (console.log); null where the wrapper logs no success. */
  readonly okLog: string | null;
}

// Slug-qualified on purpose: "recon-sweep: tenant" is a SUBSTRING of "credit-recon-sweep: tenant", so an
// unqualified match would let one wrapper's log satisfy another's assertion.
const WRAPPERS: readonly Wrapper[] = [
  // THE ANCHOR CONTAINS ITS OWN FAULTS, one layer lower. MEASURED (§1310): with tenant-a's D1 throwing on
  // every statement, `runAllTenants`'s catch never fires — because `runDailyAnchor` handles the fault itself
  // and RETURNS rather than throwing, logging `[REQ-014] anchor run (tenant X) … NOTHING was anchored` plus a
  // second line when the failure-recording write fails too (the correlated fault: the same broken D1 owns both
  // the day and the failure record). So the containment claim HOLDS for this wrapper; the observable signal
  // just comes from a different layer, and asserting the wrapper's own message would have pinned a line that
  // only a resolveTenantDb/tsaFor fault can reach. Its `okLog` is null: the anchor emits no per-tenant success
  // line, so CONTINUATION is not observable through logs here — the other seven wrappers carry that property.
  { name: "runAllTenants (daily anchor)", run: (e) => runAllTenants(e, () => new Date(FIRE_MS)), errLog: "[REQ-014] anchor run (tenant tenant-a)", okLog: null },
  { name: "runSlaSweep", run: (e) => runSlaSweep(e, () => FIRE_MS), errLog: "concierge sla-sweep: tenant tenant-a failed", okLog: "concierge sla-sweep: tenant tenant-b" },
  { name: "runReconSweep", run: (e) => runReconSweep(e, () => FIRE_MS), errLog: "recon-sweep: tenant tenant-a failed", okLog: "recon-sweep: tenant tenant-b" },
  { name: "runCreditReconSweep", run: (e) => runCreditReconSweep(e), errLog: "credit-recon-sweep: tenant tenant-a failed", okLog: "credit-recon-sweep: tenant tenant-b" },
  { name: "runCollectorSweep", run: (e) => runCollectorSweep(e, () => FIRE_MS), errLog: "collector dunning-sweep: tenant tenant-a failed", okLog: "collector dunning-sweep: tenant tenant-b" },
  { name: "runWatchtower", run: (e) => runWatchtower(e, () => FIRE_MS), errLog: "watchtower: tenant tenant-a failed", okLog: "watchtower: tenant tenant-b" },
  { name: "runRetentionSweep", run: (e) => runRetentionSweep(e, () => FIRE_MS), errLog: "retention-sweep: tenant tenant-a failed", okLog: "retention-sweep: tenant tenant-b" },
  { name: "runMirrorSweep", run: (e) => runMirrorSweep(e, () => FIRE_MS), errLog: "legacy-mirror: tenant tenant-a failed", okLog: "legacy-mirror: tenant tenant-b" },
];

function said(spy: ReturnType<typeof vi.spyOn>, needle: string): boolean {
  return spy.mock.calls.some((call) => call.some((a) => typeof a === "string" && a.includes(needle)));
}

beforeAll(async () => {
  await applyAll(env.TENANT_A_DB);
  await applyAll(env.TENANT_B_DB);
});

describe("§1310 REQ-025: a broken tenant is contained by every cron wrapper", () => {
  for (const w of WRAPPERS) {
    it(`${w.name} — tenant-a throws, the wrapper still RESOLVES and tenant-b is still swept`, async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        // (1) THE CONTAINMENT. Without the per-tenant catch this rejects with D1_DOWN.
        await expect(w.run(envWithBrokenA()), `${w.name} let one tenant's fault escape the cron`).resolves.toBeUndefined();

        // NON-VACUITY: a wrapper that never touched the broken binding would pass (1) trivially. This proves
        // the injected fault was actually reached and actually caught.
        expect(said(errSpy, w.errLog), `${w.name}: the broken tenant was never reached — this test proves nothing`).toBe(true);

        // (2) THE CONTINUATION. tenant-a is iterated FIRST, so a missing catch would abort before tenant-b.
        if (w.okLog !== null) {
          expect(said(logSpy, w.okLog), `${w.name}: the healthy tenant was skipped — the fault aborted the loop`).toBe(true);
        }
      } finally {
        errSpy.mockRestore();
        logSpy.mockRestore();
      }
    });
  }

  it("the roster really is tenant-a-first — the premise the continuation assertions rest on", () => {
    // If a future edit reorders TENANT_BINDINGS, the tests above silently weaken to "the last tenant threw",
    // which passes with the catch deleted. Pinning the premise keeps that failure loud instead of silent.
    expect(TENANT_SLUGS[0], "tenant-a is no longer iterated first — the continuation assertions above are now vacuous").toBe("tenant-a");
    expect(TENANT_SLUGS.length, "the roster shrank to one tenant — continuation is unobservable").toBeGreaterThanOrEqual(2);
  });
});
