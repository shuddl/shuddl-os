import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureSchema, token, TENANT_SLUG } from "./helpers.js";

// REQ-025: cross-tenant read anywhere = build failure. This suite runs on every merge, forever.
// It grows a case for every read path added in later WPs — WP-02 adds the ledger event/position routes.

beforeAll(async () => {
  await ensureSchema(env); // the ledger-route cases below need tenant-a's events table
  for (const [db, marker] of [
    [env.TENANT_A_DB, "MARKER-TENANT-A"],
    [env.TENANT_B_DB, "MARKER-TENANT-B"],
  ] as const) {
    await db.exec("CREATE TABLE IF NOT EXISTS probe (tenant TEXT NOT NULL)");
    await db.exec("DELETE FROM probe");
    await db.prepare("INSERT INTO probe (tenant) VALUES (?)").bind(marker).run();
  }
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
