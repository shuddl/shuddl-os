import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ensureSchema,
  ensureTenantBSchema,
  seedRateConfig,
  TEST_RATE_CONFIG,
  TENANT_B_RATE_CONFIG,
  token,
  post,
  TENANT_SLUG,
} from "./helpers.js";
import { HOST_TENANTS } from "../src/pub/quote.js";
import { TENANT_BINDINGS } from "../src/tenants.js";
import { mintStatusCap, verifyStatusCap } from "../src/pub/status-cap.js";

const JWT_SECRET = "test-secret-do-not-use-in-prod"; // === vitest.config.ts miniflare bindings.JWT_SECRET
const nowS = (): number => Math.floor(Date.now() / 1000);

// REQ-025: cross-tenant read anywhere = build failure. This suite runs on every merge, forever.
// It grows a case for every read path added in later WPs — WP-02 adds the ledger event/position routes.

beforeAll(async () => {
  await ensureSchema(env); // the ledger-route cases below need tenant-a's events table
  await ensureTenantBSchema(env); // the ISO-pub-2 routing proof prices against tenant-b's OWN D1
  for (const [db, marker] of [
    [env.TENANT_A_DB, "MARKER-TENANT-A"],
    [env.TENANT_B_DB, "MARKER-TENANT-B"],
  ] as const) {
    await db.exec("CREATE TABLE IF NOT EXISTS probe (tenant TEXT NOT NULL)");
    await db.exec("DELETE FROM probe");
    await db.prepare("INSERT INTO probe (tenant) VALUES (?)").bind(marker).run();
  }
  // ISO-pub-2/3 price /pub/quote against BOTH tenants. DISTINCT configs (different numbers) so a quote's
  // sell_cents reveals WHICH tenant priced it — the URL host must route the tenant, never a header/param.
  await seedRateConfig(env.TENANT_A_DB, TEST_RATE_CONFIG);
  await seedRateConfig(env.TENANT_B_DB, TENANT_B_RATE_CONFIG);
});

