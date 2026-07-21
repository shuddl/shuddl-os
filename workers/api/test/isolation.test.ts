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
import { eventFixture, type EventKind } from "@shuddl/contracts";
import { eventToRow } from "@shuddl/ledger/lens";
import { computeUnbilled } from "../src/kpis/compute.js";
import { computeModuleParity } from "@shuddl/ledger/parity";

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

  // WP-10 Task 2 growth (REQ-082/194/025): the approvals QUEUE routes are tenant-scoped off the JWT claim.
  // The read lists ONLY the claim tenant's `approvals` (a DIFFERENT physical D1 than tenant-b's), and the
  // decision write on a tenant-b-only shipment reads tenant-a's D1 (no open approval → clean 404), never crosses.
  it("GET /v1/approvals for a tenant-a session never returns a tenant-b approval row (REQ-025)", async () => {
    // Seed a UNIQUELY-marked OPEN approval into tenant-b's D1 only. tenant-a's list is keyed off the claim via
    // tenantDb, so it can never physically address this row.
    await env.TENANT_B_DB.prepare(
      "INSERT OR IGNORE INTO approvals (id, object_kind, object_id, rule, required_role, requested_event_id, status) VALUES (?,?,?,?,?,?,?)",
    )
      .bind("iso-appr-b", "shipment", "iso-appr-tenant-b-only", "below_target_or", "ops", "req-b", "open")
      .run();
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/approvals?status=open", { headers: bearer(t) });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("iso-appr-tenant-b-only"); // tenant-b's queue never bleeds into tenant-a's read
  });

  it("approval-decision on a tenant-b shipment id reads tenant-a's D1 → clean 404, never tenant-b's (REQ-025)", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "finance" });
    const res = await SELF.fetch("https://api.local/v1/shipments/tenant-b-only-shipment/approval-decision", {
      method: "POST",
      headers: { ...bearer(t), "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(res.status).toBe(404); // no open approval in tenant-a's D1 — no cross-tenant read, no append
  });

  it("X-Tenant-Id header on POST /v1/shipments/:id/approval-decision is rejected at auth (TENANT_MISMATCH)", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "finance" });
    const res = await SELF.fetch("https://api.local/v1/shipments/x/approval-decision", {
      method: "POST",
      headers: { ...bearer(t), "X-Tenant-Id": "tenant-b", "Idempotency-Key": "k", "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(res.status).toBe(403);
  });

  it("?tenant= query param on GET /v1/approvals is rejected at auth", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/approvals?tenant=tenant-b&status=open", { headers: bearer(t) });
    expect(res.status).toBe(403);
  });

  // WP-10 Task 6 growth (REQ-150/195/025): the CSR net-new intake WRITE seams are tenant-scoped off the JWT
  // claim (tenantDb) and reject any client tenant hint at auth. A tenant-a session's party/shipment can only
  // ever land in tenant-a's physical D1 — a DIFFERENT D1 than tenant-b's, which the session can never address.
  it("X-Tenant-Id header on POST /v1/parties is rejected at auth (TENANT_MISMATCH)", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/parties", {
      method: "POST",
      headers: { ...bearer(t), "X-Tenant-Id": "tenant-b", "Idempotency-Key": "k", "content-type": "application/json" },
      body: JSON.stringify({ kind: "shipper", name: "x", email: "x@iso.test" }),
    });
    expect(res.status).toBe(403);
  });

  it("X-Tenant-Id header on POST /v1/shipments is rejected at auth (TENANT_MISMATCH)", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/shipments", {
      method: "POST",
      headers: { ...bearer(t), "X-Tenant-Id": "tenant-b", "Idempotency-Key": "k", "content-type": "application/json" },
      body: JSON.stringify({ shipper_party_id: "a", consignee_party_id: "b", bill_to_party_id: "c" }),
    });
    expect(res.status).toBe(403);
  });

  it("?tenant= query param on POST /v1/parties is rejected at auth", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/parties?tenant=tenant-b", {
      method: "POST",
      headers: { ...bearer(t), "Idempotency-Key": "k", "content-type": "application/json" },
      body: JSON.stringify({ kind: "shipper", name: "x", email: "x@iso.test" }),
    });
    expect(res.status).toBe(403);
  });

  it("a tenant-a session's created party lands in tenant-a's D1 ONLY, never tenant-b's (REQ-025)", async () => {
    // A uniquely-marked email so the assertion is unambiguous across the shared physical D1s.
    const marker = "iso-intake-tenant-a-only@iso-intake.test";
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/parties", {
      method: "POST",
      headers: { ...bearer(t), "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
      body: JSON.stringify({ kind: "shipper", name: "Iso Intake Co", email: marker }),
    });
    expect(res.status).toBe(201);
    const byEmail = async (db: D1Database): Promise<number> =>
      (await db.prepare("SELECT COUNT(*) AS n FROM parties p, json_each(p.contacts) je WHERE json_extract(je.value, '$.email') = ?").bind(marker).first<{ n: number }>())?.n ?? 0;
    expect(await byEmail(env.TENANT_A_DB)).toBe(1); // the write keyed off the tenant-a claim landed here
    expect(await byEmail(env.TENANT_B_DB)).toBe(0); // and NEVER in tenant-b's D1 (a different physical handle)
  });

  it("a tenant-a session's created shipment lands in tenant-a's D1 ONLY, never tenant-b's (REQ-025)", async () => {
    // The three party FKs exist in BOTH tenants (the shared cast seeded by ensure*Schema), so the write's ONLY
    // tenant selector is the JWT claim (tenantDb). The shipment id folds the tenant in AND is derived server-side,
    // so it can only ever be addressed inside — and land in — tenant-a's physical D1.
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/shipments", {
      method: "POST",
      headers: { ...bearer(t), "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
      body: JSON.stringify({ shipper_party_id: "party-shipper", consignee_party_id: "party-consignee", bill_to_party_id: "party-bill-to" }),
    });
    expect(res.status).toBe(201);
    const shipmentId = ((await res.json()) as { shipment_id: string }).shipment_id;
    const existsIn = async (db: D1Database): Promise<number> =>
      (await db.prepare("SELECT COUNT(*) AS n FROM shipments WHERE id = ?").bind(shipmentId).first<{ n: number }>())?.n ?? 0;
    expect(await existsIn(env.TENANT_A_DB)).toBe(1); // the write keyed off the tenant-a claim landed here
    expect(await existsIn(env.TENANT_B_DB)).toBe(0); // and NEVER in tenant-b's D1 (a different physical handle)
  });
});

