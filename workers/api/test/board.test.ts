import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureSchema, token, TENANT_SLUG } from "./helpers.js";

// WP-10 Task 9 (REQ-073/080) — GET /v1/board is the command map's live, lens-scoped fleet: the tenant's
// ACTIVE shipments, each carrying its LATEST position (the mark) + its status_cache.state mapped to the map's
// status vocabulary (healthy | at-risk | exception). A DURABLE READ over shipments (status_cache) + positions
// (latest per shipment); it adds NO table, NO event kind, NO projection. Tenant comes from the JWT claim ONLY
// (tenantDb) — never a header/query param (REQ-025). The truthful-map law: a mark is placed at the lens's REAL
// position (the tenant/ops lens exposes exact ops geo — redact.ts coarsens ONLY the party lens), never a
// fabricated one, so a shipment with no position is not placed at all.

const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });

// board-t9-* ids keep this file's rows unambiguous across the shared (isolatedStorage-off) D1.
const ACTIVE = "board-t9-active";
const EXC = "board-t9-exception";
const DELIVERED = "board-t9-delivered";
const NOPOS = "board-t9-nopos";

interface BoardItem {
  shipment_id: string;
  lat_e6: number;
  lon_e6: number;
  status: "healthy" | "at-risk" | "exception";
}

async function seedShipment(id: string, state: string | null): Promise<void> {
  const statusCache = state === null ? "{}" : JSON.stringify({ state });
  await env.TENANT_A_DB.prepare(
    "INSERT OR IGNORE INTO shipments (id, shipper_party_id, consignee_party_id, bill_to_party_id, status_cache, created_ts) VALUES (?,?,?,?,?,?)",
  )
    .bind(id, "party-shipper", "party-consignee", "party-bill-to", statusCache, 0)
    .run();
}

async function seedPosition(shipmentId: string, ts: number, latE6: number, lonE6: number): Promise<void> {
  await env.TENANT_A_DB.prepare(
    "INSERT OR IGNORE INTO positions (shipment_id, device_id, ts, recorded_at, lat_e6, lon_e6, accuracy_m, speed_cms, hash) VALUES (?,?,?,?,?,?,?,?,?)",
  )
    .bind(shipmentId, "device-1", ts, Date.now(), latE6, lonE6, null, null, `h-${shipmentId}-${ts}`)
    .run();
}

async function board(t: string): Promise<{ status: number; items: BoardItem[] }> {
  const res = await SELF.fetch("https://api.local/v1/board", { headers: bearer(t) });
  const body = (await res.json().catch(() => ({ board: [] }))) as { board?: BoardItem[] };
  return { status: res.status, items: body.board ?? [] };
}

beforeAll(async () => {
  await ensureSchema(env);
  // ACTIVE — two positions; the map must place the LATEST (ts 2000), never the older (ts 1000).
  await seedShipment(ACTIVE, "in_transit");
  await seedPosition(ACTIVE, 1000, 30_000_000, -90_000_000); // older
  await seedPosition(ACTIVE, 2000, 41_000_000, -74_000_000); // newer — the one the board must return
  // EXC — an exception shipment with a position: demo #5 proof (status maps to "exception").
  await seedShipment(EXC, "exception");
  await seedPosition(EXC, 5000, 40_000_000, -75_000_000);
  // DELIVERED — terminal state; excluded (a delivered truck is not part of the live fleet).
  await seedShipment(DELIVERED, "delivered");
  await seedPosition(DELIVERED, 5000, 39_000_000, -76_000_000);
  // NOPOS — active but no position: excluded (never fabricate a location — truthful map).
  await seedShipment(NOPOS, "in_transit");
});

describe("GET /v1/board (REQ-073/080) — the live lens-scoped fleet", () => {
  it("returns each active shipment at its LATEST position with the mapped status", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    const { status, items } = await board(t);
    expect(status).toBe(200);
    const active = items.find((i) => i.shipment_id === ACTIVE);
    expect(active).toBeDefined();
    // The LATEST position (ts 2000), not the older ts-1000 row — exact ops geo (the tenant lens does not coarsen).
    expect(active?.lat_e6).toBe(41_000_000);
    expect(active?.lon_e6).toBe(-74_000_000);
    expect(active?.status).toBe("healthy"); // in_transit maps to healthy
  });

  it("an exception shipment carries the exception status (demo #5 arms the world-dim/pulse)", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    const { items } = await board(t);
    const exc = items.find((i) => i.shipment_id === EXC);
    expect(exc).toBeDefined();
    expect(exc?.status).toBe("exception");
    expect(exc?.lat_e6).toBe(40_000_000);
    expect(exc?.lon_e6).toBe(-75_000_000);
  });

  it("a DELIVERED (terminal) shipment is excluded — the live fleet is honest, not stale", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    const { items } = await board(t);
    expect(items.some((i) => i.shipment_id === DELIVERED)).toBe(false);
  });

  it("an active shipment with NO position is excluded — a mark is never placed at a fabricated location", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    const { items } = await board(t);
    expect(items.some((i) => i.shipment_id === NOPOS)).toBe(false);
  });

  it("the read role (tenant-lens) may read the board", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "read" });
    const { status } = await board(t);
    expect(status).toBe(200);
  });

  it("a driver (non-command role) is 403 — the board is a command surface", async () => {
    const t = await token({ sub: "u-driver", tenant: TENANT_SLUG, role: "driver" });
    const { status } = await board(t);
    expect(status).toBe(403);
  });

  it("?tenant= is rejected at auth (tenant is server-resolved, never client-supplied)", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/board?tenant=tenant-b", { headers: bearer(t) });
    expect(res.status).toBe(403);
  });
});

