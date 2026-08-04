import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureSchema, token, post, TENANT_SLUG } from "./helpers.js";
import { sign } from "hono/jwt";
import { mintStatusCap, verifyStatusCap, deriveStatusSecret, CAP_TYP } from "../src/pub/status-cap.js";

// REQ-187/188 (WP-09 Task 3, D1 half B) — THE public, no-auth status read: GET /pub/status/:cap. This is
// the FIRST public data read in the system, so the adversarial cases ARE the spec. Every case drives the
// REAL /pub route (never the handler directly) and asserts on the raw response a forwarded browser gets.
//
// The locked laws under test:
//   PS-1/2  no enumeration/existence oracle — bad MAC, unknown tenant, missing shipment => IDENTICAL 401.
//   PS-3    confused deputy — a session JWT is not a cap.
//   PS-4    positive allowlist (REQ-167) — assigned_driver / party names NEVER leak; keys ⊆ the 4 allowed.
//   PS-5    geo ALWAYS city-coarse (REQ-188) — coarse EVEN at OFD (the public cap is forwardable).
//   PS-6    lens-bypass fail-closed — status_cache is the ONLY source; events never surface.
//   PS-8    lifetime + headers — expired => 401; a 200 carries Referrer-Policy + Cache-Control.

const JWT_SECRET = "test-secret-do-not-use-in-prod"; // === vitest.config.ts miniflare bindings.JWT_SECRET
const nowS = (): number => Math.floor(Date.now() / 1000);

// Ids scoped to this file — the harness shares ONE D1 across files (isolatedStorage:false).
const SHP_OK = "pub-shp-ok"; // exists, plain booked; PS-1 positive control + PS-8 headers
const SHP_MISSING = "pub-shp-missing"; // NEVER seeded — a valid cap for it must 401 like a bad cap
const SHP_ALLOW = "pub-shp-allow"; // PS-4: rich status_cache (assigned_driver + a stray name) + a position
const SHP_OFD = "pub-shp-ofd"; // PS-5: out_for_delivery=true + an EXACT position
const SHP_EVENTS = "pub-shp-events"; // PS-6: real internal events on the stream

// A driver-user-id + a stray party-name shaped field seeded INTO status_cache to prove neither leaks.
const SECRET_DRIVER = "u-synthetic-driver-should-not-leak";
const STRAY_NAME = "synthetic-counterparty-name-should-not-leak";

const opsTok = (): Promise<string> => token({ sub: "pub-ops", tenant: TENANT_SLUG, role: "ops" });
const financeTok = (): Promise<string> => token({ sub: "pub-fin", tenant: TENANT_SLUG, role: "finance" });