// WP-10 Task 9 growth (REQ-073/080 + REQ-025): the command BOARD is the live fleet — active shipments + their
// latest position — read WITHIN the session's D1 (tenantDb off the JWT claim), never across tenants. A tenant-b
// active shipment WITH a position (in a DIFFERENT physical D1) must never surface as a mark in a tenant-a board.
describe("REQ-025 growth: GET /v1/board reads ONLY the JWT tenant's fleet", () => {
  const B_BOARD_SHP = "iso-board-tenant-b-only"; // a tenant-b active shipment — must NEVER appear in a tenant-a board

  beforeAll(async () => {
    // Seed a tenant-b active shipment + a latest position into tenant-b's D1 ONLY. tenant-a's board is keyed off
    // the claim via tenantDb, so it can never physically address this row.
    await env.TENANT_B_DB.prepare(
      "INSERT OR IGNORE INTO shipments (id, shipper_party_id, consignee_party_id, bill_to_party_id, status_cache, created_ts) VALUES (?,?,?,?,?,0)",
    )
      .bind(B_BOARD_SHP, "party-shipper", "party-consignee", "party-bill-to", JSON.stringify({ state: "in_transit" }))
      .run();
    await env.TENANT_B_DB.prepare(
      "INSERT OR IGNORE INTO positions (shipment_id, device_id, ts, recorded_at, lat_e6, lon_e6, accuracy_m, speed_cms, hash) VALUES (?,?,?,?,?,?,?,?,?)",
    )
      .bind(B_BOARD_SHP, "device-b", 9999, 0, 42_000_000, -71_000_000, null, null, "h-iso-board-b")
      .run();
  });

  it("a tenant-a session GETting /v1/board never returns a tenant-b shipment (REQ-025)", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/board", { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(B_BOARD_SHP); // tenant-b's fleet never bleeds into tenant-a's board
  });

  it("?tenant= query param on GET /v1/board is rejected at auth", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/board?tenant=tenant-b", { headers: { Authorization: `Bearer ${t}` } });
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

// WP-11 Task 7 growth (REQ-032 + REQ-025): the Collector dunning human-send surface is tenant-scoped off the JWT
// claim (tenantDb). A tenant-a operator must NEVER see a tenant-b draft in its queue, and a send named at a
// tenant-b draft id reads tenant-a's D1 (a DIFFERENT physical D1) → no such draft → a clean 404, never a cross read.
describe("REQ-025 growth: the Collector dunning surface reads ONLY the JWT tenant's D1", () => {
  const B_DUN_INV = "iso-dun-tenant-b-only"; // a tenant-b dunning draft — must NEVER appear in a tenant-a queue
  const B_DUN_DRAFT_ID = `msg:dunning:${B_DUN_INV}:reminder`;
  const B_DUN_BODY_REF = `collector-dunning/${B_DUN_INV}/reminder`;

  beforeAll(async () => {
    // Seed a party + open overdue invoice + a Collector DRAFT into tenant-b's D1 ONLY. tenant-a's queue is keyed
    // off the claim via tenantDb, so it can never physically address these rows.
    await env.TENANT_B_DB.prepare("INSERT OR IGNORE INTO parties (id, kind, names, contacts) VALUES (?,?,?,?)")
      .bind("iso-dun-party-b", "shipper", "{}", JSON.stringify([{ kind: "billing", email: "billing@iso-dun-b.example.com" }]))
      .run();
    await env.TENANT_B_DB.prepare(
      "INSERT OR IGNORE INTO invoices (id, party_id, division, shipment_ids, total_cents, status, issued_event_id, terms, due_ts) VALUES (?,?,?,?,?,?,?,?,?)",
    )
      .bind(B_DUN_INV, "iso-dun-party-b", "main", "[]", 100_000, "issued", `evt-${B_DUN_INV}`, "net30", 0)
      .run();
    await env.TENANT_B_DB.prepare(
      "INSERT OR IGNORE INTO messages (id, channel, direction, party_id, shipment_id, resolved_conf, thread, body_ref, drafted_by_agent, sla_due_ts) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(B_DUN_DRAFT_ID, "email", "out", "iso-dun-party-b", null, null, null, B_DUN_BODY_REF, "collector", null)
      .run();
  });

  it("a tenant-a session GETting /v1/dunning never returns a tenant-b draft (REQ-025)", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/dunning?status=draft", { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(B_DUN_INV); // tenant-b's draft never bleeds into tenant-a's queue
  });

  it("a send named at a tenant-b draft id reads tenant-a's D1 → clean 404, never tenant-b's (REQ-025)", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "finance" });
    const res = await SELF.fetch(`https://api.local/v1/dunning/${encodeURIComponent(B_DUN_DRAFT_ID)}/send`, {
      method: "POST",
      headers: { ...{ Authorization: `Bearer ${t}` }, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404); // no such draft in tenant-a's D1 — no cross-tenant read, no append, no send
  });

  it("?tenant= query param on GET /v1/dunning is rejected at auth", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/dunning?tenant=tenant-b&status=draft", { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status).toBe(403);
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

// WP-10 Task 1 growth (REQ-082/083 + REQ-025): the firehose KIND FILTER is still keyed off the JWT claim via
// tenantDb — it narrows a read WITHIN the session's D1, it never reaches across tenants. The SAME kind is
// seeded in BOTH physical D1s with a tenant-distinguishing shipment id; a tenant-a `?kind=` firehose surfaces
// tenant-a's marker and NEVER tenant-b's (a different D1 the claim can never address).
describe("REQ-025 growth: a kind-filtered firehose read reads ONLY the JWT tenant's D1", () => {
  const A_SHP = "iso-kindfilter-a"; // tenant-a marker
  const B_SHP = "iso-kindfilter-b"; // tenant-b marker — must NEVER appear in a tenant-a read
  const KIND: EventKind = "authority.flipped";
  let isoHashN = 0xa0000;
  const isoHash = (): string => (isoHashN++).toString(16).padStart(64, "0");

  async function seedKindEvent(db: D1Database, shipmentId: string): Promise<void> {
    // Direct insert (bypasses the sequencer/route — we are proving the READ path). A unique 64-hex hash keeps
    // the UNIQUE(hash) + append-only insert guard happy; prev_hash is the fixture genesis (valid Hash64).
    const e = eventFixture(KIND, { id: crypto.randomUUID(), stream_id: `s:${shipmentId}`, shipment_id: shipmentId, seq: 0, visibility: "counterparty", party_refs: [] });
    const row = eventToRow(e);
    row.hash = isoHash();
    const cols = Object.keys(row);
    await db.prepare(`INSERT INTO events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).bind(...cols.map((c) => row[c])).run();
  }

  beforeAll(async () => {
    await seedKindEvent(env.TENANT_A_DB, A_SHP);
    await seedKindEvent(env.TENANT_B_DB, B_SHP);
  });

  it("a tenant-a session GETting /v1/events?kind= surfaces tenant-a's marker, never tenant-b's", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    const res = await SELF.fetch(`https://api.local/v1/events?kind=${KIND}&limit=1000`, { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ kind: string; shipment_id?: string }> };
    expect(body.events.every((e) => e.kind === KIND)).toBe(true); // the filter is honored
    expect(body.events.some((e) => e.shipment_id === A_SHP)).toBe(true); // tenant-a's own marker is present
    expect(body.events.some((e) => e.shipment_id === B_SHP)).toBe(false); // tenant-b's marker is never reached
  });
});

// WP-10 Task 3 growth (REQ-082 + REQ-025): the exceptions QUEUE is a DURABLE read over exception.raised/
// osd.captured events, keyed off the JWT claim via tenantDb — it reads WITHIN the session's D1, never across
// tenants. A tenant-b-only exception event (in a DIFFERENT physical D1) must never surface in a tenant-a read.
describe("REQ-025 growth: the exceptions queue reads ONLY the JWT tenant's D1", () => {
  const B_EXC_SHP = "iso-exc-tenant-b-only"; // a tenant-b exception marker — must NEVER appear in a tenant-a read
  let excHashN = 0xb0000;
  const excHash = (): string => (excHashN++).toString(16).padStart(64, "0");

  beforeAll(async () => {
    // Direct-insert an exception.raised into tenant-b's D1 only (bypasses the sequencer — we prove the READ path).
    const e = eventFixture("exception.raised", {
      id: crypto.randomUUID(),
      stream_id: `s:${B_EXC_SHP}`,
      shipment_id: B_EXC_SHP,
      seq: 0,
      visibility: "internal",
      party_refs: [],
      payload: { photo_hash: "b".repeat(64), reason_code: "damage" },
    });
    const row = eventToRow(e);
    row.hash = excHash();
    const cols = Object.keys(row);
    await env.TENANT_B_DB.prepare(`INSERT INTO events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
      .bind(...cols.map((col) => row[col]))
      .run();
  });

  it("a tenant-a session GETting /v1/exceptions never returns a tenant-b exception (REQ-025)", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/exceptions?status=all", { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(B_EXC_SHP); // tenant-b's exception never bleeds into tenant-a's queue
  });

  it("?tenant= query param on GET /v1/exceptions is rejected at auth", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/exceptions?tenant=tenant-b&status=open", { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status).toBe(403);
  });
});

// WP-10 Task 5 growth (REQ-083 + REQ-025): the KPI strip aggregates ONLY the JWT tenant's D1. It is keyed off the
// claim via tenantDb — it reads WITHIN the session's D1, never across tenants. A tenant-b-only unbilled shipment
// (in a DIFFERENT physical D1) must never count toward tenant-a's KPIs.
describe("REQ-025 growth: the KPI strip reads ONLY the JWT tenant's D1", () => {
  const B_UNBILLED = "iso-kpi-b-unbilled"; // a tenant-b pod.signed-without-invoice — must never count for tenant-a
  let kpiHashN = 0xc0000;
  const kpiHash = (): string => (kpiHashN++).toString(16).padStart(64, "0");

  beforeAll(async () => {
    // Direct-insert a committed pod.signed (no invoice.issued) into tenant-b's D1 ONLY — the exact shape the
    // unbilled anti-join counts. If any cross-tenant bleed existed, tenant-a's scoped compute would see it.
    const e = eventFixture("pod.signed", {
      id: crypto.randomUUID(),
      stream_id: `s:${B_UNBILLED}`,
      shipment_id: B_UNBILLED,
      seq: 0,
      visibility: "internal",
      party_refs: [],
    });
    const row = eventToRow(e);
    row.hash = kpiHash();
    const cols = Object.keys(row);
    await env.TENANT_B_DB.prepare(`INSERT INTO events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
      .bind(...cols.map((col) => row[col]))
      .run();
  });

  it("a tenant-a session's unbilled compute never counts a tenant-b-only shipment (different physical D1)", async () => {
    // Same scope prefix, two physical DBs: tenant-a can never address the tenant-b row (0), tenant-b really has it (1).
    expect(await computeUnbilled(env.TENANT_A_DB, { scope: "iso-kpi-b-" })).toBe(0);
    expect(await computeUnbilled(env.TENANT_B_DB, { scope: "iso-kpi-b-" })).toBe(1);
  });

  it("GET /v1/kpis is a tenant-lens surface (ops 200); ?tenant= is rejected at auth", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    const ok = await SELF.fetch("https://api.local/v1/kpis", { headers: { Authorization: `Bearer ${t}` } });
    expect(ok.status).toBe(200);
    const spoof = await SELF.fetch("https://api.local/v1/kpis?tenant=tenant-b", { headers: { Authorization: `Bearer ${t}` } });
    expect(spoof.status).toBe(403); // tenant is resolved server-side, never client-supplied
  });
});

// WP-15 Task 6 growth (REQ-023/152/153 + REQ-025): the v_parity dashboard compute reads native-vs-legacy split
// ONLY within the JWT tenant's own D1 (computeAllParity(tenantDb(session.tenant))). A tenant-b-only LEGACY mirror
// event (in a DIFFERENT physical D1) must NEVER surface in tenant-a's parity — otherwise a neighbor's incumbent
// export could fabricate (or poison) tenant-a's shadow-parity verdict and green a flip it should not.
describe("REQ-025 growth: the v_parity compute reads ONLY the JWT tenant's D1 (source-split)", () => {
  const B_LEG_INV = "iso-parity-b-legacy-inv"; // a tenant-b legacy invoice.issued — must never count for tenant-a
  let pHashN = 0xe0000;
  const pHash = (): string => (pHashN++).toString(16).padStart(64, "0");

  beforeAll(async () => {
    await ensureTenantBSchema(env);
    // Direct-insert a LEGACY-source invoice.issued into tenant-b's D1 ONLY — the exact shape the invoicing parity
    // sums on the legacy side. If any cross-tenant bleed existed, tenant-a's parity would see a legacy mirror.
    const e = eventFixture("invoice.issued", {
      id: crypto.randomUUID(),
      stream_id: `s:${B_LEG_INV}`,
      shipment_id: B_LEG_INV,
      seq: 0,
      source: "legacy",
      visibility: "internal",
      party_refs: [],
      payload: { invoice_id: "iso-b-inv", party_id: "party-bill-to", division: "main", lines: [{ line_no: 1, kind: "freight", amount_cents: 654_321, gl_map: "4000-REV" }] },
    });
    const row = eventToRow(e);
    row.hash = pHash();
    const cols = Object.keys(row);
    await env.TENANT_B_DB.prepare(`INSERT INTO events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
      .bind(...cols.map((c) => row[c]))
      .run();
  });

  it("tenant-a's invoicing parity never sees the tenant-b-only legacy mirror (its legacy side stays UNKNOWN); tenant-b really has it", async () => {
    // tenant-a has native invoices (other suites) but NO legacy mirror → legacy side UNKNOWN. tenant-b has the
    // legacy row in its OWN physical D1 → its legacy side is exactly the seeded total. Cross-tenant bleed = 0.
    const a = await computeModuleParity(env.TENANT_A_DB, "invoicing");
    expect(a.legacy_value).toBe("UNKNOWN"); // tenant-a can never physically address tenant-b's legacy event
    const b = await computeModuleParity(env.TENANT_B_DB, "invoicing");
    expect(b.legacy_value).toBe(654_321); // tenant-b really carries it, in its own D1
  });

  it("GET /v1/parity is a tenant-lens surface (ops 200); ?tenant= is rejected at auth", async () => {
    const t = await token({ sub: "u-parity-iso", tenant: TENANT_SLUG, role: "ops" });
    const ok = await SELF.fetch("https://api.local/v1/parity", { headers: { Authorization: `Bearer ${t}` } });
    expect(ok.status).toBe(200);
    const spoof = await SELF.fetch("https://api.local/v1/parity?tenant=tenant-b", { headers: { Authorization: `Bearer ${t}` } });
    expect(spoof.status).toBe(403); // tenant is resolved server-side, never client-supplied
  });
});

// WP-10 Task 7 growth (REQ-038 + REQ-025): the copilot answers ONLY over the JWT tenant's D1, through the
// caller's lens. Its read port is readEvents(db, lensFor(session), q) keyed off the claim via tenantDb — it
// can never ground an answer on another tenant's events. A tenant-b-only exception (in a DIFFERENT physical
// D1) must never appear in a tenant-a copilot answer or its citations.
describe("REQ-025 growth: the copilot cites ONLY the JWT tenant's D1 (lens-scoped)", () => {
  const B_COPILOT_SHP = "iso-copilot-tenant-b-only"; // a tenant-b exception marker — must NEVER surface for tenant-a
  let cpHashN = 0xd0000;
  const cpHash = (): string => (cpHashN++).toString(16).padStart(64, "0");

  beforeAll(async () => {
    // Direct-insert an exception.raised into tenant-b's D1 only (bypasses the sequencer — we prove the READ path).
    const e = eventFixture("exception.raised", {
      id: crypto.randomUUID(),
      stream_id: `s:${B_COPILOT_SHP}`,
      shipment_id: B_COPILOT_SHP,
      seq: 0,
      visibility: "internal",
      party_refs: [],
      payload: { photo_hash: "d".repeat(64), reason_code: "damage" },
    });
    const row = eventToRow(e);
    row.hash = cpHash();
    const cols = Object.keys(row);
    await env.TENANT_B_DB.prepare(`INSERT INTO events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
      .bind(...cols.map((col) => row[col]))
      .run();
  });

  it("a tenant-a copilot answer never cites a tenant-b exception (REQ-025)", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/copilot/ask", {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
      body: JSON.stringify({ question: "which shipments have open exceptions?" }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(B_COPILOT_SHP); // tenant-b's exception never bleeds into tenant-a's answer/citations
  });

  it("?tenant= query param on POST /v1/copilot/ask is rejected at auth", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/copilot/ask?tenant=tenant-b", {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
      body: JSON.stringify({ question: "which shipments have open exceptions?" }),
    });
    expect(res.status).toBe(403);
  });
});

// WP-11 Task 2 growth (REQ-020 + REQ-025): the QuickBooks journal export reads ONLY the JWT tenant's
// money_lines. exportJournal(tenantDb(session.tenant), …) is keyed off the claim — it aggregates WITHIN the
// session's D1, never across tenants. Seeded in a PRIVATE far-future window so the shared-D1 pollution from
// sibling files never enters the scan: a tenant-a money_line + a tenant-b money_line at the SAME created_ts,
// same window. The tenant-a export MUST include its own row and MUST NOT include tenant-b's (a DIFFERENT
// physical D1 the claim can never address), and no client tenant hint may reach it.
describe("REQ-025 growth: GET /v1/export/journal serializes ONLY the JWT tenant's money_lines", () => {
  const PW_TS = 1_950_000_000_000; // a private window (year ~2031) no sibling file seeds into
  const EXPORT_Q = `from=${PW_TS - 1000}&to=${PW_TS + 1000}`;
  const A_ML_EVENT = crypto.randomUUID(); // a tenant-a money_line's event id — the positive control (MUST appear)
  const B_ML_EVENT = crypto.randomUUID(); // a tenant-b money_line's event id — must NEVER appear for tenant-a
  // A globally-unique 64-hex hash from a random UUID (a shared counter base collides with sibling files).
  const exjHash = (): string => crypto.randomUUID().replace(/-/g, "").padEnd(64, "0");

  async function seedMoneyLine(db: D1Database, eventId: string, shipmentId: string, mlId: string, amount: number): Promise<void> {
    // The event satisfies money_lines' FK; a canonical gl_map (GL_FREIGHT_AR) so the serializer never throws.
    const e = eventFixture("pod.signed", { id: eventId, stream_id: `s:${shipmentId}`, shipment_id: shipmentId, seq: 0, visibility: "internal", party_refs: [] });
    const row = eventToRow(e);
    row.hash = exjHash();
    const cols = Object.keys(row);
    await db.prepare(`INSERT OR IGNORE INTO events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).bind(...cols.map((col) => row[col])).run();
    await db
      .prepare("INSERT OR IGNORE INTO money_lines (id, shipment_id, event_id, line_no, direction, kind, amount_cents, currency, party_id, division, gl_map, created_ts) VALUES (?,?,?,1,?,?,?,?,?,?,?,?)")
      .bind(mlId, shipmentId, eventId, "ar", "freight", amount, "USD", "party-shipper", "main", "4000-FREIGHT-AR", PW_TS)
      .run();
  }

  beforeAll(async () => {
    await seedMoneyLine(env.TENANT_A_DB, A_ML_EVENT, "iso-exj-tenant-a", "iso-exj-ml-a", 123_456); // → 1234.56 (control)
    await seedMoneyLine(env.TENANT_B_DB, B_ML_EVENT, "iso-exj-tenant-b-only", "iso-exj-ml-b", 777_777); // → 7777.77 (must not leak)
  });

  it("a tenant-a IIF export includes ITS OWN money_line but NEVER a tenant-b money_line (REQ-025)", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "finance" });
    const res = await SELF.fetch(`https://api.local/v1/export/journal?${EXPORT_Q}&format=iif`, { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(A_ML_EVENT); // positive control — tenant-a's own row IS exported
    expect(text).toContain("1234.56");
    expect(text).not.toContain(B_ML_EVENT); // the tenant-b event id (MEMO) never appears
    expect(text).not.toContain("7777.77"); // tenant-b's distinctive amount never leaks
  });

  it("a tenant-a JSON export includes ITS OWN money_line but NEVER a tenant-b money_line (REQ-025)", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "finance" });
    const res = await SELF.fetch(`https://api.local/v1/export/journal?${EXPORT_Q}&format=json`, { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(A_ML_EVENT);
    expect(text).not.toContain(B_ML_EVENT);
    expect(text).not.toContain("777777");
  });

  it("?tenant= query param on GET /v1/export/journal is rejected at auth", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "finance" });
    const res = await SELF.fetch(`https://api.local/v1/export/journal?tenant=tenant-b&${EXPORT_Q}`, { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status).toBe(403);
  });
});