// ---- Task 12 (REQ-085/074/025) — the PORTAL party board -------------------------------------------
// GET /v1/board now ALSO serves the client portal through the PARTY lens (role 'portal'): the party's OWN
// positioned shipments, scoped + generalized SERVER-SIDE before serialization. The adversarial contract:
//   · party-relationship predicate — a shipment is the party's iff it is the shipper|consignee|bill_to; party A
//     never sees party B (REQ-025), and a forged ?party_id is IGNORED (identity is the verified claim only).
//   · coordinate generalization — non-OFD positions coarsen to ~city (REQ-074); exact geo unlocks only at OFD.
//   · terminal / no-position exclusion — a delivered truck or an unpositioned shipment is not on the live map.
//   · strict response allowlist — a party item is EXACTLY {shipment_id,lat_e6,lon_e6,status}; no party_id, no
//     accuracy, no internal field leaks. The response carries a server-derived `as_of` freshness stamp.
const PARTY_A = "party-t12-a";
const PARTY_B = "party-t12-b";
const A_SHIPPER = "board-t12-a-shipper"; // A as shipper — exact pos, coarsened on the wire
const A_CONSIGNEE = "board-t12-a-consignee"; // A as CONSIGNEE — the predicate covers all three party roles
const A_OFD = "board-t12-a-ofd"; // A shipper, out-for-delivery — exact pos unlocked
const A_EXC = "board-t12-a-exc"; // A shipper, exception state — carries the exception status
const A_DELIVERED = "board-t12-a-delivered"; // terminal — excluded from the live fleet
const A_NOPOS = "board-t12-a-nopos"; // no position — never placed at a fabricated location
const B_SHIPPER = "board-t12-b-shipper"; // party B only — A must never see it

// Exact microdegrees; the party lens must coarsen these to nearest 100_000 (the coarsenGeoInPlace law).
const A_EXACT = { lat: 41_234_567, lon: -74_654_321 };
const A_OFD_EXACT = { lat: 37_654_321, lon: -122_123_456 };
// The SAME coarsen law the server projection applies (round microdegrees to the nearest 0.1°). Not a literal —
// so the assertion tracks the law, and `not.toBe(exact)` proves the coord was actually generalized.
const coarse = (n: number): number => Math.round(n / 100_000) * 100_000;

async function seedPartyShipment(
  id: string,
  state: string | null,
  party: { shipper?: string; consignee?: string; billTo?: string },
  ofd = false,
): Promise<void> {
  const cache: Record<string, unknown> = {};
  if (state !== null) cache.state = state;
  if (ofd) cache.out_for_delivery = true;
  await env.TENANT_A_DB.prepare(
    "INSERT OR IGNORE INTO shipments (id, shipper_party_id, consignee_party_id, bill_to_party_id, status_cache, created_ts) VALUES (?,?,?,?,?,?)",
  )
    .bind(id, party.shipper ?? "party-t12-x", party.consignee ?? "party-t12-x", party.billTo ?? "party-t12-x", JSON.stringify(cache), 0)
    .run();
}

async function partyBoard(
  t: string,
  query = "",
): Promise<{ status: number; items: BoardItem[]; asOf: unknown; keys: string[] }> {
  const res = await SELF.fetch(`https://api.local/v1/board${query}`, { headers: bearer(t) });
  const body = (await res.json().catch(() => ({}))) as { board?: BoardItem[]; as_of?: unknown };
  return { status: res.status, items: body.board ?? [], asOf: body.as_of, keys: Object.keys(body) };
}

const partyToken = (partyId: string): Promise<string> =>
  token({ sub: `u-${partyId}`, tenant: TENANT_SLUG, role: "portal", party_id: partyId });

beforeAll(async () => {
  await ensureSchema(env);
  await seedPartyShipment(A_SHIPPER, "in_transit", { shipper: PARTY_A });
  await seedPosition(A_SHIPPER, 12_000, A_EXACT.lat, A_EXACT.lon);
  await seedPartyShipment(A_CONSIGNEE, "in_transit", { consignee: PARTY_A });
  await seedPosition(A_CONSIGNEE, 12_000, 40_000_000, -75_000_000);
  await seedPartyShipment(A_OFD, "in_transit", { shipper: PARTY_A }, true);
  await seedPosition(A_OFD, 12_000, A_OFD_EXACT.lat, A_OFD_EXACT.lon);
  await seedPartyShipment(A_EXC, "exception", { shipper: PARTY_A });
  await seedPosition(A_EXC, 12_000, 40_500_000, -74_500_000);
  await seedPartyShipment(A_DELIVERED, "delivered", { shipper: PARTY_A });
  await seedPosition(A_DELIVERED, 12_000, 39_000_000, -76_000_000);
  await seedPartyShipment(A_NOPOS, "in_transit", { shipper: PARTY_A });
  await seedPartyShipment(B_SHIPPER, "in_transit", { shipper: PARTY_B });
  await seedPosition(B_SHIPPER, 12_000, 42_000_000, -71_000_000);
});

