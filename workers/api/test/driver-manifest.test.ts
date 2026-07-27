import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureSchema, token, TENANT_SLUG } from "./helpers.js";

// Task 10 (REQ-030/025/013) — GET /v1/driver/manifest is the driver PWA's ONLY read path: an
// AUTHENTICATED, server-scoped day sheet that REPLACES the fictional DAY_SHEET fixture. Tenant + driver
// identity come from the verified JWT ONLY (session.tenant → tenantDb, session.sub → assigned_driver) —
// never a client-supplied id (REQ-025/156). A cross-driver / cross-tenant probe returns NO manifest. The
// POD-before-next-address reveal is SERVER-SIDE: precise future-stop fields (geo) are withheld until the
// prior stop's terminal evidence is committed (current V1 policy). Strict allowlist + server timestamps.

const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });

// dm-* ids keep this file's rows unambiguous across the shared (isolatedStorage-off) D1.
const DRIVER_A = "u-dm-driver-a";
const DRIVER_B = "u-dm-driver-b";
const SHIP_1 = "dm-ship-1"; // pickup, assigned to DRIVER_A, created first (day-sheet order 1)
const SHIP_2 = "dm-ship-2"; // delivery, assigned to DRIVER_A, created second (order 2)
const SHIP_OTHER = "dm-ship-other"; // assigned to DRIVER_B — must never surface for DRIVER_A

interface ManifestStop {
  shipment_id: string;
  seq: number;
  kind: "pickup" | "delivery";
  status: "pending" | "arrived" | "done";
  revealed: boolean;
  geo: { lat_e6: number; lon_e6: number } | null;
}
interface Manifest {
  server_ts: number;
  tenant: string;
  driver_id: string;
  stops: ManifestStop[];
}

async function seedShipment(id: string, assignedDriver: string, createdTs: number): Promise<void> {
  await env.TENANT_A_DB.prepare(
    "INSERT OR IGNORE INTO shipments (id, shipper_party_id, consignee_party_id, bill_to_party_id, status_cache, created_ts) VALUES (?,?,?,?,?,?)",
  )
    .bind(id, "party-shipper", "party-consignee", "party-bill-to", JSON.stringify({ assigned_driver: assignedDriver }), createdTs)
    .run();
}

async function seedLeg(shipmentId: string, seq: number, kind: string, latE6: number, lonE6: number): Promise<void> {
  await env.TENANT_A_DB.prepare(
    "INSERT OR IGNORE INTO legs (id, shipment_id, seq, kind, executor_party_id, geo) VALUES (?,?,?,?,?,?)",
  )
    .bind(`leg-${shipmentId}-${seq}`, shipmentId, seq, kind, "party-carrier", JSON.stringify({ lat_e6: latE6, lon_e6: lonE6 }))
    .run();
}

// A 64-hex hash, like every other direct-insert fixture in this suite (its own offset so the values
// never collide with theirs under the shared, isolatedStorage-off D1). `events.hash` is the Merkle leaf
// data for the daily anchor — the anchor backfill hex-decodes it — so a fixture that writes a non-hex
// value poisons that day's tree for every OTHER test file sharing this database.
let hashN = 0xd33000;
const nextHash = (): string => (hashN++).toString(16).padStart(64, "0");

// Seed a terminal driver event DIRECTLY (bypassing the sequencer) so the reveal pointer advances. The
// insert guard only aborts on a duplicate (stream_id,seq)/id, so a fresh row with a unique hash is fine.
async function seedTerminalEvent(shipmentId: string, kind: string, seq: number): Promise<void> {
  await env.TENANT_A_DB.prepare(
    "INSERT OR IGNORE INTO events (stream_id, seq, id, shipment_id, ts, recorded_at, kind, actor_party_id, party_refs, payload, evidence, prev_hash, hash, visibility, source, confidence) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      `s:${shipmentId}`,
      seq,
      `ev-${shipmentId}-${kind}-${seq}`,
      shipmentId,
      1000,
      1000,
      kind,
      "party-carrier",
      "[]",
      "{}",
      "[]",
      "GENESIS",
      nextHash(),
      "counterparty",
      "native",
      10000,
    )
    .run();
}