// WP-11 Task 5 growth (REQ-010 + REQ-025): the FULL TENANT EXPORT is single-tenant by construction. GET /v1/export
// reads ONLY the JWT tenant's D1 — events via readEvents(tenantDb, lensFor(session)), journal via exportJournal
// (tenantDb), documents + anchors straight off the tenant's `documents` table — all keyed off the claim (tenantDb).
// A tenant-a admin export MUST contain tenant-a's own record and MUST NOT contain ANY tenant-b event/journal/
// document/anchor (a DIFFERENT physical D1 the claim can never address), and no client tenant hint may reach it.
describe("REQ-025 growth: GET /v1/export is a SINGLE-TENANT export — never crosses to tenant-b", () => {
  const XPW_TS = 1_965_000_000_000; // a private window (year ~2032) no sibling file seeds into
  const XQ = `from=${XPW_TS - 1000}&to=${XPW_TS + 1000}`;
  const A_EXP_EVENT = crypto.randomUUID(); // tenant-a money_line event — the positive control (MUST appear)
  const B_EXP_EVENT = crypto.randomUUID(); // tenant-b money_line event — must NEVER appear for tenant-a
  const A_EXP_DOC = "iso-export-tenant-a-doc";
  const B_EXP_DOC = "iso-export-tenant-b-only-doc"; // a tenant-b document ref — must NEVER appear for tenant-a
  const A_EXP_ANCHOR_DAY = "2032-05-01";
  const xHash = (): string => crypto.randomUUID().replace(/-/g, "").padEnd(64, "0");
  // A GLOBALLY-UNIQUE tenant-b anchor root (a trivial "b".repeat(64) collides with other files' placeholder
  // hashes across the shared physical D1) — so the "must NEVER appear" assertion is unambiguous.
  const B_EXP_ANCHOR_ROOT = xHash();

  async function seedExportFixture(db: D1Database, eventId: string, docId: string, anchorDay: string, anchorRoot: string, amount: number): Promise<void> {
    const shp = `iso-export-${eventId.slice(0, 8)}`;
    const e = eventFixture("pod.signed", { id: eventId, stream_id: `s:${shp}`, shipment_id: shp, seq: 0, visibility: "internal", party_refs: [] });
    const row = eventToRow(e);
    row.hash = xHash();
    const cols = Object.keys(row);
    await db.prepare(`INSERT OR IGNORE INTO events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).bind(...cols.map((col) => row[col])).run();
    await db
      .prepare("INSERT OR IGNORE INTO money_lines (id, shipment_id, event_id, line_no, direction, kind, amount_cents, currency, party_id, division, gl_map, created_ts) VALUES (?,?,?,1,?,?,?,?,?,?,?,?)")
      .bind(`ml-${eventId.slice(0, 8)}`, shp, eventId, "ar", "freight", amount, "USD", "party-shipper", "main", "4000-FREIGHT-AR", XPW_TS)
      .run();
    await db
      .prepare("INSERT OR IGNORE INTO documents (id, shipment_id, party_id, kind, r2_key, hash, lifecycle_class, visibility) VALUES (?,?,?,?,?,?,?,?)")
      .bind(docId, shp, "party-shipper", "POD", `evidence/x/${shp}/pod.jpg`, xHash(), "default", "counterparty")
      .run();
    await db
      .prepare("INSERT OR IGNORE INTO documents (id, shipment_id, party_id, kind, r2_key, hash, lifecycle_class, visibility) VALUES (?,?,?,?,?,?,?,?)")
      .bind(`anchor:${anchorDay}`, null, null, "tsa_receipt", `anchors/x/${anchorDay}/tsr.der`, anchorRoot, "default", "internal")
      .run();
  }

  beforeAll(async () => {
    await seedExportFixture(env.TENANT_A_DB, A_EXP_EVENT, A_EXP_DOC, A_EXP_ANCHOR_DAY, "a".repeat(64), 111_111);
    await seedExportFixture(env.TENANT_B_DB, B_EXP_EVENT, B_EXP_DOC, "2032-05-02", B_EXP_ANCHOR_ROOT, 999_999);
  });

  it("a tenant-a admin export includes ITS OWN record but NEVER a tenant-b event/journal/document/anchor (REQ-025)", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "admin" });
    const res = await SELF.fetch(`https://api.local/v1/export?${XQ}`, { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status).toBe(200);
    const text = await res.text();
    // positive controls — tenant-a's own record IS exported (journal + document + anchor)
    expect(text).toContain(A_EXP_EVENT);
    expect(text).toContain(A_EXP_DOC);
    expect(text).toContain(A_EXP_ANCHOR_DAY);
    // the isolation guarantee — NONE of tenant-b's markers cross into tenant-a's single-tenant export
    expect(text).not.toContain(B_EXP_EVENT); // tenant-b's journal event id never appears
    expect(text).not.toContain(B_EXP_DOC); // tenant-b's document ref never appears
    expect(text).not.toContain(B_EXP_ANCHOR_ROOT); // tenant-b's anchor root never appears
  });

  it("?tenant= query param on GET /v1/export is rejected at auth", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "admin" });
    const res = await SELF.fetch(`https://api.local/v1/export?tenant=tenant-b&${XQ}`, { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status).toBe(403);
  });
});

