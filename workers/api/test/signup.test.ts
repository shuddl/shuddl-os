import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verify } from "hono/jwt";
import { applyMigrations } from "@shuddl/ledger/migrate";
import platformSql from "../../../db/control/migrations/0002_platform_tenant.sql?raw";
import controlPoolSql from "../../../db/control/migrations/0003_tenant_pool.sql?raw";
import { ensureSchema, ensureTenantBSchema, ensureTenantPlaneSchema, token } from "./helpers.js";
import { provisionTenant } from "../src/provision.js";
import { resolveTenantDb } from "../src/tenants.js";
import { PLATFORM_TENANT_ID } from "@shuddl/contracts";
import app from "../src/index.js";
import type { Env } from "../src/index.js";

// REQ-121/025 (WP-14 Task 3): the pre-auth, DARK self-serve signup route (POST /pub/signup) + the CLAIMED-TENANT
// read path wired into the customer resolver (resolveTenantDb). A stranger signs up, provisionTenant CLAIMS a
// pool slot, and the route mints an ADMIN session JWT for the new tenant. That session must be able to READ its
// OWN workspace end-to-end (the resolver's non-static fallback resolves the claimed slug → its pool D1), while
// REQ-025 stays airtight in BOTH directions and every sentinel/unclaimed/_platform slug is rejected fail-closed.

const JWT_SECRET = "test-secret-do-not-use-in-prod"; // === vitest.config.ts miniflare bindings.JWT_SECRET

// Flag ON (test-only): env with PROVISIONING_ENABLED="true" own-prop over the real env prototype, so the D1
// bindings still resolve through the chain even if they are accessors (mirrors provision.test.ts). The DARK
// default (flag OFF) is proven through the REAL worker via SELF.fetch (env has no flag).
const onEnv: Env = Object.assign(Object.create(env) as Env, { PROVISIONING_ENABLED: "true" });

const POOL_SLOTS = [
  { id: "_pool_01", binding: "TENANT_POOL_01_DB", marker: "MARKER-POOL-01" },
  { id: "_pool_02", binding: "TENANT_POOL_02_DB", marker: "MARKER-POOL-02" },
] as const;

type SignupOut = { session: string; workspace: { slug: string; plan: string; entry: string } };
type ProbeOut = { tenant_marker: string | null };

