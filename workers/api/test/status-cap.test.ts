import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { sign } from "hono/jwt";
import { ensureSchema, token, post, TENANT_SLUG } from "./helpers.js";
import { deriveStatusSecret, mintStatusCap, verifyStatusCap } from "../src/pub/status-cap.js";

// REQ-187 (WP-09 Task 2, D1 half A) — the signed status-capability token + its AUTHED, lens-scoped mint
// route. A status link lets a party hand a bearer-only public URL to a shipment's status page (Task 3
// builds the read). The cap is a domain-separated HS256 JWT so a session token can NEVER verify as a cap
// and vice versa, and tenant+shipment live INSIDE the MAC so neither is client-forgeable or enumerable.

const JWT_SECRET = "test-secret-do-not-use-in-prod"; // === vitest.config.ts miniflare bindings.JWT_SECRET
const DOMAIN = "shuddl-status-cap-v1";
const nowS = (): number => Math.floor(Date.now() / 1000);

// An INDEPENDENT recomputation of hex(HMAC-SHA256(key=JWT_SECRET, msg=DOMAIN)) — proves deriveStatusSecret
// implements the locked byte law, not just "some disjoint value".
async function expectedStatusSecret(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(DOMAIN));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("STATUS_SECRET derivation (domain-separated from JWT_SECRET)", () => {
  it("is hex(HMAC-SHA256(JWT_SECRET, 'shuddl-status-cap-v1')) — 64 hex chars, cryptographically disjoint", async () => {
    const derived = await deriveStatusSecret(JWT_SECRET);
    expect(derived).toBe(await expectedStatusSecret(JWT_SECRET));
    expect(derived).toMatch(/^[0-9a-f]{64}$/);
    expect(derived).not.toBe(JWT_SECRET); // disjoint: a session-secret token can never MAC-verify as a cap
  });
});

describe("mintStatusCap / verifyStatusCap round-trip", () => {
  it("mint then verify returns exactly {t, s}", async () => {
    const cap = await mintStatusCap(JWT_SECRET, { t: "tenant-a", s: "shp-round-1", expSeconds: nowS() + 3600 });
    expect(await verifyStatusCap(cap, JWT_SECRET)).toEqual({ t: "tenant-a", s: "shp-round-1" });
  });

  it("a cap minted with the RAW JWT_SECRET (not STATUS_SECRET) fails verifyStatusCap", async () => {
    // Signed under JWT_SECRET, but verifyStatusCap MACs under the DERIVED STATUS_SECRET -> mismatch.
    const forged = await sign({ typ: "status-cap", t: "tenant-a", s: "shp-1", exp: nowS() + 3600 }, JWT_SECRET, "HS256");
    await expect(verifyStatusCap(forged, JWT_SECRET)).rejects.toThrow();
  });

  it("a real session JWT (signed via token() with JWT_SECRET) fails verifyStatusCap", async () => {
    const session = await token({ sub: "u-1", tenant: "tenant-a", role: "portal", party_id: "p1" });
    await expect(verifyStatusCap(session, JWT_SECRET)).rejects.toThrow();
  });

  it("a token with the correct MAC but a wrong/absent typ fails verifyStatusCap", async () => {
    const secret = await deriveStatusSecret(JWT_SECRET);
    const wrongTyp = await sign({ typ: "session", t: "tenant-a", s: "shp-1", exp: nowS() + 3600 }, secret, "HS256");
    const noTyp = await sign({ t: "tenant-a", s: "shp-1", exp: nowS() + 3600 }, secret, "HS256");
    await expect(verifyStatusCap(wrongTyp, JWT_SECRET)).rejects.toThrow();
    await expect(verifyStatusCap(noTyp, JWT_SECRET)).rejects.toThrow();
  });

  it("an expired cap fails verifyStatusCap", async () => {
    const expired = await mintStatusCap(JWT_SECRET, { t: "tenant-a", s: "shp-1", expSeconds: nowS() - 10 });
    await expect(verifyStatusCap(expired, JWT_SECRET)).rejects.toThrow();
  });
});

// ---- the AUTHED mint route: POST /v1/shipments/:id/status-link (lens-scoped) ----------------------
// A distinct party cast + shipment ids (the harness shares ONE D1 across files — scope everything to us).
const P1 = "sc-party-1"; // a party ON the seeded shipment
const P2 = "sc-party-2"; // a party NOT on it
const SHP = "sc-shp-1";