// WP-11 Task 8 growth (REQ-036 + REQ-025): the Watchtower READ lists the durable `anomalies` alarms keyed off the
// JWT claim via tenantDb — WITHIN the session's D1, never across tenants. A tenant-b-only alarm (in a DIFFERENT
// physical D1) must never surface in a tenant-a read, and no client tenant hint may reach it.
describe("REQ-025 growth: GET /v1/watchtower reads ONLY the JWT tenant's anomalies", () => {
  const B_ALARM_ID = "iso-watchtower-tenant-b-only"; // a tenant-b alarm — must NEVER appear in a tenant-a read

  beforeAll(async () => {
    // Seed a UNIQUELY-marked OPEN alarm into tenant-b's D1 ONLY. tenant-a's read is keyed off the claim via
    // tenantDb, so it can never physically address this row.
    await env.TENANT_B_DB.prepare(
      "INSERT OR IGNORE INTO anomalies (id, rule, object_kind, object_id, severity, detail, status) VALUES (?,?,?,?,?,?,?)",
    )
      .bind(B_ALARM_ID, "unbilled", "tenant", "tenant-b", "warn", JSON.stringify({ count: 1 }), "open")
      .run();
  });

  it("a tenant-a session GETting /v1/watchtower never returns a tenant-b alarm (REQ-025)", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/watchtower?status=all", { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(B_ALARM_ID); // tenant-b's alarm never bleeds into tenant-a's watchtower
  });

  it("?tenant= query param on GET /v1/watchtower is rejected at auth", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/watchtower?tenant=tenant-b&status=open", { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status).toBe(403);
  });
});
