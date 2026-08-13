import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi, afterEach } from "vitest";
import { applyMigrations } from "@shuddl/ledger/migrate";
import { allTenantSlugs, claimedTenantSlugs, resolveTenantDb, tenantDb, TENANT_SLUGS, POOL_BINDINGS } from "../src/tenants.js";
import { runMeteringSweep } from "../src/metering.js";
import type { BillingEnv } from "../src/tenants.js";
import { usageCreditsId, sweepTenantMetering } from "../src/metering.js";
import { usageCreditsId as contractsUsageCreditsId } from "@shuddl/contracts";
import controlSql from "../../../db/control/migrations/0001_control.sql?raw";
import { applyTenant, seedRun } from "./helpers.js";

// 2026-08-02 audit §13 — the billing port shipped in 29efbfa with ZERO tests, and its own source header
// claimed a parity pin that did not exist. Reverting the metering fan-out left all 45 billing tests green:
// the exact "the fix could not fail" defect the same commit had just fixed for the translator. This file is
// that gap closed — the same contract the agents/translator suites pin, on the worker where an unmetered
// claimed tenant is UNBILLED usage (REQ-121/123/122/025).

async function seed(id: string, slug: string, plan: string, policy: string): Promise<void> {
  await env.CONTROL_DB
    .prepare("INSERT OR IGNORE INTO tenants (id, name, slug, plan, policy, created_ts) VALUES (?,?,?,?,?,0)")
    .bind(id, slug, slug, plan, policy)
    .run();
}

beforeAll(async () => {
  const has = await env.CONTROL_DB.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='tenants'").first();
  if (has === null) await applyMigrations(env.CONTROL_DB, [{ path: "0001_control.sql", sql: controlSql }]);
  // The live meter-identity assertion runs the REAL sweep, which reads agent_runs ⋈ events.
  await applyTenant(env.TENANT_A_DB);
  await seed("bl-claimed-1", "bl-acme", "pilot", JSON.stringify({ pool_binding: "TENANT_POOL_01_DB" }));
  await seed("bl-claimed-2", "bl-beta", "spark", JSON.stringify({ pool_binding: "TENANT_POOL_02_DB" }));
  await seed("bl-sentinel", "_pool_88", "unclaimed", JSON.stringify({ pool_binding: "TENANT_POOL_01_DB" }));
  await seed("bl-platform", "_platform", "platform", "{}");
  await seed("bl-badbind", "bl-badbind", "pilot", JSON.stringify({ pool_binding: "CONTROL_DB" }));
  await seed("bl-badjson", "bl-badjson", "pilot", "{not json");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("billing resolveTenantDb — static hot path, claimed fallback, fail-closed misses (REQ-025)", () => {
  it("static slugs resolve without a control-plane read", async () => {
    expect(await resolveTenantDb(env, "tenant-a")).toBe(env.TENANT_A_DB);
    expect(await resolveTenantDb(env, "tenant-b")).toBe(env.TENANT_B_DB);
  });

  it("a CLAIMED pool tenant resolves to the binding its control row names", async () => {
    expect(await resolveTenantDb(env, "bl-acme")).toBe(env.TENANT_POOL_01_DB);
    expect(await resolveTenantDb(env, "bl-beta")).toBe(env.TENANT_POOL_02_DB);
  });

  it("sentinel, platform, unknown, out-of-allowlist binding, and MALFORMED policy all throw", async () => {
    for (const slug of ["_pool_88", "_platform", "bl-nobody", "bl-badbind", "bl-badjson"]) {
      await expect(resolveTenantDb(env, slug)).rejects.toThrow(/UNKNOWN_TENANT/);
    }
  });

  it("the sync static resolver is unchanged", () => {
    expect(tenantDb(env, "tenant-a")).toBe(env.TENANT_A_DB);
    expect(() => tenantDb(env, "bl-acme")).toThrow(/UNKNOWN_TENANT/);
  });
});

describe("billing enumeration — the metering sweep's fan-out (REQ-122/123)", () => {
  it("allTenantSlugs = static roster first, then claimed; sentinels and platform never enter", async () => {
    const all = await allTenantSlugs(env);
    expect(all.slice(0, TENANT_SLUGS.length)).toEqual([...TENANT_SLUGS]);
    expect(all).toContain("bl-acme");
    expect(all).toContain("bl-beta");
    for (const excluded of ["_pool_88", "_platform", "bl-badbind", "bl-badjson"]) {
      expect(all).not.toContain(excluded);
    }
    expect(new Set(all).size).toBe(all.length);
  });

  it("a control-plane fault degrades to the STATIC roster with a loud log — metering never stalls entirely", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { ...env, CONTROL_DB: { prepare: () => { throw new Error("D1_DOWN"); } } } as unknown as BillingEnv;
    expect(await allTenantSlugs(broken)).toEqual([...TENANT_SLUGS]);
    expect(spy.mock.calls.some((c) => String(c[0]).includes("claimed-tenant enumeration failed"))).toBe(true);
  });

  it("pool-binding exclusivity fails CLOSED — a duplicate excludes BOTH slugs (REQ-025)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await seed("bl-dup", "bl-dup", "pilot", JSON.stringify({ pool_binding: "TENANT_POOL_01_DB" }));
    const claimed = await claimedTenantSlugs(env);
    expect(claimed).not.toContain("bl-acme");
    expect(claimed).not.toContain("bl-dup");
    expect(claimed).toContain("bl-beta");
    expect(spy.mock.calls.some((c) => String(c[0]).includes("exclusivity VIOLATED"))).toBe(true);
  });
});

