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



  it("a MALFORMED policy row refuses as UNKNOWN_TENANT rather than throwing a SyntaxError", async () => {
    await env.CONTROL_DB
      .prepare("INSERT OR IGNORE INTO tenants (id, name, slug, plan, policy, created_ts) VALUES (?,?,?,?,?,0)")
      .bind("tr-bad-json", "tr-bad-json", "tr-bad-json", "pilot", "{not json")
      .run();
    await expect(resolveTenantDb(env, "tr-bad-json")).rejects.toThrow(/UNKNOWN_TENANT/);
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

// 2026-08-01 §12 — the regression pin the port omitted. Without it, reverting the 214 sweep's fan-out to
// the static roster leaves every test above green: the fix could not fail. The agents version caught a
// ninth fan-out hiding outside index.ts, so this globs EVERY src module rather than naming one.
describe("source-level pin — no translator fan-out may regress to the static roster (REQ-200/025)", () => {
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

  it("the static slug roster MIRRORS workers/api — the parity this file's header promises", async () => {
    const apiSrc = (await import("../../api/src/tenants.ts?raw")).default as string;
    const ownSrc = (await import("../src/tenants.ts?raw")).default as string;
    const slugs = (s: string): string[] => [...new Set([...s.matchAll(/"(tenant-[a-z0-9-]+)"/g)].map((m) => m[1]!))].sort();
    expect(slugs(ownSrc)).toEqual(slugs(apiSrc));
    expect([...TENANT_SLUGS].sort()).toEqual(slugs(ownSrc));
  });
});
