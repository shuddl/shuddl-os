import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "@shuddl/ledger/migrate";
import platformSql from "../../../db/control/migrations/0002_platform_tenant.sql?raw";
import controlPoolSql from "../../../db/control/migrations/0003_tenant_pool.sql?raw";
import { ensureSchema, ensureTenantBSchema } from "./helpers.js";
import {
  provisionTenant,
  resolveClaimedTenantDb,
  provisioningEnabled,
  ProvisionError,
  POOL_BINDINGS,
} from "../src/provision.js";
import { TENANT_BINDINGS, tenantDb } from "../src/tenants.js";
import { PLATFORM_TENANT_ID } from "@shuddl/contracts";
import type { Env } from "../src/index.js";

// REQ-121/025 (WP-14 Task 2): pool-based DYNAMIC tenant provisioning, FLAG-GATED DARK. A stranger becomes a
// provisioned tenant by CLAIMING one of a pool of pre-provisioned, migrated tenant D1s (bindings are static in
// a Worker, so provisioning cannot mint a binding — it claims a reserved one). The whole path is fail-closed
// behind a server-side flag that is OFF by DEFAULT — no self-serve provisioning happens until R4.
//
// The claimed-registry is the EXISTING `tenants` control table (no new table, I8 budget stays 21/22): each pool
// slot is a reserved `tenants` row (id/slug `_pool_0N`, plan `unclaimed`, policy.pool_binding → its D1 binding
// key); a CLAIM atomically FLIPS the row to the customer (slug/name/plan) via a conditional UPDATE. The customer
// resolver (TENANT_BINDINGS) is UNTOUCHED — the pool is a separate, server-side-only resolution surface, so the
// REQ-025 ISO-pub-5 subset-parity (HOST_TENANTS ⊆ TENANT_BINDINGS) still holds.

// The physical pool this deployment binds (dev: local-pool-0N). resetPool restores both to `unclaimed`.
const POOL_SLOTS = [
  { id: "_pool_01", binding: "TENANT_POOL_01_DB", marker: "MARKER-POOL-01" },
  { id: "_pool_02", binding: "TENANT_POOL_02_DB", marker: "MARKER-POOL-02" },
] as const;

const markerFor = (binding: string): string => POOL_SLOTS.find((s) => s.binding === binding)!.marker;

// Flag ON (test-only): env with PROVISIONING_ENABLED="true" own-prop over the real env prototype, so the D1
// bindings resolve through the chain even if they are accessors (robust vs a naive object spread).
const onEnv: Env = Object.assign(Object.create(env) as Env, { PROVISIONING_ENABLED: "true" });

function baseInput(slug: string, email: string) {
  return { slug, name: `Prov ${slug}`, plan: "pilot", admin: { email }, period: "2026-07" };
}

// Restore both pool sentinels to their canonical unclaimed state + purge any claimed admin/credits rows, so
// each test starts from a known 2-slot-unclaimed pool regardless of order (this file alone touches the pool).
async function resetPool(): Promise<void> {
  for (const { id, binding } of POOL_SLOTS) {
    await env.CONTROL_DB.prepare("DELETE FROM users WHERE tenant_id = ?").bind(id).run();
    await env.CONTROL_DB.prepare("DELETE FROM usage_credits WHERE tenant_id = ?").bind(id).run();
    await env.CONTROL_DB
      .prepare("UPDATE tenants SET slug = ?, name = ?, plan = 'unclaimed', policy = ?, created_ts = 0 WHERE id = ?")
      .bind(id, `SHUDDL Pool Slot ${id}`, JSON.stringify({ pool_binding: binding }), id)
      .run();
  }
}

async function tenantRow(slug: string): Promise<{ id: string; plan: string; policy: string } | null> {
  return env.CONTROL_DB.prepare("SELECT id, plan, policy FROM tenants WHERE slug = ?")
    .bind(slug)
    .first<{ id: string; plan: string; policy: string }>();
}

beforeAll(async () => {
  await ensureSchema(env); // control plane + tenant-a
  await ensureTenantBSchema(env);
  // 0002 seeds the reserved `_platform` row; 0003 seeds the two `_pool_0N` sentinel slots. Both idempotent.
  await applyMigrations(env.CONTROL_DB, [
    { path: "0002_platform_tenant.sql", sql: platformSql },
    { path: "0003_tenant_pool.sql", sql: controlPoolSql },
  ]);
  // Probe markers for the two-way isolation proof (mirrors platform-tenant-isolation.test.ts).
  for (const [db, marker] of [
    [env.TENANT_A_DB, "MARKER-TENANT-A"],
    [env.TENANT_POOL_01_DB, markerFor("TENANT_POOL_01_DB")],
    [env.TENANT_POOL_02_DB, markerFor("TENANT_POOL_02_DB")],
  ] as const) {
    await db.exec("CREATE TABLE IF NOT EXISTS probe (tenant TEXT NOT NULL)");
    await db.prepare("INSERT OR IGNORE INTO probe (tenant) VALUES (?)").bind(marker).run();
  }
});

