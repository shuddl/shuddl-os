import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureSchema, ensureTenantBSchema, token } from "./helpers.js";
import { TENANT_BINDINGS, tenantDb, resolvePlatformTenantDb } from "../src/tenants.js";
import { PLATFORM_TENANT_ID, isPlatformTenant, assertNotPlatformTenant } from "@shuddl/contracts";
import { ApiError } from "../src/middleware/error.js";

// REQ-123/025 (WP-14 Task 1): the reserved PLATFORM revenue tenant is the single highest-risk new artifact —
// a new cross-tenant read surface (the credits ledger will live here). It MUST be isolated in BOTH directions:
//   (forward) NO customer session / route / lens can resolve or read it.
//   (reverse) a read on the platform D1 cannot enumerate or reach any customer tenant.
// This suite runs on every merge alongside isolation.test.ts, forever.

const PLATFORM_MARKER = "MARKER-PLATFORM-TENANT";

beforeAll(async () => {
  await ensureSchema(env); // seeds the control plane + tenant-a
  await ensureTenantBSchema(env);
  // Customer probe markers (mirrors isolation.test.ts) so the reverse-direction proof has customer rows to
  // (fail to) reach from the platform D1.
  for (const [db, marker] of [
    [env.TENANT_A_DB, "MARKER-TENANT-A"],
    [env.TENANT_B_DB, "MARKER-TENANT-B"],
  ] as const) {
    await db.exec("CREATE TABLE IF NOT EXISTS probe (tenant TEXT NOT NULL)");
    await db.prepare("INSERT INTO probe (tenant) VALUES (?)").bind(marker).run();
  }
  // The platform tenant's OWN D1 (a physically separate binding) gets its own probe marker.
  const platform = resolvePlatformTenantDb(env);
  await platform.exec("CREATE TABLE IF NOT EXISTS probe (tenant TEXT NOT NULL)");
  await platform.prepare("INSERT INTO probe (tenant) VALUES (?)").bind(PLATFORM_MARKER).run();
});

// ---- FORWARD: a customer can NEVER resolve or read the platform tenant -------------------------------
describe("forward isolation: no customer path resolves the platform tenant (REQ-025)", () => {
  it("tenantDb(env, PLATFORM_TENANT_ID) throws FORBIDDEN — the customer resolver never binds it", () => {
    let thrown: unknown;
    try {
      tenantDb(env, PLATFORM_TENANT_ID);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).code).toBe("FORBIDDEN");
    expect((thrown as ApiError).status).toBe(403);
  });

  it("the platform id is NOT a key in TENANT_BINDINGS (the customer allowlist)", () => {
    expect(Object.keys(TENANT_BINDINGS)).not.toContain(PLATFORM_TENANT_ID);
    expect(isPlatformTenant(PLATFORM_TENANT_ID)).toBe(true);
    // Nothing the allowlist binds is the platform tenant (subset parity holds in both directions).
    for (const slug of Object.keys(TENANT_BINDINGS)) expect(isPlatformTenant(slug)).toBe(false);
  });

  it("a customer JWT carrying tenant=<platform> cannot resolve — /v1/_probe is a 403 (never a read)", async () => {
    // SessionClaims.tenant is a free string, so a forged/mis-provisioned token PARSES; the fail-closed
    // guard is in tenantDb, which rejects the platform slug BEFORE any D1 handle exists.
    const t = await token({ sub: "attacker", tenant: PLATFORM_TENANT_ID, role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/_probe", { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).not.toContain(PLATFORM_MARKER); // no platform data leaks through the rejected read
  });

  it("assertNotPlatformTenant rejects the platform id where a customer slug is expected (provisioning/claim)", () => {
    // A signup/intake tenant-claim path calls this to fail-closed-reject a claim on the reserved id.
    expect(() => assertNotPlatformTenant(PLATFORM_TENANT_ID)).toThrow(/PLATFORM_TENANT_FORBIDDEN/);
    expect(() => assertNotPlatformTenant("tenant-a")).not.toThrow();
  });
});

// ---- SERVER-SIDE-ONLY resolution: the platform D1 is reachable only via the internal resolver ---------
describe("the platform D1 is reachable ONLY via the internal resolvePlatformTenantDb (REQ-025)", () => {
  it("resolvePlatformTenantDb(env) returns the reserved binding, distinct from every customer binding", () => {
    const platform = resolvePlatformTenantDb(env);
    expect(platform).toBeDefined();
    // It is a DIFFERENT physical handle than any customer D1 the allowlist binds.
    expect(platform).not.toBe(env.TENANT_A_DB);
    expect(platform).not.toBe(env.TENANT_B_DB);
    expect(platform).not.toBe(env.CONTROL_DB);
  });

  it("no customer slug routed through tenantDb ever returns the platform binding", () => {
    const platform = resolvePlatformTenantDb(env);
    for (const slug of Object.keys(TENANT_BINDINGS)) {
      expect(tenantDb(env, slug)).not.toBe(platform);
    }
  });
});

// ---- REVERSE: a read on the platform D1 cannot enumerate / reach customer tenants --------------------
describe("reverse isolation: the platform D1 cannot reach any customer tenant (REQ-025)", () => {
  it("the platform D1 holds ONLY the platform marker — no customer marker is reachable", async () => {
    const platform = resolvePlatformTenantDb(env);
    const rows = await platform.prepare("SELECT tenant FROM probe").all<{ tenant: string }>();
    const markers = rows.results.map((r) => r.tenant);
    expect(markers).toContain(PLATFORM_MARKER);
    expect(markers).not.toContain("MARKER-TENANT-A");
    expect(markers).not.toContain("MARKER-TENANT-B");
  });

  it("the platform D1 has no customer control-plane tables — it cannot enumerate tenants", async () => {
    const platform = resolvePlatformTenantDb(env);
    // The `tenants` roster lives in the SEPARATE control plane (CONTROL_DB), never in the platform tenant's
    // own D1. A query against the platform D1 for a customer roster hits no such table (a reverse-read of the
    // customer directory is impossible from here).
    const row = await platform
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tenants'")
      .first<{ name: string }>();
    expect(row).toBeNull();
  });

  it("no customer D1 can see the platform marker (physical separation, both ways)", async () => {
    for (const db of [env.TENANT_A_DB, env.TENANT_B_DB] as const) {
      const rows = await db.prepare("SELECT tenant FROM probe").all<{ tenant: string }>();
      expect(rows.results.map((r) => r.tenant)).not.toContain(PLATFORM_MARKER);
    }
  });
});