describe("positive control", () => {
  it("tenant-a token reads tenant-a marker", async () => {
    const t = await token({ sub: "u1", tenant: "tenant-a", role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/_probe", { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("MARKER-TENANT-A");
  });
});

describe("adversarial: no request shape reaches tenant B with a tenant-a session", () => {
  const attacks: Array<[string, () => Promise<Response>]> = [
    ["client-supplied tenant header", async () => {
      const t = await token({ sub: "u1", tenant: "tenant-a", role: "ops" });
      return SELF.fetch("https://api.local/v1/_probe", { headers: { Authorization: `Bearer ${t}`, "X-Tenant-Id": "tenant-b" } });
    }],
    ["client-supplied tenant query param", async () => {
      const t = await token({ sub: "u1", tenant: "tenant-a", role: "ops" });
      return SELF.fetch("https://api.local/v1/_probe?tenant=tenant-b", { headers: { Authorization: `Bearer ${t}` } });
    }],
    ["forged token for tenant-b (wrong secret)", async () => {
      const t = await token({ sub: "u1", tenant: "tenant-b", role: "ops" }, "attacker-secret");
      return SELF.fetch("https://api.local/v1/_probe", { headers: { Authorization: `Bearer ${t}` } });
    }],
    ["unsigned garbage token", async () =>
      SELF.fetch("https://api.local/v1/_probe", { headers: { Authorization: "Bearer eyJhbGciOiJub25lIn0.eyJ0ZW5hbnQiOiJ0ZW5hbnQtYiJ9." } }),
    ],
  ];

  it.each(attacks.map(([name], i) => [name, i] as const))("%s is rejected and leaks nothing", async (_name, i) => {
    const attack = attacks[i];
    if (!attack) throw new Error("attack index out of range");
    const res = await attack[1]();
    expect(res.status).toBeGreaterThanOrEqual(401);
    const text = await res.text();
    expect(text).not.toContain("MARKER-TENANT-B");
  });

  it("a valid tenant-b session never sees tenant-a data (symmetry)", async () => {
    const t = await token({ sub: "u2", tenant: "tenant-b", role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/_probe", { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("MARKER-TENANT-B");
    expect(text).not.toContain("MARKER-TENANT-A");
  });
});

// WP-02 growth: the same attack shapes now aimed at the ledger event/position routes (REQ-015 routes
// are just as untrusted as /v1/_probe). tenant + party come from the JWT claim only.
describe("REQ-025 growth: the ledger routes reject the same cross-tenant attacks", () => {
  const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });

  it("a tenant-a session GETting a tenant-b shipment id reads tenant-a's D1 (empty), never tenant-b's", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    // tenantDb keys the D1 handle off the claim, so this can only ever touch tenant-a. A tenant-b
    // shipment lives in a DIFFERENT physical D1 the session can never address -> zero rows.
    const res = await SELF.fetch("https://api.local/v1/shipments/tenant-b-only-shipment/events", { headers: bearer(t) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[] };
    expect(body.events).toEqual([]);
  });

  it("a tenant-a session GETting a tenant-b shipment's documents reads tenant-a's D1 (empty), never tenant-b's (REQ-085)", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    // The docs list is keyed off the JWT claim via tenantDb, exactly like the events read. A tenant-b
    // shipment lives in a DIFFERENT physical D1 the tenant-a session can never address -> zero rows.
    const res = await SELF.fetch("https://api.local/v1/shipments/tenant-b-only-shipment/documents", { headers: bearer(t) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { documents: unknown[] };
    expect(body.documents).toEqual([]);
  });

  it("a tenant-a session resolving a tenant-b document id's URL is a plain 404, never a cross-tenant read (REQ-085)", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    // The resolver looks the doc up in the session tenant's D1 only — a doc id that lives (if at all) in
    // tenant-b's D1 is simply not found here. No signed URL, no bytes, no existence oracle.
    const res = await SELF.fetch("https://api.local/v1/documents/tenant-b-only-doc/url", { headers: bearer(t) });
    expect(res.status).toBe(404);
  });

  it("X-Tenant-Id header on POST /v1/shipments/:id/events is rejected at auth (TENANT_MISMATCH)", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/shipments/x/events", {
      method: "POST",
      headers: { ...bearer(t), "X-Tenant-Id": "tenant-b", "Idempotency-Key": "k", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("?tenant= query param on the GET route is rejected at auth", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/shipments/x/events?tenant=tenant-b", { headers: bearer(t) });
    expect(res.status).toBe(403);
  });

  it("?tenant= query param on the firehose is rejected at auth", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/events?tenant=tenant-b", { headers: bearer(t) });
    expect(res.status).toBe(403);
  });

  it("a forged tenant-b token (wrong secret) cannot append to any route (401)", async () => {
    const t = await token({ sub: "u1", tenant: "tenant-b", role: "ops" }, "attacker-secret");
    const res = await SELF.fetch("https://api.local/v1/shipments/x/events", {
      method: "POST",
      headers: { ...bearer(t), "Idempotency-Key": "k", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  // WP-09 Task 8 growth (REQ-085): the NARROW portal action seams are lens-gated and tenant-scoped. A tenant-a
  // session naming a tenant-b shipment reads tenant-a's D1 (keyed off the JWT claim via tenantDb) — a tenant-b
  // shipment lives in a DIFFERENT physical D1 the session can never address → zero visible events → 403
  // (fail-closed). NOTHING is appended, no cross-tenant read occurs.
  it("accept-quote on a tenant-b shipment id is a fail-closed 403 (reads tenant-a's D1, never tenant-b's)", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/shipments/tenant-b-only-shipment/accept-quote", {
      method: "POST",
      headers: { ...bearer(t), "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
      body: JSON.stringify({ quote_event_id: "whatever" }),
    });
    expect(res.status).toBe(403);
  });

  it("claim on a tenant-b shipment id is a fail-closed 403 (reads tenant-a's D1, never tenant-b's)", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/shipments/tenant-b-only-shipment/claim", {
      method: "POST",
      headers: { ...bearer(t), "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
      body: JSON.stringify({ description: "cross-tenant probe" }),
    });
    expect(res.status).toBe(403);
  });

  it("X-Tenant-Id header on POST /v1/shipments/:id/accept-quote is rejected at auth (TENANT_MISMATCH)", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/shipments/x/accept-quote", {
      method: "POST",
      headers: { ...bearer(t), "X-Tenant-Id": "tenant-b", "Idempotency-Key": "k", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("X-Tenant-Id header on POST /v1/positions is rejected at auth", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "driver" });
    const res = await SELF.fetch("https://api.local/v1/positions", {
      method: "POST",
      headers: { ...bearer(t), "X-Tenant-Id": "tenant-b", "Idempotency-Key": "k", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });
});

// WP-09 Task 4 growth (REQ-051/189): the SECOND no-auth surface, POST /pub/quote. It has NO JWT to key the
// tenant off, so tenant resolution is the CF-routed URL HOSTNAME via a static HOST_TENANTS allowlist — never
// the client-forgeable Host header, never a ?tenant=/X-Tenant-Id hint. These cases prove that boundary.
describe("REQ-025/167 growth: /pub/quote resolves tenant from the URL host, never a client hint", () => {
  const PRICED = { origin_zip: "97201", dest_zip: "80012", weight_lb: 1000, dims: { l_in: 48, w_in: 40, h_in: 48, pieces: 2 } };
  async function pubQuote(url: string, headers?: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await SELF.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(headers ?? {}) },
      body: JSON.stringify(PRICED),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  }

  // ISO-pub-2 — the URL hostname is routing-authoritative; the Host header and an unknown host are not.
  describe("ISO-pub-2: tenant from new URL(url).hostname allowlist", () => {
    it("the api.local URL host prices against tenant-a (PRICED)", async () => {
      const r = await pubQuote("https://api.local/pub/quote");
      expect(r.status).toBe(200);
      expect(r.json.status).toBe("PRICED");
    });

    it("a DIFFERENT URL host (tenant-b.example) routes to tenant-b — distinct config, distinct price", async () => {
      const a = await pubQuote("https://api.local/pub/quote");
      const b = await pubQuote("https://tenant-b.example/pub/quote");
      expect(b.status).toBe(200);
      expect(b.json.status).toBe("PRICED");
      // priced against tenant-b's OWN config, which is numerically distinct from tenant-a's.
      expect(b.json.sell_cents).not.toBe(a.json.sell_cents);
    });

    it("a spoofed Host header is IGNORED — URL host api.local still prices tenant-a", async () => {
      const a = await pubQuote("https://api.local/pub/quote");
      const spoof = await pubQuote("https://api.local/pub/quote", { Host: "tenant-b.example" });
      expect(spoof.status).toBe(200);
      expect(spoof.json.status).toBe("PRICED");
      expect(spoof.json.sell_cents).toBe(a.json.sell_cents); // NOT tenant-b's price — the Host header never routes
    });

    it("an unknown URL host is 404 (before any DB handle — no tenant-existence oracle)", async () => {
      const r = await pubQuote("https://not-a-tenant.example/pub/quote");
      expect(r.status).toBe(404);
    });
  });

  // ISO-pub-3 — parity with auth.ts:12-14 (client tenant hints never resolve a tenant), even though the
  // /v1 auth middleware does NOT run on /pub/*. The public route simply never READS these — it prices the
  // URL-host tenant regardless, so the hint is inert (ignored), not honored.
  describe("ISO-pub-3: client ?tenant= / X-Tenant-Id are ignored on /pub/quote", () => {
    it("?tenant=tenant-b is ignored — still prices the URL-host tenant (tenant-a)", async () => {
      const base = await pubQuote("https://api.local/pub/quote");
      const hinted = await pubQuote("https://api.local/pub/quote?tenant=tenant-b");
      expect(hinted.status).toBe(200);
      expect(hinted.json.status).toBe("PRICED");
      expect(hinted.json.sell_cents).toBe(base.json.sell_cents);
    });

    it("X-Tenant-Id: tenant-b is ignored — still tenant-a", async () => {
      const base = await pubQuote("https://api.local/pub/quote");
      const hinted = await pubQuote("https://api.local/pub/quote", { "X-Tenant-Id": "tenant-b" });
      expect(hinted.status).toBe(200);
      expect(hinted.json.status).toBe("PRICED");
      expect(hinted.json.sell_cents).toBe(base.json.sell_cents);
    });
  });

  // ISO-pub-5 — share-lint parity (skill share-lint-matchers-with-parity-tests): the public host allowlist can
  // never resolve a tenant the CORE allowlist does not bind. One rule (values(HOST_TENANTS) ⊆ keys(TENANT_BINDINGS))
  // guarded where both maps are the input — a new HOST_TENANTS row pointing at an unbound tenant fails HERE.
  describe("ISO-pub-5: HOST_TENANTS ⊆ TENANT_BINDINGS", () => {
    it("every hostname resolves only to a tenant TENANT_BINDINGS binds", () => {
      const bound = new Set(Object.keys(TENANT_BINDINGS));
      const mapped = Object.values(HOST_TENANTS);
      expect(mapped.length).toBeGreaterThan(0);
      for (const slug of mapped) {
        expect(bound.has(slug), `HOST_TENANTS maps to an UNBOUND tenant: ${slug}`).toBe(true);
      }
    });
  });
});

// WP-09 Task 5 growth (REQ-025): the THIRD public read, GET /pub/status/:cap. The cap carries a MAC-signed
// tenant `t`, and the ONLY tenant→D1 path is that verified `t` fed through tenantDb — never the shipment id,
// never anything client-supplied. These cases prove a cap minted for one tenant can never surface another's
// data, and that a cap for a tenant the core allowlist does not bind fails closed.
describe("REQ-025 growth: /pub/status/:cap reads ONLY the cap's MAC-verified tenant", () => {
  // The SAME shipment id is seeded in BOTH tenants with a DIFFERENT status_cache state, so the ONLY thing that
  // can select which state surfaces is the cap's `t`. If any cross-tenant bleed existed, the states would be
  // confusable — they are not: `t` alone routes the physical D1 (tenantDb), and `s` is looked up only there.
  const ISO1_SHARED_SHP = "iso-pub-1-shared-id"; // exists in tenant-a AND tenant-b, distinct status each
  const ISO1_A_STATE = "iso1-tenant-a-state";
  const ISO1_B_STATE = "iso1-tenant-b-state";

  async function seedStatus(db: D1Database, id: string, state: string): Promise<void> {
    await db
      .prepare("INSERT OR IGNORE INTO shipments (id, shipper_party_id, consignee_party_id, bill_to_party_id, status_cache, created_ts) VALUES (?,?,?,?,?,0)")
      .bind(id, "party-shipper", "party-consignee", "party-bill-to", JSON.stringify({ state }))
      .run();
  }
  async function getStatus(cap: string): Promise<{ status: number; json: Record<string, unknown> | null }> {
    const res = await SELF.fetch(`https://api.local/pub/status/${cap}`);
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: res.status, json };
  }

  beforeAll(async () => {
    // schema for both tenants is ensured by the file-level beforeAll; seed the twin shipments here.
    await seedStatus(env.TENANT_A_DB, ISO1_SHARED_SHP, ISO1_A_STATE);
    await seedStatus(env.TENANT_B_DB, ISO1_SHARED_SHP, ISO1_B_STATE);
  });

  // ISO-pub-1 — a cap minted for tenant-b reads tenant-b's status_cache, NEVER tenant-a's (same id, both DBs).
  describe("ISO-pub-1: the cap's tenant is the only D1 selector", () => {
    it("a tenant-b cap surfaces tenant-b's state, never tenant-a's (identical shipment id in both DBs)", async () => {
      const cap = await mintStatusCap(JWT_SECRET, { t: "tenant-b", s: ISO1_SHARED_SHP, expSeconds: nowS() + 3600 });
      const r = await getStatus(cap);
      expect(r.status).toBe(200);
      expect(r.json?.state).toBe(ISO1_B_STATE);
      expect(r.json?.state).not.toBe(ISO1_A_STATE); // tenant-a's row for the same id is never reached
    });

    it("the tenant-a cap for the same id surfaces tenant-a's state (symmetry — the selector is `t`, not `s`)", async () => {
      const cap = await mintStatusCap(JWT_SECRET, { t: TENANT_SLUG, s: ISO1_SHARED_SHP, expSeconds: nowS() + 3600 });
      const r = await getStatus(cap);
      expect(r.status).toBe(200);
      expect(r.json?.state).toBe(ISO1_A_STATE);
      expect(r.json?.state).not.toBe(ISO1_B_STATE);
    });

    it("a cap whose `t` is an UNBOUND tenant fails closed to the uniform 401 (tenantDb has no handle)", async () => {
      // MAC-valid (we mint it), but `tenant-c` is not in TENANT_BINDINGS -> tenantDb throws -> the handler's
      // fail-closed catch returns the SAME 401 as a bad cap. No tenant-existence oracle, no cross-tenant read.
      const cap = await mintStatusCap(JWT_SECRET, { t: "tenant-c", s: ISO1_SHARED_SHP, expSeconds: nowS() + 3600 });
      const r = await getStatus(cap);
      expect(r.status).toBe(401);
    });
  });
});

// ISO-pub-4 — the MINT route bakes the cap's `t` from session.tenant ALONE, never from `:id` or any input.
// A tenant-a session therefore can never mint a cap that reads tenant-b, whatever `:id` it names.
describe("REQ-025 growth: POST /v1/shipments/:id/status-link bakes cap.t from the session, never :id", () => {
  const ISO4_SHP = "iso-pub-4-shipment"; // a tenant-a shipment with an event, so the mint lens gate passes

  function bookingInput(shipmentId: string): Record<string, unknown> {
    return {
      id: crypto.randomUUID(),
      shipment_id: shipmentId,
      ts: 1_720_000_000_000,
      actor: { party: "party-shipper" },
      party_refs: ["party-consignee"],
      evidence: [],
      source: "native",
      confidence: 10_000,
      kind: "booking.created",
      payload: {
        quote_event_id: "evt-quote-iso4",
        division: "main",
        shipper_party_id: "party-shipper",
        consignee_party_id: "party-consignee",
        bill_to_party_id: "party-bill-to",
      },
    };
  }

  beforeAll(async () => {
    // The mint route resolves :id through the caller's lens and 403s on zero visible rows (fail-closed), so
    // seed ONE real event on the stream (ops lens = tenant-wide) to reach the actual mint.
    const ops = await token({ sub: "iso4-seed-ops", tenant: TENANT_SLUG, role: "ops" });
    const b = await post(ISO4_SHP, bookingInput(ISO4_SHP), ops);
    if (b.status !== 201) throw new Error(`seed ${ISO4_SHP}/booking failed: ${b.status} ${JSON.stringify(b.json)}`);
  });

  it("the minted cap decodes to t === session.tenant (tenant-a); :id only ever lands in `s`", async () => {
    const ops = await token({ sub: "iso4-ops", tenant: TENANT_SLUG, role: "ops" });
    const res = await SELF.fetch(`https://api.local/v1/shipments/${ISO4_SHP}/status-link`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ops}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cap: string };
    const claims = await verifyStatusCap(body.cap, JWT_SECRET);
    expect(claims.t).toBe(TENANT_SLUG); // baked from session.tenant, NOT from :id or any input
    expect(claims.t).toBe("tenant-a");
    expect(claims.s).toBe(ISO4_SHP); // the :id is the shipment (`s`) only — it can never become the tenant
  });
});