function signupReq(body: Record<string, unknown>): Request {
  return new Request("https://api.local/pub/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function probeReq(tok: string): Request {
  return new Request("https://api.local/v1/_probe", { headers: { Authorization: `Bearer ${tok}` } });
}

// Restore both pool sentinels to unclaimed + purge any claimed admin/credits rows, so each test starts from a
// known 2-slot-unclaimed pool regardless of order (mirrors provision.test.ts resetPool).
async function resetPool(): Promise<void> {
  for (const { id, binding } of POOL_SLOTS) {
    await env.CONTROL_DB.prepare("DELETE FROM users WHERE tenant_id = ?").bind(id).run();
    // 2026-08-02 §15: the credits purge used to bind ONLY the slot id. Since the row is keyed by SLUG, that
    // deleted nothing — and with isolatedStorage:false every claimed tenant’s meter row survived the whole
    // run, so a future test claiming the same slug twice would hit UNIQUE(usage_credits.id) inside the
    // atomic batch and surface as PROVISION_FAILED rather than SLUG_TAKEN. Purge BOTH shapes: the slot id
    // (legacy rows) and whatever slug currently occupies the slot.
    // Purge EVERY non-static meter row, not just this slot occupant (2026-08-02 §17). The narrower
    // occupant-only purge still left rows behind and the api suite failed ~1 run in 5 with
    // "UNIQUE constraint failed: usage_credits.id" inside the atomic claim — surfacing as PROVISION_FAILED
    // across four files at once. usage_credits is keyed <slug>:<period>, so a row survives any reset that
    // does not know the slug AND period that wrote it; the only reliable predicate is "not a static tenant".
    // Nothing in workers/api writes a meter row for a static tenant (metering lives in the billing worker),
    // so this is exact rather than broad.
    await env.CONTROL_DB.prepare("DELETE FROM usage_credits WHERE tenant_id NOT IN (?, ?)").bind("tenant-a", "tenant-b").run();
    await env.CONTROL_DB
      .prepare("UPDATE tenants SET slug = ?, name = ?, plan = 'unclaimed', policy = ?, created_ts = 0 WHERE id = ?")
      .bind(id, `SHUDDL Pool Slot ${id}`, JSON.stringify({ pool_binding: binding }), id)
      .run();
    // REQ-151 — clear each pool slot's cold-start tariff so a claim starts from a true cold start (signup now
    // seeds a brokerage tariff into the claimed pool D1; a stale row from a prior test must not leak in).
    await env[binding].prepare("DELETE FROM rate_config").run();
  }
}

beforeAll(async () => {
  await ensureSchema(env); // control plane + tenant-a
  await ensureTenantBSchema(env);
  // 0002 seeds the reserved `_platform` row; 0003 seeds the two `_pool_0N` sentinel slots. Both idempotent.
  await applyMigrations(env.CONTROL_DB, [
    { path: "0002_platform_tenant.sql", sql: platformSql },
    { path: "0003_tenant_pool.sql", sql: controlPoolSql },
  ]);
  // tenant-a probe marker (the isolation control) + each pool D1's probe marker (the claimed-workspace read
  // target the minted session must reach). `probe` has no unique index; INSERT OR IGNORE + a LIMIT 1 read is
  // fine (pool D1s only ever get their own pool marker; tenant-a only ever MARKER-TENANT-A).
  await env.TENANT_A_DB.exec("CREATE TABLE IF NOT EXISTS probe (tenant TEXT NOT NULL)");
  await env.TENANT_A_DB.prepare("INSERT OR IGNORE INTO probe (tenant) VALUES (?)").bind("MARKER-TENANT-A").run();
  for (const { binding, marker } of POOL_SLOTS) {
    // The pool slots are pre-provisioned, MIGRATED tenant D1s in production — so the REQ-151 cold-start seed
    // (a rate_config write on a successful claim) lands on signup, not just logs a miss.
    await ensureTenantPlaneSchema(env[binding]);
    await env[binding].exec("CREATE TABLE IF NOT EXISTS probe (tenant TEXT NOT NULL)");
    await env[binding].prepare("INSERT OR IGNORE INTO probe (tenant) VALUES (?)").bind(marker).run();
  }
});

beforeEach(resetPool);

// ---- FLAG OFF (the DEFAULT): the route is DARK — refused, nothing provisioned -------------------------
describe("flag OFF is the default — POST /pub/signup is dark (REQ-121)", () => {
  it("provisioningEnabled(env) is false on the real worker → SELF.fetch signup is 404, nothing provisioned", async () => {
    const res = await SELF.fetch("https://api.local/pub/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ company: "Dark Co", email: "a@signup-dark.test", slug: "signup-dark" }),
    });
    expect(res.status).toBe(404); // DARK — no oracle the route even exists
    const row = await env.CONTROL_DB.prepare("SELECT COUNT(*) AS n FROM tenants WHERE slug = ?")
      .bind("signup-dark")
      .first<{ n: number }>();
    expect(row?.n).toBe(0); // fail-closed: nothing claimed
  });
});