beforeEach(resetPool);

// ---- FLAG OFF (the DEFAULT): the whole provisioning path is REFUSED (dark) --------------------------
describe("flag OFF is the default — provisioning is dark, fail-closed (REQ-121)", () => {
  it("the real env has NO provisioning flag → provisioningEnabled(env) is false", () => {
    expect(provisioningEnabled(env)).toBe(false);
  });

  it("provisionTenant on the default env REFUSES with PROVISIONING_DISABLED and writes NOTHING", async () => {
    const before = await tenantRow("prov-dark");
    expect(before).toBeNull();
    let err: unknown;
    try {
      await provisionTenant(env, baseInput("prov-dark", "a@prov-dark.test"));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProvisionError);
    expect((err as ProvisionError).code).toBe("PROVISIONING_DISABLED");
    // fail-closed: no tenant row, no pool slot flipped
    expect(await tenantRow("prov-dark")).toBeNull();
    for (const { id } of POOL_SLOTS) {
      const row = await env.CONTROL_DB.prepare("SELECT plan FROM tenants WHERE id = ?").bind(id).first<{ plan: string }>();
      expect(row?.plan).toBe("unclaimed");
    }
  });
});

// ---- FLAG ON (test-only): claim provisions a tenant + admin + credits ATOMICALLY, bindable + isolated ----
describe("flag ON — claim provisions an isolated tenant atomically (REQ-121/025)", () => {
  it("claims a pool slot → tenant + admin-user(role=admin) + usage_credits, all in one atomic batch", async () => {
    const out = await provisionTenant(onEnv, baseInput("prov-acme", "admin@prov-acme.test"));

    // the tenant row is the flipped pool slot (a customer plan, the fresh customer slug)
    expect(out.slug).toBe("prov-acme");
    expect(out.plan).toBe("pilot");
    expect(POOL_BINDINGS).toContain(out.pool_binding);
    const t = await tenantRow("prov-acme");
    expect(t?.id).toBe(out.tenant_id);
    expect(t?.plan).toBe("pilot");
    expect(JSON.parse(t!.policy).pool_binding).toBe(out.pool_binding);

    // the admin user (role=admin) is keyed to the claimed slot
    const u = await env.CONTROL_DB.prepare("SELECT tenant_id, email, role FROM users WHERE tenant_id = ?")
      .bind(out.tenant_id)
      .first<{ tenant_id: string; email: string; role: string }>();
    expect(u?.role).toBe("admin");
    expect(u?.email).toBe("admin@prov-acme.test");

    // an initial usage_credits row (the metering seed, REQ-123 lives on the platform tenant; this is the
    // per-tenant meter row) exists for the period
    const uc = await env.CONTROL_DB.prepare("SELECT tenant_id, period FROM usage_credits WHERE tenant_id = ?")
      .bind(out.tenant_id)
      .first<{ tenant_id: string; period: string }>();
    expect(uc?.period).toBe("2026-07");
  });

  it("the provisioned tenant is BINDABLE server-side and ISOLATED in both directions (REQ-025)", async () => {
    const out = await provisionTenant(onEnv, baseInput("prov-iso", "admin@prov-iso.test"));

    // bindable: resolveClaimedTenantDb (a server-side control-plane lookup) returns the pool D1, distinct
    // from every customer/control binding
    const db = await resolveClaimedTenantDb(env, "prov-iso");
    expect(db).toBe(out.db);
    expect(db).toBe(env[out.pool_binding]);
    expect(db).not.toBe(env.TENANT_A_DB);
    expect(db).not.toBe(env.CONTROL_DB);

    // isolation forward: the fresh tenant cannot read tenant-a
    const mineMarker = markerFor(out.pool_binding);
    const rows = await db.prepare("SELECT tenant FROM probe").all<{ tenant: string }>();
    const markers = rows.results.map((r) => r.tenant);
    expect(markers).toContain(mineMarker);
    expect(markers).not.toContain("MARKER-TENANT-A");

    // isolation reverse: tenant-a cannot read the fresh tenant's marker
    const aRows = await env.TENANT_A_DB.prepare("SELECT tenant FROM probe").all<{ tenant: string }>();
    expect(aRows.results.map((r) => r.tenant)).not.toContain(mineMarker);
  });

  it("the customer resolver is UNTOUCHED — the pool binding is not a TENANT_BINDINGS key (REQ-025 parity)", async () => {
    const out = await provisionTenant(onEnv, baseInput("prov-parity", "admin@prov-parity.test"));
    // the claimed slug resolves only via the server-side pool lookup, NEVER the customer allowlist
    expect(Object.keys(TENANT_BINDINGS)).not.toContain("prov-parity");
    expect(() => tenantDb(env, "prov-parity")).toThrow(); // the static customer resolver never binds it
    expect(POOL_BINDINGS).toContain(out.pool_binding);
    // and no pool binding key leaked into the customer allowlist
    for (const b of POOL_BINDINGS) expect(Object.values(TENANT_BINDINGS)).not.toContain(b);
  });
});