async function getManifest(t: string): Promise<{ status: number; body: Manifest | null }> {
  const res = await SELF.fetch("https://api.local/v1/driver/manifest", { headers: bearer(t) });
  let body: Manifest | null = null;
  try {
    body = (await res.json()) as Manifest;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

beforeAll(async () => {
  await ensureSchema(env);
  await seedShipment(SHIP_1, DRIVER_A, 1);
  await seedLeg(SHIP_1, 0, "pickup", 45_523_100, -122_676_500);
  await seedShipment(SHIP_2, DRIVER_A, 2);
  await seedLeg(SHIP_2, 0, "delivery", 45_600_000, -122_600_000);
  await seedShipment(SHIP_OTHER, DRIVER_B, 1);
  await seedLeg(SHIP_OTHER, 0, "pickup", 40_000_000, -70_000_000);
});

describe("GET /v1/driver/manifest (REQ-030/025) — authenticated, server-scoped driver read path", () => {
  it("an authenticated ASSIGNED driver receives only their own assigned stops", async () => {
    const t = await token({ sub: DRIVER_A, tenant: TENANT_SLUG, role: "driver" });
    const { status, body } = await getManifest(t);
    expect(status).toBe(200);
    expect(body).not.toBeNull();
    const ids = (body?.stops ?? []).map((s) => s.shipment_id);
    expect(ids).toContain(SHIP_1);
    expect(ids).toContain(SHIP_2);
    // A shipment assigned to ANOTHER driver never appears (cross-driver isolation).
    expect(ids).not.toContain(SHIP_OTHER);
    // The manifest echoes the AUTHENTICATED driver + tenant, resolved server-side (never from the body).
    expect(body?.driver_id).toBe(DRIVER_A);
    expect(body?.tenant).toBe(TENANT_SLUG);
    expect(typeof body?.server_ts).toBe("number");
  });

  it("a cross-driver probe returns NO manifest stops (DRIVER_B never sees DRIVER_A's shipments)", async () => {
    const t = await token({ sub: DRIVER_B, tenant: TENANT_SLUG, role: "driver" });
    const { status, body } = await getManifest(t);
    expect(status).toBe(200);
    const ids = (body?.stops ?? []).map((s) => s.shipment_id);
    expect(ids).toContain(SHIP_OTHER);
    expect(ids).not.toContain(SHIP_1);
    expect(ids).not.toContain(SHIP_2);
  });

  it("a driver with NO assignments gets an EMPTY manifest — never a demo/fixture day sheet", async () => {
    const t = await token({ sub: "u-dm-unassigned", tenant: TENANT_SLUG, role: "driver" });
    const { status, body } = await getManifest(t);
    expect(status).toBe(200);
    expect(body?.stops).toEqual([]);
  });

  it("precise future-stop geo is WITHHELD until the prior stop's terminal evidence is committed (V1 reveal)", async () => {
    // Before any terminal event: SHIP_1 (order 1) is the current stop → revealed; SHIP_2 (order 2) withheld.
    const t = await token({ sub: DRIVER_A, tenant: TENANT_SLUG, role: "driver" });
    const before = await getManifest(t);
    const b1 = before.body?.stops.find((s) => s.shipment_id === SHIP_1);
    const b2 = before.body?.stops.find((s) => s.shipment_id === SHIP_2);
    expect(b1?.revealed).toBe(true);
    expect(b1?.geo).not.toBeNull();
    expect(b2?.revealed).toBe(false);
    expect(b2?.geo).toBeNull(); // the precise future-stop field is not returned outside current V1 policy

    // Commit SHIP_1's terminal (pickup → stop.departed). Now SHIP_2 becomes current → revealed.
    await seedTerminalEvent(SHIP_1, "stop.departed", 1);
    const after = await getManifest(t);
    const a2 = after.body?.stops.find((s) => s.shipment_id === SHIP_2);
    expect(a2?.revealed).toBe(true);
    expect(a2?.geo).not.toBeNull();
  });

  it("the response is a STRICT allowlist — no assigned_driver / status_cache / internal fields leak", async () => {
    const t = await token({ sub: DRIVER_A, tenant: TENANT_SLUG, role: "driver" });
    const { body } = await getManifest(t);
    const allowedStopKeys = new Set(["shipment_id", "seq", "kind", "status", "revealed", "geo"]);
    for (const stop of body?.stops ?? []) {
      for (const key of Object.keys(stop)) {
        expect(allowedStopKeys.has(key)).toBe(true);
      }
    }
    const allowedTop = new Set(["server_ts", "tenant", "driver_id", "stops"]);
    for (const key of Object.keys(body ?? {})) {
      expect(allowedTop.has(key)).toBe(true);
    }
  });

  it("a NON-driver role (ops) is 403 — the manifest is the driver surface", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    const { status } = await getManifest(t);
    expect(status).toBe(403);
  });

  it("a missing bearer token is 401 (no anonymous manifest)", async () => {
    const res = await SELF.fetch("https://api.local/v1/driver/manifest");
    expect(res.status).toBe(401);
  });

  it("?tenant= is rejected at auth (tenant is server-resolved, never client-supplied)", async () => {
    const t = await token({ sub: DRIVER_A, tenant: TENANT_SLUG, role: "driver" });
    const res = await SELF.fetch("https://api.local/v1/driver/manifest?tenant=tenant-b", { headers: bearer(t) });
    expect(res.status).toBe(403);
  });
});
