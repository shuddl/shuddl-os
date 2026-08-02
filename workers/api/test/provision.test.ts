import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "@shuddl/ledger/migrate";
import platformSql from "../../../db/control/migrations/0002_platform_tenant.sql?raw";
import controlPoolSql from "../../../db/control/migrations/0003_tenant_pool.sql?raw";
import { ensureSchema, ensureTenantBSchema, ensureTenantPlaneSchema } from "./helpers.js";
import {
  provisionTenant,
  resolveClaimedTenantDb,
  provisioningEnabled,
  ProvisionError,
  POOL_BINDINGS,
  usageCreditsIdFor,
} from "../src/provision.js";
import { TENANT_BINDINGS, tenantDb } from "../src/tenants.js";
import { loadTenantRatingConfig } from "../src/rate-config.js";
import { priceShipment } from "@shuddl/rater";
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
    // 2026-08-02 §15: the credits purge used to bind ONLY the slot id. Since the row is keyed by SLUG, that
    // deleted nothing — and with isolatedStorage:false every claimed tenant’s meter row survived the whole
    // run, so a future test claiming the same slug twice would hit UNIQUE(usage_credits.id) inside the
    // atomic batch and surface as PROVISION_FAILED rather than SLUG_TAKEN. Purge BOTH shapes: the slot id
    // (legacy rows) and whatever slug currently occupies the slot.
    const occupant = await env.CONTROL_DB.prepare("SELECT slug FROM tenants WHERE id = ?").bind(id).first<{ slug: string }>();
    await env.CONTROL_DB.prepare("DELETE FROM usage_credits WHERE tenant_id = ? OR tenant_id = ?").bind(id, occupant?.slug ?? id).run();
    await env.CONTROL_DB
      .prepare("UPDATE tenants SET slug = ?, name = ?, plan = 'unclaimed', policy = ?, created_ts = 0 WHERE id = ?")
      .bind(id, `SHUDDL Pool Slot ${id}`, JSON.stringify({ pool_binding: binding }), id)
      .run();
    // REQ-151 — clear each pool slot's cold-start tariff so every test starts from a true cold start (the seed
    // now writes rate_config on a successful claim; a stale row from a prior test must not leak in).
    await env[binding].prepare("DELETE FROM rate_config").run();
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
  // The pool slots are pre-provisioned, MIGRATED tenant D1s in production (provision.ts) — reflect that so the
  // REQ-151 cold-start seed (a rate_config write on a successful claim) lands and the proof below can price.
  await ensureTenantPlaneSchema(env.TENANT_POOL_01_DB);
  await ensureTenantPlaneSchema(env.TENANT_POOL_02_DB);
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

  it("a STATIC roster slug can NEVER be claimed — slug shadowing is structurally refused (REQ-025, 2026-08-01 review)", async () => {
    // Both resolvers are static-first, so a claimed row named "tenant-a" would make that customer's
    // sessions and triggers resolve to the REAL static tenant's D1 — cross-tenant by shadowing. No prod
    // migration seeds control rows for the static slugs, so SLUG_TAKEN's collision pre-check could never
    // fire for them; the refusal must be structural, from the same roster the resolver consults.
    for (const reserved of ["tenant-a", "tenant-b"]) {
      let err: unknown;
      try {
        await provisionTenant(onEnv, baseInput(reserved, `admin@${reserved}.test`));
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ProvisionError);
      expect((err as ProvisionError).code).toBe("SLUG_TAKEN"); // the client sees the same 409 as any collision
      // fail-closed: no pool slot was flipped by the attempt
      for (const { id } of POOL_SLOTS) {
        const row = await env.CONTROL_DB.prepare("SELECT plan FROM tenants WHERE id = ?").bind(id).first<{ plan: string }>();
        expect(row?.plan).toBe("unclaimed");
      }
    }
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

    // An initial usage_credits row (the metering seed, REQ-123 lives on the platform tenant; this is the
    // per-tenant meter row) exists for the period — keyed the way its OTHER TWO WRITERS key it.
    //
    // 2026-08-02 §13: this assertion used to read `WHERE tenant_id = out.tenant_id` (the pool SLOT id) and
    // so encoded a real divergence instead of catching it. The billing metering sweep and the Stripe credit
    // stamp both write id=`<slug>:<period>`, tenant_id=<slug>, and both upsert `ON CONFLICT(id)` — so a
    // provisioning row under the slot id could never merge: the claimed tenant carried TWO rows, and the one
    // provisioning made was permanently empty (the sweep's `metered` and billing's `stripe_refs` landed on
    // the other). Pin the SHARED shape here, in the writer that had drifted.
    const uc = await env.CONTROL_DB.prepare("SELECT id, tenant_id, period FROM usage_credits WHERE tenant_id = ?")
      .bind(out.slug)
      .first<{ id: string; tenant_id: string; period: string }>();
    expect(uc?.period).toBe("2026-07");
    expect(uc?.id).toBe(`${out.slug}:2026-07`);
    expect(uc?.tenant_id).toBe(out.slug);
    // …and NOT under the slot id, which is what the divergence looked like.
    const stale = await env.CONTROL_DB.prepare("SELECT id FROM usage_credits WHERE tenant_id = ?")
      .bind(out.tenant_id)
      .first<{ id: string }>();
    expect(stale, "a usage_credits row under the SLOT id is the §13 divergence").toBeNull();
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
    }
    // 2026-08-02 §15: this orphan check used to bind the pool SLOT id. After §13 rebound the credits row to
    // the SLUG, no writer produces that shape at all — so the count was 0 unconditionally and the assertion
    // could not fail. Proved by moving the credits INSERT out of the atomic batch: a real orphan appeared and
    // the test stayed green. Bind what the writers actually write.
    const orphan = await env.CONTROL_DB.prepare("SELECT COUNT(*) AS n FROM usage_credits WHERE tenant_id = ? OR id = ?")
      .bind("prov-fail", usageCreditsIdFor("prov-fail", "2026-07"))
      .first<{ n: number }>();
    expect(orphan?.n, "a rolled-back claim must leave NO usage_credits row").toBe(0);
  });
});