interface StatusRes {
  status: number;
  headers: Headers;
  text: string;
  json: Record<string, unknown> | null;
}
async function getStatus(cap: string): Promise<StatusRes> {
  const res = await SELF.fetch(`https://api.local/pub/status/${cap}`);
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

const validCap = (t: string, s: string, expSeconds = nowS() + 3600): Promise<string> => mintStatusCap(JWT_SECRET, { t, s, expSeconds });

// ---- JWT-payload tamper helpers (an attacker editing signed claims breaks the MAC) ----
function b64url(obj: unknown): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodePayload(cap: string): Record<string, unknown> {
  const seg = cap.split(".")[1] ?? "";
  return JSON.parse(atob(seg.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
}
// Re-encode the payload with a patched claim but reattach the ORIGINAL signature -> MAC no longer matches.
function tamperClaim(cap: string, patch: Record<string, unknown>): string {
  const [h, , sig] = cap.split(".");
  return `${h}.${b64url({ ...decodePayload(cap), ...patch })}.${sig}`;
}

const ALLOWED_KEYS = new Set(["state", "out_for_delivery", "position", "eta"]);

async function seedShipmentCache(id: string, statusCache: Record<string, unknown>): Promise<void> {
  await env.TENANT_A_DB.prepare(
    "INSERT OR IGNORE INTO shipments (id, shipper_party_id, consignee_party_id, bill_to_party_id, status_cache, created_ts) VALUES (?,?,?,?,?,0)",
  )
    .bind(id, "party-shipper", "party-consignee", "party-bill-to", JSON.stringify(statusCache))
    .run();
}
async function seedPosition(id: string, device: string, ts: number, lat: number, lon: number, accuracy: number | null): Promise<void> {
  await env.TENANT_A_DB.prepare(
    "INSERT OR IGNORE INTO positions (shipment_id, device_id, ts, recorded_at, lat_e6, lon_e6, accuracy_m, speed_cms, hash) VALUES (?,?,?,?,?,?,?,?,?)",
  )
    .bind(id, device, ts, ts, lat, lon, accuracy, null, `pub-hash-${id}-${ts}`)
    .run();
}

// Minimal .strict-shaped event input for the REAL append route (PS-6 seeds internal kinds on the stream).
function buildEvent(shipmentId: string, kind: string, payload: Record<string, unknown>, partyRefs: string[]): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    shipment_id: shipmentId,
    ts: 1_720_000_000_000,
    actor: { party: "party-shipper" },
    party_refs: partyRefs,
    evidence: [],
    source: "native",
    confidence: 10_000,
    kind,
    payload,
  };
}
function bookingInput(shipmentId: string, partyRefs: string[]): Record<string, unknown> {
  return buildEvent(shipmentId, "booking.created", {
    quote_event_id: "evt-quote-1",
    division: "main",
    shipper_party_id: "party-shipper",
    consignee_party_id: "party-consignee",
    bill_to_party_id: "party-bill-to",
  }, partyRefs);
}

const EXACT = { lat_e6: 37_421_000, lon_e6: -122_084_000, accuracy_m: 5 };

beforeAll(async () => {
  await ensureSchema(env);

  // SHP_OK — plain booked, no driver, no OFD, no position.
  await seedShipmentCache(SHP_OK, { state: "booked" });

  // SHP_ALLOW — a rich status_cache carrying the two things that must NEVER leak (a driver user id and a
  // stray name field), plus a position so `position` is present. If the read were a denylist-strip instead
  // of a positive allowlist, a new field like `customer_name` would sail through.
  await seedShipmentCache(SHP_ALLOW, {
    state: "in_transit",
    out_for_delivery: false,
    assigned_driver: SECRET_DRIVER,
    customer_name: STRAY_NAME,
  });
  await seedPosition(SHP_ALLOW, "pub-dev-a", 1_720_000_000_100, EXACT.lat_e6, EXACT.lon_e6, EXACT.accuracy_m);

  // SHP_OFD — OUT FOR DELIVERY + an EXACT position. The authed party lens unlocks exact geo at OFD; the
  // public cap must NOT — it stays coarse even here.
  await seedShipmentCache(SHP_OFD, { state: "in_transit", out_for_delivery: true });
  await seedPosition(SHP_OFD, "pub-dev-ofd", 1_720_000_000_200, EXACT.lat_e6, EXACT.lon_e6, EXACT.accuracy_m);

  // SHP_EVENTS — real internal events on the stream (booking + approval.requested + credit.checked). The
  // public read must surface NONE of them (it reads status_cache, never the events table / the lens).
  const ops = await opsTok();
  const b = await post(SHP_EVENTS, bookingInput(SHP_EVENTS, ["party-consignee"]), ops);
  if (b.status !== 201) throw new Error(`seed ${SHP_EVENTS}/booking failed: ${b.status} ${JSON.stringify(b.json)}`);
  const ar = await post(SHP_EVENTS, buildEvent(SHP_EVENTS, "approval.requested", {}, ["party-consignee"]), ops);
  if (ar.status !== 201) throw new Error(`seed ${SHP_EVENTS}/approval failed: ${ar.status} ${JSON.stringify(ar.json)}`);
  const cc = await post(SHP_EVENTS, buildEvent(SHP_EVENTS, "credit.checked", { party_id: "party-consignee", status: "clear" }, ["party-consignee"]), await financeTok());
  if (cc.status !== 201) throw new Error(`seed ${SHP_EVENTS}/credit failed: ${cc.status} ${JSON.stringify(cc.json)}`);
});

// PS-1 — no existence oracle: a garbage cap, and a VALID cap for a shipment that does not exist, are the
// SAME 401. A prober who somehow held a valid MAC still cannot tell a real shipment from a phantom.
describe("PS-1: enumeration / existence oracle", () => {
  it("a garbage cap is 401", async () => {
    const res = await getStatus("not-a-real-cap.at-all.nope");
    expect(res.status).toBe(401);
  });

  it("a VALID cap for a MISSING shipment is a 401 IDENTICAL (code+message) to a garbage cap", async () => {
    const garbage = await getStatus("garbage.garbage.garbage");
    const missing = await getStatus(await validCap(TENANT_SLUG, SHP_MISSING));
    expect(missing.status).toBe(401);
    expect(garbage.status).toBe(401);
    // req_id differs per request (random) — the ORACLE would be a differing code/message. There is none.
    expect(missing.json?.code).toBe(garbage.json?.code);
    expect(missing.json?.message).toBe(garbage.json?.message);
    expect(missing.json?.code).toBe("UNAUTHORIZED");
  });

  it("a valid cap whose signed `s` is tampered to a sibling id breaks the MAC -> same 401", async () => {
    const good = await validCap(TENANT_SLUG, SHP_OK);
    const swapped = tamperClaim(good, { s: SHP_ALLOW }); // point it at a real sibling — MAC no longer matches
    const res = await getStatus(swapped);
    const garbage = await getStatus("garbage.garbage.garbage");
    expect(res.status).toBe(401);
    expect(res.json?.code).toBe(garbage.json?.code);
    expect(res.json?.message).toBe(garbage.json?.message);
  });

  it("a valid cap for a shipment that EXISTS is 200 (positive control)", async () => {
    const res = await getStatus(await validCap(TENANT_SLUG, SHP_OK));
    expect(res.status).toBe(200);
    expect(res.json?.state).toBe("booked");
  });
});

// PS-2 — tenant tamper: editing the signed `t` breaks the MAC; the other tenant's D1 is never read.
describe("PS-2: tenant tamper", () => {
  it("a cap whose `t` is flipped to another tenant is a 401 (MAC breaks before any DB resolve)", async () => {
    const good = await validCap(TENANT_SLUG, SHP_OK);
    const flipped = tamperClaim(good, { t: "tenant-b" });
    const res = await getStatus(flipped);
    const garbage = await getStatus("garbage.garbage.garbage");
    expect(res.status).toBe(401);
    expect(res.json?.code).toBe(garbage.json?.code);
    expect(res.json?.message).toBe(garbage.json?.message);
  });
});

// PS-3 — confused deputy: a real session JWT is signed with JWT_SECRET, not the derived STATUS_SECRET, so
// it can never MAC-verify as a cap.
describe("PS-3: confused deputy (session JWT as cap)", () => {
  it("a real session JWT used as :cap is 401", async () => {
    const session = await token({ sub: "u-1", tenant: TENANT_SLUG, role: "portal", party_id: "party-consignee" });
    const res = await getStatus(session);
    expect(res.status).toBe(401);
  });
});

// PS-4 — positive allowlist (REQ-167): the driver user id and the stray name in status_cache appear NOWHERE.
describe("PS-4: positive allowlist / REQ-167", () => {
  it("keys ⊆ {state,out_for_delivery,position,eta}; assigned_driver + stray name never appear", async () => {
    const res = await getStatus(await validCap(TENANT_SLUG, SHP_ALLOW));
    expect(res.status).toBe(200);
    const json = res.json!;
    // assert on PARSED KEYS (a fail-closed schema), not a substring
    for (const k of Object.keys(json)) expect(ALLOWED_KEYS.has(k), `unexpected key ${k}`).toBe(true);
    expect("assigned_driver" in json).toBe(false);
    expect("customer_name" in json).toBe(false);
    // and the sensitive VALUES do not survive anywhere in the serialized body (belt + suspenders)
    expect(res.text).not.toContain(SECRET_DRIVER);
    expect(res.text).not.toContain(STRAY_NAME);
    // the allowlisted fields DID come through
    expect(json.state).toBe("in_transit");
    expect(json.out_for_delivery).toBe(false);
    expect(json.position).toBeDefined();
  });
});

// PS-5 — geo ALWAYS coarse (REQ-188): even with out_for_delivery=true, the public position is city-coarse
// with no accuracy_m (the authed party lens would unlock EXACT here — the public cap must not).
describe("PS-5: always-coarse geo / REQ-188", () => {
  it("OFD + exact position -> coarse position (lat_e6 % 100000 === 0), no accuracy_m", async () => {
    const res = await getStatus(await validCap(TENANT_SLUG, SHP_OFD));
    expect(res.status).toBe(200);
    expect(res.json?.out_for_delivery).toBe(true); // we DID read OFD…
    const pos = res.json?.position as Record<string, unknown>;
    expect(pos).toBeDefined();
    expect((pos.lat_e6 as number) % 100_000 === 0).toBe(true); // …yet the geo is STILL coarse
    expect((pos.lon_e6 as number) % 100_000 === 0).toBe(true);
    expect(pos.lat_e6).not.toBe(EXACT.lat_e6); // actually coarsened, not the exact value
    expect("accuracy_m" in pos).toBe(false); // precision dropped with the coords
  });
});

// PS-6 — lens-bypass fail-closed: internal event kinds on the stream never reach the public body.
describe("PS-6: lens-bypass / status_cache is the only source", () => {
  it("credit.checked / approval.requested strings appear NOWHERE in the public body", async () => {
    const res = await getStatus(await validCap(TENANT_SLUG, SHP_EVENTS));
    expect(res.status).toBe(200);
    for (const leak of ["credit.checked", "approval.requested", "credit", "approval", "party_id"]) {
      expect(res.text, `public body leaked ${leak}`).not.toContain(leak);
    }
    // it IS the booked shipment (status_cache read), just without any event detail
    expect(res.json?.state).toBe("booked");
  });
});

// PS-8 — lifetime + headers.
describe("PS-8: lifetime + headers", () => {
  it("an expired cap is 401", async () => {
    const expired = await validCap(TENANT_SLUG, SHP_OK, nowS() - 10);
    const res = await getStatus(expired);
    expect(res.status).toBe(401);
  });

  it("a 200 carries Referrer-Policy: no-referrer and Cache-Control: no-store", async () => {
    const res = await getStatus(await validCap(TENANT_SLUG, SHP_OK));
    expect(res.status).toBe(200);
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

// PS-9 (audit §91) — EACH LAYER PINNED ALONE.
//
// The cap has two independent defences against cross-token replay: a secret DERIVED from JWT_SECRET, and a
// `typ` literal inside a `.strict()` payload. Measured by mutation, **each is sufficient on its own** —
// removing key separation left all 11 route tests green, and so did removing `typ` + strictness. That is
// genuine defence-in-depth, but it also means NEITHER layer is pinned by the route suite: a refactor could
// delete one, see green, and silently reduce two layers to one, with the next change to the survivor opening
// the hole. These two cases assert each layer at the function level, where the other cannot mask it.
describe("PS-9: each cap defence is independently pinned (audit §91)", () => {
  it("KEY SEPARATION: a token signed with the RAW JWT_SECRET is refused, even with a perfect cap payload", async () => {
    // Correct typ, correct shape, correct claims — wrong key. Only the derivation can refuse this.
    // CAP_TYP imported, never hardcoded: the first draft guessed "shuddl.status.v1", so this case passed
    // because the TYPE was wrong rather than the key — a wrong-reason pass (§81) written one section after
    // §81 documented it. With the real typ, only the derived-key check can refuse this token.
    const forged = await sign({ typ: CAP_TYP, t: TENANT_SLUG, s: SHP_OK, exp: nowS() + 3600 }, JWT_SECRET, "HS256");
    await expect(verifyStatusCap(forged, JWT_SECRET)).rejects.toThrow();
  });

  it("TYPE CONFINEMENT: a token on the CORRECT cap key but without `typ` is refused", async () => {
    // Right key, right tenant/shipment/exp — no typ. Only the .strict() literal can refuse this.
    const secret = await deriveStatusSecret(JWT_SECRET);
    const untyped = await sign({ t: TENANT_SLUG, s: SHP_OK, exp: nowS() + 3600 }, secret, "HS256");
    await expect(verifyStatusCap(untyped, JWT_SECRET)).rejects.toThrow();
  });
});