// ---- FLAG ON (test-only, injected env): signup provisions + mints an admin session that READS its workspace ----
describe("flag ON — signup provisions a tenant + mints an admin session (REQ-121/025)", () => {
  it("returns 201 with an admin session JWT + workspace bootstrap, and leaks NO secret/internal field", async () => {
    const res = await app.fetch(signupReq({ company: "Signup Co", email: "admin@signup-acme.test", slug: "signup-acme" }), onEnv);
    expect(res.status).toBe(201);
    const out = (await res.json()) as SignupOut;

    expect(typeof out.session).toBe("string");
    expect(out.workspace.slug).toBe("signup-acme");
    expect(out.workspace.plan).toBe("pilot");
    expect(out.workspace.entry).toBe("/v1/whoami");

    // NO secret / internal leak: no pool binding key, no `_pool_0N` slot id, no JWT secret.
    const flat = JSON.stringify(out);
    expect(flat).not.toContain("TENANT_POOL");
    expect(flat).not.toContain("_pool_0");
    expect(flat).not.toContain("pool_binding");
    expect(flat).not.toContain(JWT_SECRET);

    // the session is a real SessionClaims JWT: role=admin, tenant = the new claimed slug.
    const claims = await verify(out.session, JWT_SECRET, "HS256");
    expect(claims.role).toBe("admin");
    expect(claims.tenant).toBe("signup-acme");
    // THE LIFETIME (audit §469). `SESSION_TTL_SECONDS` (8h) had ZERO test references: the session's SHAPE was
    // asserted, its duration was not. This is an ADMIN session for a freshly provisioned workspace, so a
    // silent widening lengthens exactly the window a stolen token is useful for. Pinned on the observable and
    // bounded by a domain rule that survives someone editing the literal.
    const hours = (Number(claims.exp) - Math.floor(Date.now() / 1000)) / 3600;
    expect(hours).toBeGreaterThan(7.5);
    expect(hours).toBeLessThan(8.5);
    expect(hours, "an admin session must not outlive a working day").toBeLessThan(24);
  });

  it("the minted admin session READS the new workspace end-to-end (resolveTenantDb resolves the claimed pool D1)", async () => {
    const res = await app.fetch(signupReq({ company: "E2E Co", email: "admin@signup-e2e.test", slug: "signup-e2e" }), onEnv);
    expect(res.status).toBe(201);
    const { session } = (await res.json()) as SignupOut;

    // GET /v1/_probe with the minted session → the wired resolveTenantDb fallback resolves the claimed slug to
    // its OWN pool D1 and returns the tenant's own marker (deliverable A works).
    const probe = await app.fetch(probeReq(session), onEnv);
    expect(probe.status).toBe(200);
    const pj = (await probe.json()) as ProbeOut;
    expect(String(pj.tenant_marker)).toMatch(/^MARKER-POOL-0/); // its OWN claimed workspace
    expect(pj.tenant_marker).not.toBe("MARKER-TENANT-A"); // never a foreign tenant
  });

  it("REQ-025 both directions: the signed-up tenant and tenant-a never read each other's workspace", async () => {
    const res = await app.fetch(signupReq({ company: "Iso Co", email: "admin@signup-iso.test", slug: "signup-iso" }), onEnv);
    expect(res.status).toBe(201);
    const { session } = (await res.json()) as SignupOut;

    // forward: the signed-up admin reads ONLY its pool workspace, never tenant-a
    const mine = (await (await app.fetch(probeReq(session), onEnv)).json()) as ProbeOut;
    expect(String(mine.tenant_marker)).toMatch(/^MARKER-POOL-0/);
    expect(mine.tenant_marker).not.toBe("MARKER-TENANT-A");

    // reverse: a tenant-a session reads ONLY tenant-a, never the signed-up tenant's pool workspace
    const aTok = await token({ sub: "u-a", tenant: "tenant-a", role: "ops" });
    const aRes = (await (await app.fetch(probeReq(aTok), onEnv)).json()) as ProbeOut;
    expect(aRes.tenant_marker).toBe("MARKER-TENANT-A");
    expect(String(aRes.tenant_marker)).not.toMatch(/^MARKER-POOL/);
  });

  it("a _platform signup input is a clean 4xx (never a 500), and provisions nothing", async () => {
    const res = await app.fetch(signupReq({ company: "Evil Co", email: "a@evil.test", slug: PLATFORM_TENANT_ID }), onEnv);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500); // NOT a 500 — assertNotPlatformTenant maps to a clean 4xx
    const body = (await res.json()) as { code?: string; message?: string };
    // no secret/internal reason leaks in the error body
    expect(JSON.stringify(body)).not.toContain("PLATFORM_TENANT_FORBIDDEN");
    // the reserved row is untouched (still the platform plan, never re-planned to a customer)
    const row = await env.CONTROL_DB.prepare("SELECT plan FROM tenants WHERE slug = ?")
      .bind(PLATFORM_TENANT_ID)
      .first<{ plan: string }>();
    expect(row?.plan).toBe("platform");
  });

  it("a malformed body is a clean 400 (VALIDATION_FAILED), not a 500", async () => {
    const res = await app.fetch(signupReq({ company: "", email: "not-an-email", slug: "" }), onEnv);
    expect(res.status).toBe(400);
  });
});