// ---- REQ-151 COLD START: a newly-claimed brokerage tenant is RATEABLE day one (demo #2) ----------------
describe("a newly-provisioned tenant prices immediately from its cold-start tariff (REQ-151)", () => {
  const DIMS = { l_in: 48, w_in: 40, h_in: 48, pieces: 2 };
  const PRICEABLE = { origin_zip: "97201", dest_zip: "80012", weight_lb: 1000, dims: DIMS };

  it("the cold-start seed writes the 4 required kinds and priceShipment yields a real sell (signup → first quote)", async () => {
    const out = await provisionTenant(onEnv, baseInput("prov-cold", "admin@prov-cold.test"));

    // the seed wrote exactly the four required rate_config kinds into the claimed tenant's OWN D1
    const n = await out.db.prepare("SELECT COUNT(*) AS n FROM rate_config").first<{ n: number }>();
    expect(n?.n).toBe(4);

    // load that config through the REAL loader and price a priceable load — a PRICED sell on day one
    const config = await loadTenantRatingConfig(out.db, Date.now());
    expect(config).not.toBeNull();
    const quote = priceShipment(PRICEABLE, config!);
    expect(quote.status).toBe("PRICED");
    if (quote.status !== "PRICED") throw new Error("unreachable");
    expect(quote.sell_cents).toBeGreaterThan(0);
    expect(quote.anomaly).toBeNull(); // a sane cold-start price, nowhere near the anomaly cap
  });

  it("NO price on air: a tenant with no tariff (seed absent) → the loader is null → /v1/rate answers UNKNOWN", async () => {
    const out = await provisionTenant(onEnv, baseInput("prov-nocfg", "admin@prov-nocfg.test"));
    // simulate an asset-mode / un-seeded workspace: remove the cold-start rows
    await out.db.prepare("DELETE FROM rate_config").run();
    const config = await loadTenantRatingConfig(out.db, Date.now());
    expect(config).toBeNull(); // → the /rate service returns UNKNOWN no_tariff (REQ-004, never a fabricated price)
  });
});