describe("billing parity + regression pins (the ones the port omitted)", () => {
  it("POOL_BINDINGS mirrors workers/api provision.ts", async () => {
    const apiSrc = (await import("../../api/src/provision.ts?raw")).default as string;
    const apiPools = [...new Set([...apiSrc.matchAll(/"(TENANT_POOL_[0-9]+_DB)"/g)].map((m) => m[1]))].sort();
    expect(apiPools).toEqual([...POOL_BINDINGS].sort());
  });

  it("the static slug roster MIRRORS workers/api — the parity this module's header promises", async () => {
    const apiSrc = (await import("../../api/src/tenants.ts?raw")).default as string;
    const ownSrc = (await import("../src/tenants.ts?raw")).default as string;
    const slugs = (s: string): string[] => [...new Set([...s.matchAll(/"(tenant-[a-z0-9-]+)"/g)].map((m) => m[1]!))].sort();
    expect(slugs(ownSrc)).toEqual(slugs(apiSrc));
    expect([...TENANT_SLUGS].sort()).toEqual(slugs(ownSrc));
  });

  it("NO src module iterates bare TENANT_SLUGS; at least one fans out over allTenantSlugs", async () => {
    const modules = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default" });
    let fanouts = 0;
    for (const [path, load] of Object.entries(modules)) {
      const src = (await load()) as string;
      // ALLOWLIST over the STATEMENT, not the line (2026-08-02 §18). Three cuts of this rule leaked:
      // an enumerated-method blacklist missed [...TENANT_SLUGS] / Array.from / an index loop /
      // .filter().map(); exempting any line starting with `export` let a five-shape probe pass 11/11; and
      // exempting any line MATCHING an import let `import {TENANT_SLUGS} from "./tenants.js"; export const
      // p = () => TENANT_SLUGS.map(f);` through on one line while flagging a Prettier-wrapped import and a
      // /** block comment */ mentioning the name. A line is simply the wrong unit. Strip comments and
      // import/export STATEMENTS from the source, then scan whatever is left: anything naming the roster
      // outside tenants.ts is a fan-out.
      const isRosterHome = /(^|\/)tenants\.ts$/.test(path);
      if (!isRosterHome) {
        const residue = src
          .replace(/\/\*[\s\S]*?\*\//g, " ") // block + jsdoc comments, however many lines
          .replace(/\/\/[^\n]*/g, " ") // line comments
          .replace(/\bimport\b[^;]*?\bfrom\b\s*["'][^"']*["']\s*;?/g, " ") // import ... from "..."; (wrapped or not)
          .replace(/\bexport\s*(?:\{[^}]*\}|\*)\s*(?:from\s*["'][^"']*["'])?\s*;?/g, " ") // export {..} / export * [from ".."];
          .replace(/\bexport\s+(?:declare\s+)?(?:const|let|var|type)\s+TENANT_SLUGS\b/g, " "); // the declaration itself
        expect(
          residue.match(/\bTENANT_SLUGS\b/g) ?? [],
          `${path} references TENANT_SLUGS outside tenants.ts — fan out over allTenantSlugs instead`,
        ).toEqual([]);
      }
      // §14: the claimed-tenant predicate is SHARED from @shuddl/contracts. A raw copy here is the
      // seven-literals drift this pin exists to prevent — a new reserved plan would reach only one worker.
      expect(src.includes("plan NOT IN"), `${path} inlines the claimed-tenant predicate instead of importing CLAIMED_TENANT_* from @shuddl/contracts`).toBe(false);
      fanouts += (src.match(/allTenantSlugs\(/g) ?? []).length;
    }
    expect(fanouts).toBeGreaterThanOrEqual(1);
  });

  it("the meter row identity is ONE shape across its three writers (§13 — provisioning had diverged)", async () => {
    // §15: this test used to assert two SOURCE-TEXT matches against workers/api/src/provision.ts. That was
    // both too weak and too brittle — reverting the `tenant_id` half of the divergence (binding the slot id
    // again) left it 11/11 green, while a mere parameter rename in provision.ts would have turned it red
    // with no behaviour change. The durable fix was structural: all three writers now import ONE
    // `usageCreditsId` from @shuddl/contracts, so identity agreement is a fact of the module graph rather
    // than something a test has to re-check by reading source. What remains here is that identity's shape
    // and its live round-trip through this worker's own writers.
    expect(usageCreditsId("bl-acme", "2026-08")).toBe("bl-acme:2026-08");
    expect(usageCreditsId("bl-acme", "2026-08")).toBe(contractsUsageCreditsId("bl-acme", "2026-08"));

    // Live: the sweep's own write lands under that identity, keyed by SLUG (not any internal row id), which
    // is what makes the three writers' `ON CONFLICT(id)` upserts converge on one row instead of forking.
    // §18: this block was `if (row) { … }` and the sweep wrote NO row, so both assertions inside were
    // unreachable — an assertion that cannot fail, introduced by the very commit that exists to close that
    // defect class. The sweep recomputes from `agent_runs ⋈ events`, so with an empty ledger there is
    // nothing to meter and nothing to write. Seed a run first, then assert unconditionally.
    const ts = Date.UTC(2026, 7, 15); // 2026-08
    await seedRun(env.TENANT_A_DB, "biller", ts);
    const summary = await sweepTenantMetering(env.TENANT_A_DB, env.CONTROL_DB, "bl-acme");
    expect(summary.runs, "the sweep must actually meter something for this to prove anything").toBeGreaterThan(0);

    const row = await env.CONTROL_DB.prepare("SELECT id, tenant_id, period FROM usage_credits WHERE tenant_id = ? LIMIT 1")
      .bind("bl-acme")
      .first<{ id: string; tenant_id: string; period: string }>();
    expect(row, "the sweep must have written a row under the SLUG").not.toBeNull();
    expect(row!.tenant_id).toBe("bl-acme");
    expect(row!.id).toBe(usageCreditsId("bl-acme", row!.period));
  });
});


// REQ-025 / REQ-278 — ONE TENANT'S FAILURE MUST NOT STARVE THE REST (audit §408).
//
// Every per-tenant sweep in this system — eleven of them across ~~four~~ THREE workers (§1312: agents 9,
// billing 1, translator 1; `api` carries tenant bindings but iterates no roster) — wraps its body in a
// try/catch INSIDE the `for (const slug of await allTenantSlugs(env))` loop, with `resolveTenantDb` inside
// the guard too, and the same comment: "re-run next tick — the sweep is idempotent". That containment is
// the only thing making a multi-tenant cron fair: without it, the FIRST tenant whose data throws aborts the
// loop and every tenant after it in slug order is silently never swept.
//
// Removing the containment from this sweep left all 57 billing tests GREEN — the property the eleven guards
// exist for was asserted nowhere. This pins it for one of them; the other ten are recorded as a bound.
describe("REQ-278: a per-tenant metering failure is contained, not fatal to the sweep", () => {
  it("a tenant whose D1 handle throws is logged and SKIPPED — runMeteringSweep still RESOLVES", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    // Poison one tenant's binding; the others resolve normally. With the per-tenant try/catch, the sweep logs
    // and continues, so the whole run RESOLVES. Without it the throw escapes `runMeteringSweep` — the promise
    // rejects, the cron tick dies, and every tenant after this one in slug order is silently never metered.
    const poisoned = { ...env, TENANT_A_DB: { prepare: () => { throw new Error("D1_DOWN"); } } } as unknown as BillingEnv;

    await expect(runMeteringSweep(poisoned), "an uncontained per-tenant failure would reject here").resolves.toBeUndefined();
    expect(spy.mock.calls.some((c) => String(c[0]).includes("tenant-a")), "the failing tenant is named in a loud log").toBe(true);
  });

  // §1312 — CONTINUATION, the half the comment above names as the property that matters ("every tenant after
  // it in slug order is silently never swept") while asserting only that the run RESOLVES. The two are NOT the
  // same: a catch that `break`s instead of `continue`s still resolves and still logs tenant-a, and skips every
  // later tenant. Closed for agents' nine sweeps at §1311; this is the billing member of the same eleven.
  //
  // WHAT PROVES CONTINUATION HERE IS A SECOND FAILURE LINE, NOT A SUCCESS LINE. MEASURED (§1312): this suite
  // migrates only `TENANT_A_DB` (`applyTenant` in beforeAll), so tenant-b has no tables and its sweep fails on
  // its own merits. Migrating it here would silently change what the live meter-identity assertion in this same
  // file sweeps, so the harness is left alone. tenant-b's failure line can only exist if tenant-a's fault did
  // NOT abort the iteration — which is exactly the property under test. Same adaptation the translator member
  // needs for a different reason (its poison is a SHARED R2 binding).
  it("the tenant AFTER the poisoned one is still REACHED — containment, not merely non-rejection", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const poisoned = { ...env, TENANT_A_DB: { prepare: () => { throw new Error("D1_DOWN"); } } } as unknown as BillingEnv;
      await runMeteringSweep(poisoned);

      const said = (n: string): boolean => errSpy.mock.calls.some((c) => String(c[0]).includes(n));
      expect(said("metering-sweep: tenant tenant-a failed"), "the injected fault never fired — this proves nothing").toBe(true);
      expect(said("metering-sweep: tenant tenant-b failed"), "tenant-b was never reached — tenant-a's fault aborted the loop").toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("the poisoned tenant is iterated FIRST — the premise the continuation assertion rests on", () => {
    // Poisoning the LAST tenant would satisfy the assertion above with the containment DELETED, since the throw
    // would land after every other tenant had been swept. Pinning the order keeps that degradation loud.
    expect(TENANT_SLUGS[0], "poisoning TENANT_A_DB no longer targets the first-swept tenant").toBe("tenant-a");
    expect(TENANT_SLUGS.length, "a single-tenant roster makes continuation unobservable").toBeGreaterThanOrEqual(2);
  });
});