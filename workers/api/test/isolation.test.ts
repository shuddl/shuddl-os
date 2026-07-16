import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ensureSchema,
  ensureTenantBSchema,
  seedRateConfig,
  TEST_RATE_CONFIG,
  TENANT_B_RATE_CONFIG,
  token,
  TENANT_SLUG,
} from "./helpers.js";
import { HOST_TENANTS } from "../src/pub/quote.js";
import { TENANT_BINDINGS } from "../src/tenants.js";

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