// ---- COLLISION → a clean 409, never a 500 (WP-14 exit audit Finding D, REQ-121) ----------------------
// A taken workspace slug / admin email is the SINGLE most common signup error. It must tell the user to pick
// another (409 Conflict), not 5xx-alert. A genuine provisioning fault still surfaces as a 500 (never masked).
describe("a slug/email collision at signup is a clean 409, never a 500 (REQ-121)", () => {
  it("a signup for a slug already claimed by an existing tenant → 409, no D1/secret leak", async () => {
    // tenant-a already owns the slug "tenant-a" in the control plane (seeded by ensureSchema).
    const res = await app.fetch(signupReq({ company: "Dup Co", email: "admin@dup-slug.test", slug: "tenant-a" }), onEnv);
    expect(res.status).toBe(409);
    const flat = JSON.stringify((await res.json()) as Record<string, unknown>);
    expect(flat).not.toContain("UNIQUE"); // no D1 constraint detail
    expect(flat).not.toContain("constraint");
    expect(flat).not.toContain("_pool_0"); // no internal slot id
    expect(flat).not.toContain(JWT_SECRET); // no secret
  });

  it("a signup with an already-registered admin email → 409, and nothing is claimed", async () => {
    // driver@tenant-a.test is already a `users` row (seeded by ensureSchema); the slug itself is free.
    const res = await app.fetch(signupReq({ company: "Dup Co", email: "driver@tenant-a.test", slug: "signup-email-dup" }), onEnv);
    expect(res.status).toBe(409);
    const row = await env.CONTROL_DB.prepare("SELECT COUNT(*) AS n FROM tenants WHERE slug = ?")
      .bind("signup-email-dup")
      .first<{ n: number }>();
    expect(row?.n).toBe(0); // the email collided first — no slot was flipped
  });

  it("a GENUINE provisioning fault (a misconfigured pool slot) still → 500, not masked as a 409", async () => {
    // Corrupt the first-picked slot's pool_binding so provisionTenant throws PROVISION_FAILED (a real fault,
    // NOT a collision). beforeEach resetPool restores it for the next test.
    await env.CONTROL_DB.prepare("UPDATE tenants SET policy = ? WHERE id = '_pool_01'")
      .bind(JSON.stringify({ pool_binding: "BOGUS_NOT_ALLOWLISTED" }))
      .run();
    const res = await app.fetch(signupReq({ company: "Fault Co", email: "admin@signup-fault.test", slug: "signup-fault" }), onEnv);
    expect(res.status).toBe(500); // a genuine fault is never downgraded to a collision 409
  });
});

// ---- provisionTenant surfaces the collision with DISTINCT codes (the source the 409 maps from) -------
describe("provisionTenant classifies a collision as SLUG_TAKEN / EMAIL_TAKEN, distinct from PROVISION_FAILED", () => {
  it("a taken slug throws SLUG_TAKEN", async () => {
    await expect(
      provisionTenant(onEnv, { slug: "tenant-a", name: "X", plan: "pilot", admin: { email: "a@slugtaken.test" } }),
    ).rejects.toMatchObject({ code: "SLUG_TAKEN" });
  });

  it("a taken admin email throws EMAIL_TAKEN", async () => {
    await expect(
      provisionTenant(onEnv, { slug: "signup-slug-ok", name: "X", plan: "pilot", admin: { email: "driver@tenant-a.test" } }),
    ).rejects.toMatchObject({ code: "EMAIL_TAKEN" });
  });
});

// ---- resolveTenantDb: the claimed-tenant fallback resolves a claim but NEVER widens REQ-025 -----------
describe("resolveTenantDb — claimed fallback without widening isolation (REQ-025)", () => {
  it("hot path: a static customer slug (tenant-a) resolves to its binding", async () => {
    expect(await resolveTenantDb(env, "tenant-a")).toBe(env.TENANT_A_DB);
  });

  it("fallback: a genuinely-CLAIMED slug resolves to its pool D1 (server-side control lookup)", async () => {
    const out = await provisionTenant(onEnv, { slug: "signup-resolve", name: "Resolve Co", plan: "pilot", admin: { email: "a@signup-resolve.test" } });
    const db = await resolveTenantDb(env, "signup-resolve");
    expect(db).toBe(out.db);
    expect(db).not.toBe(env.TENANT_A_DB);
    expect(db).not.toBe(env.CONTROL_DB);
  });

  it("REJECTS _platform fail-closed (FORBIDDEN 403) — before any control read", async () => {
    await expect(resolveTenantDb(env, PLATFORM_TENANT_ID)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  });

  it("REJECTS an unclaimed pool sentinel (_pool_01) — never resolvable via the fallback", async () => {
    await expect(resolveTenantDb(env, "_pool_01")).rejects.toMatchObject({ status: 403 });
  });

  it("REJECTS an unknown slug (no tenant-existence oracle) — FORBIDDEN, never a cross-tenant handle", async () => {
    await expect(resolveTenantDb(env, "no-such-tenant")).rejects.toMatchObject({ status: 403 });
  });
});