describe("GET /v1/board party lens (REQ-085/074/025) — the client portal's own-freight board", () => {
  it("party A sees ONLY its own shipments (shipper AND consignee), never party B's (REQ-025)", async () => {
    const { status, items } = await partyBoard(await partyToken(PARTY_A));
    expect(status).toBe(200);
    const ids = items.map((i) => i.shipment_id);
    expect(ids).toContain(A_SHIPPER); // A is shipper
    expect(ids).toContain(A_CONSIGNEE); // A is consignee — the predicate covers all three roles
    expect(ids).not.toContain(B_SHIPPER); // party B is invisible to A
  });

  it("party B sees ONLY its own shipment, never party A's (isolation is symmetric)", async () => {
    const { items } = await partyBoard(await partyToken(PARTY_B));
    const ids = items.map((i) => i.shipment_id);
    expect(ids).toContain(B_SHIPPER);
    expect(ids).not.toContain(A_SHIPPER);
    expect(ids).not.toContain(A_CONSIGNEE);
  });

  it("a forged ?party_id in the request is IGNORED — the lens is the verified claim (REQ-025)", async () => {
    // Party A's token, but the request tries to widen to B via a query param. It must be ignored outright.
    const { items } = await partyBoard(await partyToken(PARTY_A), `?party_id=${PARTY_B}`);
    const ids = items.map((i) => i.shipment_id);
    expect(ids).toContain(A_SHIPPER); // still A's own board
    expect(ids).not.toContain(B_SHIPPER); // the forged party_id bought nothing
  });

  it("a non-OFD position is GENERALIZED to ~city (REQ-074) — exact coords never leak pre-delivery", async () => {
    const { items } = await partyBoard(await partyToken(PARTY_A));
    const item = items.find((i) => i.shipment_id === A_SHIPPER);
    expect(item).toBeDefined();
    expect(item?.lat_e6).toBe(coarse(A_EXACT.lat));
    expect(item?.lon_e6).toBe(coarse(A_EXACT.lon));
    expect(item?.lat_e6).not.toBe(A_EXACT.lat); // proof: the exact coord was actually coarsened
    expect(item?.lon_e6).not.toBe(A_EXACT.lon);
  });

  it("an OUT-FOR-DELIVERY shipment returns EXACT coordinates (precise position unlocks at the door)", async () => {
    const { items } = await partyBoard(await partyToken(PARTY_A));
    const item = items.find((i) => i.shipment_id === A_OFD);
    expect(item).toBeDefined();
    expect(item?.lat_e6).toBe(A_OFD_EXACT.lat); // unredacted — OFD bypasses generalization
    expect(item?.lon_e6).toBe(A_OFD_EXACT.lon);
  });

  it("an exception on the party's OWN shipment carries the exception status (demo #5 on real data)", async () => {
    const { items } = await partyBoard(await partyToken(PARTY_A));
    expect(items.find((i) => i.shipment_id === A_EXC)?.status).toBe("exception");
  });

  it("a terminal (delivered) shipment is excluded from the party board", async () => {
    const { items } = await partyBoard(await partyToken(PARTY_A));
    expect(items.some((i) => i.shipment_id === A_DELIVERED)).toBe(false);
  });

  it("an active shipment with NO position is excluded — a mark is never fabricated", async () => {
    const { items } = await partyBoard(await partyToken(PARTY_A));
    expect(items.some((i) => i.shipment_id === A_NOPOS)).toBe(false);
  });

  it("the party item is a STRICT allowlist {shipment_id,lat_e6,lon_e6,status} — no party_id/accuracy/internal leak", async () => {
    const { items, keys, asOf } = await partyBoard(await partyToken(PARTY_A));
    const item = items.find((i) => i.shipment_id === A_SHIPPER);
    expect(item).toBeDefined();
    expect(Object.keys(item as object).sort()).toEqual(["lat_e6", "lon_e6", "shipment_id", "status"]);
    // The response carries a SERVER-DERIVED freshness stamp and nothing else at the top level.
    expect(keys.sort()).toEqual(["as_of", "board"]);
    expect(typeof asOf).toBe("number");
  });

  it("a portal session WITHOUT a party_id is 403 — fail-closed, no party board (REQ-085)", async () => {
    const t = await token({ sub: "u-noparty", tenant: TENANT_SLUG, role: "portal" });
    const { status } = await partyBoard(t);
    expect(status).toBe(403);
  });
});

describe("GET /v1/board tenant-lens response shape (apps/command strict-parse guard)", () => {
  it("the tenant/command board response is {board} ONLY — no as_of — so the command app's .strict() parse is unbroken", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/board", { headers: bearer(t) });
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["board"]);
  });
});