const opsTok = (): Promise<string> => token({ sub: "sc-ops", tenant: TENANT_SLUG, role: "ops" });
const portalTok = (partyId: string): Promise<string> => token({ sub: `${partyId}-user`, tenant: TENANT_SLUG, role: "portal", party_id: partyId });

// booking.created is counterparty-visible and creates the shipments row; party_refs carries the party the
// portal caller claims. bill_to = party-bill-to (seeded WITH a deliverable email) so the REQ-182 recipient
// gate passes. Actor/shipper/consignee/bill_to are the standard seeded parties (FK); party_refs is free-form.
function bookingInput(shipmentId: string, partyRefs: string[]): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    shipment_id: shipmentId,
    ts: 1_720_000_000_000,
    actor: { party: "party-shipper" },
    party_refs: partyRefs,
    evidence: [],
    source: "native",
    confidence: 10_000,
    kind: "booking.created",
    payload: { quote_event_id: "evt-quote-1", division: "main", shipper_party_id: "party-shipper", consignee_party_id: "party-consignee", bill_to_party_id: "party-bill-to" },
  };
}

interface MintRes {
  status: number;
  json: Record<string, unknown> | null;
}
async function mintLink(shipmentId: string, tok: string): Promise<MintRes> {
  const res = await SELF.fetch(`https://api.local/v1/shipments/${shipmentId}/status-link`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
    body: "{}",
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

describe("POST /v1/shipments/:id/status-link (authed, lens-scoped mint)", () => {
  beforeAll(async () => {
    await ensureSchema(env);
    const r = await post(SHP, bookingInput(SHP, [P1]), await opsTok());
    if (r.status !== 201) throw new Error(`seed ${SHP}/booking.created failed: ${r.status} ${JSON.stringify(r.json)}`);
  });

  it("PS-7: a portal party NOT on the shipment is denied (cross-party mint -> 403)", async () => {
    const res = await mintLink(SHP, await portalTok(P2));
    expect(res.status).toBe(403);
    expect(res.json?.cap).toBeUndefined();
  });

  it("a portal party ON the shipment mints a cap that decodes to {t: tenant-a, s: id}", async () => {
    const res = await mintLink(SHP, await portalTok(P1));
    expect(res.status).toBe(200);
    const cap = res.json?.cap as string;
    expect(typeof cap).toBe("string");
    expect(await verifyStatusCap(cap, JWT_SECRET)).toEqual({ t: TENANT_SLUG, s: SHP });
    // the url is a RELATIVE /pub path (host is deploy-config; REQ-167 no hardcoded domain)
    expect(res.json?.url).toBe(`/pub/status/${cap}`);
  });

  it("an ops session (tenant scope) mints for any in-tenant shipment -> 200", async () => {
    const res = await mintLink(SHP, await opsTok());
    expect(res.status).toBe(200);
    expect(await verifyStatusCap(res.json?.cap as string, JWT_SECRET)).toEqual({ t: TENANT_SLUG, s: SHP });
  });

  it("the minted cap's `t` is session.tenant, NEVER derived from :id or any input", async () => {
    // ops session is tenant-a; the cap tenant must be tenant-a regardless of the :id path segment.
    const res = await mintLink(SHP, await opsTok());
    expect(res.status).toBe(200);
    const claims = await verifyStatusCap(res.json?.cap as string, JWT_SECRET);
    expect(claims.t).toBe(TENANT_SLUG);
    expect(claims.s).toBe(SHP);
  });
});

// ─── §927 — §377's CLASS on the status-link mint (the third of four) ────────────────────────────────────
//
// Same rule, same reachability: a portal token without `party_id` is schema-valid, `lensFor` throws, and
// without the translation this route answers 500 instead of 403. §377 pinned this class on invoices and
// documents; the mint route was one of the copies it did not reach.
describe("§927: a portal session WITHOUT party_id is 403 on the status-link mint (§377's class)", () => {
  it("translates LENS_UNRESOLVED to a clean 403, not an opaque 500", async () => {
    const t = await token({ sub: "sl-noparty", tenant: TENANT_SLUG, role: "portal" });
    const res = await mintLink("shp-noparty-mint", t);
    expect(res.status, JSON.stringify(res)).toBe(403);
  });
});
