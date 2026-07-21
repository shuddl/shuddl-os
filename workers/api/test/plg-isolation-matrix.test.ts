import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "@shuddl/ledger/migrate";
import platformSql from "../../../db/control/migrations/0002_platform_tenant.sql?raw";
import controlPoolSql from "../../../db/control/migrations/0003_tenant_pool.sql?raw";
import { ensureSchema, ensureTenantBSchema, ensureTenantPlaneSchema, retryOnDoInvalidation, token } from "./helpers.js";
import { provisionTenant, POOL_BINDINGS, type PoolBindingKey } from "../src/provision.js";
import { TENANT_BINDINGS, tenantDb, resolveTenantDb, resolvePlatformTenantDb } from "../src/tenants.js";
import { PLATFORM_TENANT_ID, isPlatformTenant } from "@shuddl/contracts";
import type { SeqStub } from "../src/routes/events.js";
import app from "../src/index.js";
import type { Env } from "../src/index.js";

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// WP-14 Task 11 (REQ-025) — THE CONSOLIDATED PLG TENANT-ISOLATION MATRIX.
//
// CLAUDE.md rule #8: a cross-tenant read/write ANYWHERE is a build failure. The PLG (product-led-growth)
// surface added FIVE new tenant-scoped storage seams beyond the WP-01 ledger routes; each must be isolated in
// BOTH directions (tenant-A never reaches tenant-B/`_platform`, and `_platform`/another tenant never bleeds
// into tenant-A). This file is the matrix that ties them together and CLOSES the gaps the per-surface suites
// left. It REFERENCES (never duplicates) the proofs already shipped:
//   · platform-tenant-isolation.test.ts — the reserved `_platform` D1 (forward: no customer resolves it;
//     reverse: it enumerates no customer). Task 1.
//   · provision.test.ts / signup.test.ts — a CLAIMED pool tenant RESOLVES to its own pool D1 (read + resolver),
//     both directions, and every sentinel/`_platform` slug is refused fail-closed. Tasks 2/3.
//   · platform-credit.test.ts — the `_platform` credit APPEND (write) + the internal secret-gated route
//     (DARK 503 / wrong-secret 403 / authorized 200). Task 10.
//   · billing/metering.test.ts — the metering sweep is tenant-scoped and writes NO `_platform`/pool-sentinel
//     usage_credits row (roster excludes every `_`-prefixed slug). Task 6.
//   · agents/spark-meter.test.ts — the per-tenant SparkMeter DO (idFromName), + the cross-tenant case ADDED
//     there (that harness alone binds SPARK_METER; the api worker does not).
//
// THE GAPS THIS FILE CLOSES (each case FAILS on a real leak — distinct physical D1s: local-tenant-a/-b/
// -control/-platform/-pool-01/-pool-02 in the pool-workers env, so a dropped tenant→handle constraint lands a
// write in a different physical store, observably):
//   G1  a CLAIMED pool tenant's ledger APPEND (the WRITE path, not just the read resolver) lands ONLY in its
//       own pool D1 — never tenant-a/b, `_platform`, or the sibling pool slot; and REVERSE (tenant-a's append
//       never lands in a claimed pool D1). provision/signup proved the READ resolver only.
//   G2  a claimed tenant's sequencer DO cannot be driven under ANOTHER tenant's identity → no cross-pool bind.
//   G3  the internal `/internal/platform/*` route forces the tenant to `_platform` server-side: an
//       authenticated CUSTOMER bearer (no secret) is refused, and a customer-SHAPED streamId still lands the
//       credit event on `_platform` ONLY (tenant-a/b untouched) — the caller can never redirect it.
//   +   the matrix backbone: all six PLG stores are mutually-distinct handles, and no customer resolver
//       (static OR claimed fallback) ever returns the platform or a pool handle.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

const PLATFORM_INTERNAL_SECRET = "test-plg-matrix-internal-secret";
const GL_CREDITS_AR = "4300-PLATFORM-CREDITS-AR";

// Flag ON (test-only): provisioning enabled + the internal secret bound, own-props over the real env prototype
// (mirrors provision.test onEnv / platform-credit.test secretEnv). The DARK defaults (no flag/secret) are proven
// through the REAL worker via SELF.fetch in the referenced suites; here we drive the ENABLED paths under app.fetch.
const onEnv: Env = Object.assign(Object.create(env) as Env, { PROVISIONING_ENABLED: "true" });
const secretEnv: Env = Object.assign(Object.create(env) as Env, { PLATFORM_INTERNAL_SECRET });

const POOL_SLOTS = [
  { id: "_pool_01", binding: "TENANT_POOL_01_DB" },
  { id: "_pool_02", binding: "TENANT_POOL_02_DB" },
] as const;

