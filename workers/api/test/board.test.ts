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
