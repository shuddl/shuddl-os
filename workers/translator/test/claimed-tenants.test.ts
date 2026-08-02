import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi, afterEach } from "vitest";
import { allTenantSlugs, claimedTenantSlugs, resolveTenantDb, tenantDb, TENANT_SLUGS, POOL_BINDINGS } from "../src/tenants.js";
import type { TranslatorEnv } from "../src/tenants.js";
import { applyMigrations } from "@shuddl/ledger/migrate";
import controlSql from "../../../db/control/migrations/0001_control.sql?raw";

// 2026-08-01 audit §11 — the LAST instance of the C3 roster class. The agents worker gained claimed-tenant
// resolution on 2026-08-01; the translator kept a static two-slug roster, so a claimed pool tenant's
// outbound 214s could never be swept and its inbound 204 could not resolve a database. Same contract,
// same fail-closed shape, same parity law (REQ-121/123/025/200).

beforeAll(async () => {
  // The same idempotent control-schema idiom the isolation suite uses (one D1 shared across files).
  const hasTenants = await env.CONTROL_DB.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='tenants'").first();
  if (hasTenants === null) await applyMigrations(env.CONTROL_DB, [{ path: "0001_control.sql", sql: controlSql }]);
  const seed = async (id: string, slug: string, plan: string, policy: string): Promise<void> => {
    await env.CONTROL_DB
      .prepare("INSERT OR IGNORE INTO tenants (id, name, slug, plan, policy, created_ts) VALUES (?,?,?,?,?,0)")
      .bind(id, slug, slug, plan, policy)
      .run();
  };
  await seed("tr-claimed-1", "tr-acme", "pilot", JSON.stringify({ pool_binding: "TENANT_POOL_01_DB" }));
  await seed("tr-claimed-2", "tr-beta", "spark", JSON.stringify({ pool_binding: "TENANT_POOL_02_DB" }));
  await seed("tr-sentinel", "_pool_77", "unclaimed", JSON.stringify({ pool_binding: "TENANT_POOL_01_DB" }));
  await seed("tr-bad", "tr-bad", "pilot", JSON.stringify({ pool_binding: "CONTROL_DB" }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("translator resolveTenantDb — static hot path, claimed fallback, fail-closed misses (REQ-025)", () => {
  it("static slugs resolve to their bindings without a control-plane read", async () => {
    expect(await resolveTenantDb(env, "tenant-a")).toBe(env.TENANT_A_DB);
    expect(await resolveTenantDb(env, "tenant-b")).toBe(env.TENANT_B_DB);
  });

  it("a CLAIMED pool tenant resolves to the pool binding its control row names", async () => {
    expect(await resolveTenantDb(env, "tr-acme")).toBe(env.TENANT_POOL_01_DB);
    expect(await resolveTenantDb(env, "tr-beta")).toBe(env.TENANT_POOL_02_DB);
  });

  it("a sentinel, an out-of-allowlist binding, an unknown slug, and the platform tenant ALL throw", async () => {
    for (const slug of ["_pool_77", "tr-bad", "tr-nobody", "_platform"]) {
      await expect(resolveTenantDb(env, slug)).rejects.toThrow(/UNKNOWN_TENANT/);
    }
  });

  it("the sync static resolver is unchanged", () => {
    expect(tenantDb(env, "tenant-a")).toBe(env.TENANT_A_DB);
    expect(() => tenantDb(env, "tr-acme")).toThrow(/UNKNOWN_TENANT/);
  });
});

describe("translator enumeration — the 214 sweep's fan-out (REQ-200/025)", () => {
  it("allTenantSlugs = static roster first, then claimed, deduped", async () => {
    const all = await allTenantSlugs(env);
    expect(all.slice(0, TENANT_SLUGS.length)).toEqual([...TENANT_SLUGS]);
    expect(all).toContain("tr-acme");
    expect(all).toContain("tr-beta");
    expect(all).not.toContain("_pool_77");
    expect(all).not.toContain("tr-bad");
    expect(new Set(all).size).toBe(all.length);
  });

  it("a control-plane fault degrades to the STATIC roster with a loud log — sweeping is never hostage to enumeration", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { ...env, CONTROL_DB: { prepare: () => { throw new Error("D1_DOWN"); } } } as unknown as TranslatorEnv;
    expect(await allTenantSlugs(broken)).toEqual([...TENANT_SLUGS]);
    expect(spy.mock.calls.some((c) => String(c[0]).includes("claimed-tenant enumeration failed"))).toBe(true);
  });

  it("pool-binding exclusivity fails CLOSED — two claimed rows on ONE binding exclude both", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await env.CONTROL_DB
      .prepare("INSERT OR IGNORE INTO tenants (id, name, slug, plan, policy, created_ts) VALUES (?,?,?,?,?,0)")
      .bind("tr-dup", "tr-dup", "tr-dup", "pilot", JSON.stringify({ pool_binding: "TENANT_POOL_01_DB" }))
      .run();
    const claimed = await claimedTenantSlugs(env);
    expect(claimed).not.toContain("tr-acme");
    expect(claimed).not.toContain("tr-dup");
    expect(claimed).toContain("tr-beta");
    expect(spy.mock.calls.some((c) => String(c[0]).includes("exclusivity VIOLATED"))).toBe(true);
  });
});

describe("parity — the translator's pool allowlist matches the api's (the roster parity law)", () => {
  it("POOL_BINDINGS mirrors workers/api provision.ts", async () => {
    const apiProvision = (await import("../../api/src/provision.ts?raw")).default as string;
    const apiPools = [...new Set([...apiProvision.matchAll(/"(TENANT_POOL_[0-9]+_DB)"/g)].map((m) => m[1]))].sort();
    expect(apiPools).toEqual([...POOL_BINDINGS].sort());
  });
});