function platformDb(): D1Database {
  return resolvePlatformTenantDb(env);
}
function stubFor(tenant: string, streamId: string): SeqStub {
  return env.SHIPMENT_SEQ.get(env.SHIPMENT_SEQ.idFromName(`${tenant}|${streamId}`)) as unknown as SeqStub;
}
function siblingBinding(claimed: PoolBindingKey): PoolBindingKey {
  const other = POOL_BINDINGS.find((b) => b !== claimed);
  if (other === undefined) throw new Error("pool has no sibling slot");
  return other;
}

// A fresh stream + a fresh claimed slug per case, so each append is a distinct DO and each claim a distinct row —
// no bleed across cases on the shared, isolatedStorage-off D1.
let uniqN = 0;
function freshStream(prefix: string): string {
  uniqN += 1;
  return `s:${prefix}-${uniqN}-${Date.now()}`;
}
function provisionInput(prefix: string): { slug: string; name: string; plan: string; admin: { email: string }; period: string } {
  uniqN += 1;
  const slug = `${prefix}-${uniqN}-${Date.now()}`;
  return { slug, name: `PLG ${slug}`, plan: "pilot", admin: { email: `admin@${slug}.test` }, period: "2026-07" };
}

// A valid, UNGATED, non-money EventInput (the client-suppliable subset). quote.requested has no transition gate,
// no money projection, and no FK — the generic "any event" the sequencer-mechanics suite appends. shipment_id is
// derived from the stream so the events CHECK (stream_id = 's:' || shipment_id) holds.
function benignInput(streamId: string): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    shipment_id: streamId.slice(2),
    ts: 1_720_000_000_000,
    actor: { party: "party-shipper" },
    party_refs: [],
    evidence: [],
    source: "native",
    confidence: 10_000,
    kind: "quote.requested",
    payload: { request: { origin_zip: "97201", dest_zip: "98101" } },
  };
}

// A `_platform` credit-pack sale (all lines credit_purchase → exempt from the POD gate ONLY on `_platform`).
// party_id carries a CUSTOMER label ("tenant-a") deliberately — it is only an AR party name on the platform
// ledger, never a routing key; the tenant is server-forced.
function creditInvoiceInput(streamId: string, party: string, cents: number): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    shipment_id: streamId.slice(2),
    ts: Date.now(),
    actor: { party: "agent:billing" },
    party_refs: [],
    evidence: [],
    source: "native",
    confidence: 10_000,
    kind: "invoice.issued",
    payload: {
      invoice_id: `plgm-credit-${streamId.slice(2)}`,
      party_id: party,
      division: "platform",
      lines: [{ line_no: 1, kind: "credit_purchase", amount_cents: cents, gl_map: GL_CREDITS_AR }],
    },
  };
}

async function eventCount(db: D1Database, streamId: string): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE stream_id = ?").bind(streamId).first<{ n: number }>();
  return row?.n ?? 0;
}

// Restore both pool sentinels to unclaimed + purge any claimed admin/credits/tariff rows (mirrors
// provision.test resetPool) so each pool-write case starts from a known 2-slot-unclaimed pool.
async function resetPool(): Promise<void> {
  for (const { id, binding } of POOL_SLOTS) {
    await env.CONTROL_DB.prepare("DELETE FROM users WHERE tenant_id = ?").bind(id).run();
    await env.CONTROL_DB.prepare("DELETE FROM usage_credits WHERE tenant_id = ?").bind(id).run();
    await env.CONTROL_DB
      .prepare("UPDATE tenants SET slug = ?, name = ?, plan = 'unclaimed', policy = ?, created_ts = 0 WHERE id = ?")
      .bind(id, `SHUDDL Pool Slot ${id}`, JSON.stringify({ pool_binding: binding }), id)
      .run();
    await env[binding].prepare("DELETE FROM rate_config").run();
  }
}

beforeAll(async () => {
  await ensureSchema(env); // control plane + tenant-a
  await ensureTenantBSchema(env);
  // 0002 seeds the reserved `_platform` row; 0003 seeds the two `_pool_0N` sentinels. Both idempotent.
  await applyMigrations(env.CONTROL_DB, [
    { path: "0002_platform_tenant.sql", sql: platformSql },
    { path: "0003_tenant_pool.sql", sql: controlPoolSql },
  ]);
  // The platform D1 + both pool D1s are pre-provisioned, MIGRATED tenant planes in production — reflect that so
  // an append (or credit projection) lands on a real ledger schema (events + money_lines + invoices).
  await ensureTenantPlaneSchema(platformDb());
  await ensureTenantPlaneSchema(env.TENANT_POOL_01_DB);
  await ensureTenantPlaneSchema(env.TENANT_POOL_02_DB);
});