// ---- POOL EXHAUSTED → clean fail-closed error (not a crash, not a wrong-slot bind) -------------------
describe("pool exhaustion is a clean fail-closed error (REQ-121)", () => {
  it("claims every slot, then the next claim throws POOL_EXHAUSTED and binds nothing", async () => {
    const a = await provisionTenant(onEnv, baseInput("prov-x1", "a@prov-x1.test"));
    const b = await provisionTenant(onEnv, baseInput("prov-x2", "a@prov-x2.test"));
    expect(a.pool_binding).not.toBe(b.pool_binding); // two DISTINCT slots claimed

    let err: unknown;
    try {
      await provisionTenant(onEnv, baseInput("prov-x3", "a@prov-x3.test"));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProvisionError);
    expect((err as ProvisionError).code).toBe("POOL_EXHAUSTED");
    // the failed claim wrote nothing — no tenant row, no orphan admin/credits
    expect(await tenantRow("prov-x3")).toBeNull();
  });
});

// ---- assertNotPlatformTenant / sentinel guard: the reserved ids can NEVER be claimed as a customer ----
describe("the reserved platform + pool-sentinel ids can never be claimed as a customer (REQ-025)", () => {
  it("claiming _platform is blocked by assertNotPlatformTenant (PLATFORM_TENANT_FORBIDDEN)", async () => {
    await expect(provisionTenant(onEnv, baseInput(PLATFORM_TENANT_ID, "a@x.test"))).rejects.toThrow(
      /PLATFORM_TENANT_FORBIDDEN/,
    );
    expect(await tenantRow(PLATFORM_TENANT_ID)).not.toBeNull(); // the reserved row is unchanged, not re-planned
    const p = await tenantRow(PLATFORM_TENANT_ID);
    expect(p?.plan).toBe("platform");
  });

  it("claiming a pool sentinel slug (_pool_01) is rejected by the DNS-label shape (INVALID_INPUT)", async () => {
    let err: unknown;
    try {
      await provisionTenant(onEnv, baseInput("_pool_01", "a@x.test"));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProvisionError);
    expect((err as ProvisionError).code).toBe("INVALID_INPUT");
    // the sentinel is untouched (still unclaimed)
    const row = await env.CONTROL_DB.prepare("SELECT plan FROM tenants WHERE id = '_pool_01'").first<{ plan: string }>();
    expect(row?.plan).toBe("unclaimed");
  });

  it("a reserved plan value ('platform'/'unclaimed') cannot be provisioned onto a customer", async () => {
    await expect(provisionTenant(onEnv, { ...baseInput("prov-plan", "a@x.test"), plan: "unclaimed" })).rejects.toMatchObject(
      { code: "RESERVED_PLAN" },
    );
  });
});

// ---- ATOMICITY: a partial failure leaves NO half-claimed slot (the batch rolls back) ----------------
describe("a partial failure rolls back — no half-claimed slot (REQ-121)", () => {
  it("the admin-user INSERT failing aborts the whole claim; the slot stays unclaimed, no orphan rows", async () => {
    // Pre-seed a users row with the email the claim will use → the claim's users INSERT hits UNIQUE(email)
    // and the whole atomic batch (incl. the slot flip) rolls back.
    await env.CONTROL_DB.prepare("INSERT OR IGNORE INTO users (id, tenant_id, email, role, auth, device_keys) VALUES (?,?,?,?,?,?)")
      .bind("u-prov-dup", "t-a", "dup@prov-fail.test", "read", "{}", "[]")
      .run();

    let err: unknown;
    try {
      await provisionTenant(onEnv, baseInput("prov-fail", "dup@prov-fail.test"));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProvisionError);

    // no half-claim: no tenant row for the slug, both slots still unclaimed, no credits orphan
    expect(await tenantRow("prov-fail")).toBeNull();
    for (const { id } of POOL_SLOTS) {
      const row = await env.CONTROL_DB.prepare("SELECT plan FROM tenants WHERE id = ?").bind(id).first<{ plan: string }>();
      expect(row?.plan).toBe("unclaimed");
      const uc = await env.CONTROL_DB.prepare("SELECT COUNT(*) AS n FROM usage_credits WHERE tenant_id = ?").bind(id).first<{ n: number }>();
      expect(uc?.n).toBe(0);
    }
  });
});
