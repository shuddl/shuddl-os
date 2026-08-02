import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi, afterEach } from "vitest";
import { applyMigrations } from "@shuddl/ledger/migrate";
import { allTenantSlugs, claimedTenantSlugs, resolveTenantDb, tenantDb, TENANT_SLUGS, POOL_BINDINGS } from "../src/tenants.js";
import type { BillingEnv } from "../src/tenants.js";
import { usageCreditsId } from "../src/metering.js";
import controlSql from "../../../db/control/migrations/0001_control.sql?raw";

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
      // The matcher covers EVERY iteration form, not just for-of: a `TENANT_SLUGS.map(...)` fan-out
      // (the shape Promise.all sweeps take) slipped straight through the for-of-only version. Spread and
      // Set construction stay legal — tenants.ts itself builds allTenantSlugs out of them.
      const ITERATES = /(?:\bof TENANT_SLUGS\b|TENANT_SLUGS\s*\.\s*(?:forEach|map|flatMap|reduce|some|every|entries|values|keys)\s*\()/g;
      expect(src.match(ITERATES), `${path} iterates the static roster`).toBeNull();
      fanouts += (src.match(/allTenantSlugs\(/g) ?? []).length;
    }
    expect(fanouts).toBeGreaterThanOrEqual(1);
  });

  it("the meter row identity is ONE shape across its three writers (§13 — provisioning had diverged)", async () => {
    // The sweep, the Stripe credit stamp and provisioning must key usage_credits identically, or a claimed
    // tenant carries two rows under two identities (one of them permanently empty).
    expect(usageCreditsId("bl-acme", "2026-08")).toBe("bl-acme:2026-08");
    const apiSrc = (await import("../../api/src/provision.ts?raw")).default as string;
    expect(apiSrc).toContain("usageCreditsIdFor(slug, billingPeriod)");
    expect(apiSrc).toMatch(/return `\$\{tenantSlug\}:\$\{period\}`/);
  });
});