// ─── BACKBONE — every PLG physical store is a distinct handle; no customer resolver reaches platform/pool ─────
describe("PLG matrix backbone — the tenant→store map is a closed, fail-closed allowlist (REQ-025)", () => {
  it("the six PLG D1 stores (customer×2, control, platform, pool×2) are mutually-DISTINCT physical handles", () => {
    const handles: Array<[string, D1Database]> = [
      ["TENANT_A_DB", env.TENANT_A_DB],
      ["TENANT_B_DB", env.TENANT_B_DB],
      ["CONTROL_DB", env.CONTROL_DB],
      ["PLATFORM_TENANT_DB", platformDb()],
      ["TENANT_POOL_01_DB", env.TENANT_POOL_01_DB],
      ["TENANT_POOL_02_DB", env.TENANT_POOL_02_DB],
    ];
    // A leak is only OBSERVABLE if the stores are physically separate — this is the load-bearing premise every
    // "absent from the other store" assertion below rests on (non-tautology).
    for (let i = 0; i < handles.length; i += 1) {
      for (let j = i + 1; j < handles.length; j += 1) {
        const [an, a] = handles[i]!;
        const [bn, b] = handles[j]!;
        expect(a, `${an} must not be the same handle as ${bn}`).not.toBe(b);
      }
    }
  });

  it("no customer resolver (static tenantDb OR the claimed resolveTenantDb) ever returns the platform/pool handle", async () => {
    const platform = platformDb();
    const pools = POOL_BINDINGS.map((b) => env[b]);
    for (const slug of Object.keys(TENANT_BINDINGS)) {
      const staticDb = tenantDb(env, slug);
      expect(staticDb).not.toBe(platform);
      for (const p of pools) expect(staticDb).not.toBe(p);
      // the claimed-aware resolver's HOT path returns the SAME static handle — no widening.
      expect(await resolveTenantDb(env, slug)).toBe(staticDb);
    }
    // and `_platform` is refused fail-closed on BOTH customer resolvers (the reserved id is never a handle).
    expect(isPlatformTenant(PLATFORM_TENANT_ID)).toBe(true);
    expect(() => tenantDb(env, PLATFORM_TENANT_ID)).toThrow();
    await expect(resolveTenantDb(env, PLATFORM_TENANT_ID)).rejects.toMatchObject({ status: 403 });
  });
});

// ─── G1/G2 — the CLAIMED pool tenant WRITE path (extends provision/signup, which proved the READ resolver) ────
describe("pool provisioning — a CLAIMED tenant's ledger APPEND lands ONLY in its own pool D1 (write path, REQ-025)", () => {
  beforeEach(resetPool);

  it("G1 forward — a claimed tenant's append is written to its pool D1 and to NO other tenant store", async () => {
    const out = await provisionTenant(onEnv, provisionInput("plgm-w"));
    const sibling = env[siblingBinding(out.pool_binding)];
    expect(out.db).toBe(env[out.pool_binding]); // the claimed handle IS the pool binding
    expect(out.db).not.toBe(sibling); // and the two slots are physically distinct (a leak would be observable)

    const stream = freshStream("claimed-append");
    const appended = await retryOnDoInvalidation(() => stubFor(out.slug, stream).append({ tenant: out.slug, streamId: stream, input: benignInput(stream) }));
    expect(appended.id).toBeTruthy();

    // POSITIVE CONTROL (non-tautology): the append PHYSICALLY landed in the claimed pool D1. Without this, the
    // "absent everywhere else" assertions could pass vacuously (nothing written anywhere).
    expect(await eventCount(out.db, stream)).toBe(1);

    // ISOLATION: the event is in NO customer D1, NOT the platform D1, and NOT the sibling pool slot. Each would
    // hold this row if the claimed resolver mis-mapped the slug to that store.
    expect(await eventCount(env.TENANT_A_DB, stream)).toBe(0);
    expect(await eventCount(env.TENANT_B_DB, stream)).toBe(0);
    expect(await eventCount(platformDb(), stream)).toBe(0);
    expect(await eventCount(sibling, stream)).toBe(0);
  });

  it("G1 reverse — a tenant-a append never lands in a claimed tenant's pool D1", async () => {
    const out = await provisionTenant(onEnv, provisionInput("plgm-rev"));

    const stream = freshStream("tenant-a-append");
    const appended = await retryOnDoInvalidation(() => stubFor("tenant-a", stream).append({ tenant: "tenant-a", streamId: stream, input: benignInput(stream) }));
    expect(appended.id).toBeTruthy();
    // tenant-a's write is in tenant-a's D1 ONLY — the claimed pool D1 (a different physical store) never sees it.
    expect(await eventCount(env.TENANT_A_DB, stream)).toBe(1);
    expect(await eventCount(out.db, stream)).toBe(0);
  });

  it("G2 — a claimed tenant's DO cannot be driven under ANOTHER claimed tenant's identity (sequencer id pin)", async () => {
    const a = await provisionTenant(onEnv, provisionInput("plgm-x1"));
    const b = await provisionTenant(onEnv, provisionInput("plgm-x2"));
    expect(a.pool_binding).not.toBe(b.pool_binding); // two DISTINCT slots claimed

    // The stub id is derived from tenant A2's slug; declaring tenant B2 re-derives a DIFFERENT DurableObjectId,
    // so `#append`'s identity check rejects it BEFORE any D1 handle is resolved → no cross-pool bind is possible.
    const stream = freshStream("cross-claimed");
    await expect(
      retryOnDoInvalidation(() => stubFor(a.slug, stream).append({ tenant: b.slug, streamId: stream, input: benignInput(stream) })),
    ).rejects.toThrow(/FORBIDDEN/);
    // and nothing was written to EITHER claimed pool D1.
    expect(await eventCount(a.db, stream)).toBe(0);
    expect(await eventCount(b.db, stream)).toBe(0);
  });
});

// ─── G3 — the internal platform-credit route forces the tenant to `_platform` (extends platform-credit) ───────
describe("internal /internal/platform/* — the tenant is server-forced to `_platform`, unreachable by a customer (REQ-025)", () => {
  it("an authenticated CUSTOMER bearer (no shared secret) is REFUSED — the auth token is worthless here", async () => {
    // The internal route sits OUTSIDE app.use('/v1/*', auth); it is secret-gated, not session-gated. A valid
    // customer JWT presented WITHOUT the X-Platform-Internal secret can never open the `_platform` append door —
    // proving no authenticated customer can reach a platform-tenant write (even when the path is live).
    const custTok = await token({ sub: "u-cust", tenant: "tenant-a", role: "admin" });
    const stream = freshStream("internal-cust-bearer");
    const req = new Request("https://api.local/internal/platform/credit-append", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${custTok}` },
      body: JSON.stringify({ streamId: stream, input: creditInvoiceInput(stream, "tenant-a", 100_00) }),
    });
    const res = await app.fetch(req, secretEnv); // secret IS configured — the refusal is the missing HEADER, not DARK
    expect(res.status).toBe(403);
    // fail-closed: nothing appended — not to `_platform`, not to tenant-a.
    expect(await eventCount(platformDb(), stream)).toBe(0);
    expect(await eventCount(env.TENANT_A_DB, stream)).toBe(0);
  });

  it("tenant forced to `_platform` — a CUSTOMER-shaped streamId still lands the credit event on `_platform` ONLY", async () => {
    // Even with the correct secret, the caller controls only streamId + input, NEVER the tenant (the route
    // hard-codes PLATFORM_TENANT_ID). A customer-looking streamId + a customer party label cannot redirect the
    // append into a customer D1 — the DO id derives from `_platform`, so the write can only land on the platform D1.
    const stream = freshStream("internal-forced-platform");
    const req = new Request("https://api.local/internal/platform/credit-append", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Platform-Internal": PLATFORM_INTERNAL_SECRET },
      body: JSON.stringify({ streamId: stream, input: creditInvoiceInput(stream, "tenant-a", 500_00) }),
    });
    const res = await app.fetch(req, secretEnv);
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    expect(id).toBeTruthy();

    // the credit event + its projected money line are on the PLATFORM D1…
    expect(await eventCount(platformDb(), stream)).toBe(1);
    const line = await platformDb().prepare("SELECT kind FROM money_lines WHERE event_id = ?").bind(id).first<{ kind: string }>();
    expect(line?.kind).toBe("credit_purchase");
    // …and on NO customer D1, despite the customer-shaped streamId and the "tenant-a" party label.
    expect(await eventCount(env.TENANT_A_DB, stream)).toBe(0);
    expect(await eventCount(env.TENANT_B_DB, stream)).toBe(0);
    const custLine = await env.TENANT_A_DB.prepare("SELECT COUNT(*) AS n FROM money_lines WHERE event_id = ?").bind(id).first<{ n: number }>();
    expect(custLine?.n ?? 0).toBe(0);
  });

  it("SELF.fetch (real worker, no secret bound) — the internal route is DARK (503), nothing appended", async () => {
    // Belt on the DARK default via the REAL env (no PLATFORM_INTERNAL_SECRET): a customer cannot even probe the
    // route into existence. Mirrors platform-credit.test's DARK case, re-asserted as the matrix's closing guard.
    const stream = freshStream("internal-dark");
    const res = await SELF.fetch("https://api.local/internal/platform/credit-append", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Platform-Internal": PLATFORM_INTERNAL_SECRET },
      body: JSON.stringify({ streamId: stream, input: creditInvoiceInput(stream, "tenant-a", 100_00) }),
    });
    expect(res.status).toBe(503);
    expect(await eventCount(platformDb(), stream)).toBe(0);
  });
});
