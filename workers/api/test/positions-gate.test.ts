import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { TENANT_SLUG, TEST_DEVICE_ID, ensureSchema, post, seedShipment, token } from "./helpers.js";

// REQ-190 (2026-07-15 audit C-1) — SERVER-SIDE GATE PARITY for the raw-GPS bypass (REQ-030/166).
//
// POST /v1/positions is the PRIMARY GPS channel; it BYPASSES the sequencer (physical partition, no
// seq/hash-chain), so it does NOT reach the DO's Gatekeeper. The audit found it enforced ONLY the role
// gate — no driver-assignment scope, no device-registration check, and (the CRITICAL) NO consent-before-GPS
// gate — while the sequencer's `stop.arrived` path enforces all three. A driver could inject GPS for ANY
// shipment, under ANY device_id, with ZERO consent record, and it became a Merkle leaf. This suite pins the
// three gates the bypass must now re-enforce, byte-for-byte with the DO:
//   1. driver-assignment (mirror events.ts driver write-scope) — driver only; ops/admin unrestricted.
//   2. device-registration — the client device_id must be registered to the authenticated principal.
//   3. consent-before-GPS (assertConsentBeforeGps + deriveOperatingState) — a per-state ConsentAck must
//      already sit on the stream before the first raw ping is recorded.
// Each refusal must insert NOTHING (append-on-block is impossible for positions too).

const TENANT = TENANT_SLUG;
const DRIVER = "u-driver"; // the shared seeded driver (helpers.ts); device-1 is registered to it

// CA coordinates: deriveOperatingState → "CA", so ONE ConsentAck("CA") on the stream covers the ping.
const CA = { lat_e6: 37_421_000, lon_e6: -122_084_000 };

const SHP_ASSIGNED = "pg-shp-assigned"; // assigned to u-driver + a CA consent doc → happy path
const SHP_NOCONSENT = "pg-shp-noconsent"; // assigned to u-driver, NO consent → consent block
const SHP_OTHER = "pg-shp-other"; // NOT assigned to u-driver → assignment block

const driverTok = (): Promise<string> => token({ sub: DRIVER, tenant: TENANT, role: "driver" });
const opsTok = (): Promise<string> => token({ sub: "pg-ops", tenant: TENANT, role: "ops" });

interface PosRes {
  status: number;
  body: { code?: string; gate?: { required_evidence?: string[] } } | null;
}

async function postPosition(input: Record<string, unknown>, tok: string): Promise<PosRes> {
  const res = await SELF.fetch("https://api.local/v1/positions", {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  let body: PosRes["body"] = null;
  try {
    body = (await res.json()) as PosRes["body"];
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

function positionInput(shipmentId: string, deviceId: string, ts: number): Record<string, unknown> {
  return { shipment_id: shipmentId, device_id: deviceId, ts, lat_e6: CA.lat_e6, lon_e6: CA.lon_e6, accuracy_m: 5 };
}

// The EXACT four-field .strict() ConsentAck for "CA", appended as a document.attached event via the REAL
// events route (through the sequencer DO) — so loadStreamPrior reads it back exactly as the DO would.
function consentInput(shipmentId: string): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    shipment_id: shipmentId,
    ts: 1_720_000_000_000,
    actor: { party: "party-carrier" },
    party_refs: [],
    evidence: [],
    source: "native",
    confidence: 10_000,
    kind: "document.attached",
    payload: { doc_kind: "consent", policy_version: "v1", operating_state: "CA", acknowledged: true },
  };
}

async function assignDriver(shipmentId: string, driverSub: string): Promise<void> {
  await env.TENANT_A_DB.prepare("UPDATE shipments SET status_cache = json_set(status_cache, '$.assigned_driver', ?) WHERE id = ?")
    .bind(driverSub, shipmentId)
    .run();
}

async function positionCount(shipmentId: string, deviceId: string, ts: number): Promise<number> {
  const row = await env.TENANT_A_DB.prepare("SELECT COUNT(*) AS n FROM positions WHERE shipment_id = ? AND device_id = ? AND ts = ?")
    .bind(shipmentId, deviceId, ts)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function positionCountAll(shipmentId: string): Promise<number> {
  const row = await env.TENANT_A_DB.prepare("SELECT COUNT(*) AS n FROM positions WHERE shipment_id = ?")
    .bind(shipmentId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("POST /v1/positions — server-side gate parity (REQ-190)", () => {
  beforeAll(async () => {
    await ensureSchema(env);
    await seedShipment(SHP_ASSIGNED);
    await seedShipment(SHP_NOCONSENT);
    await seedShipment(SHP_OTHER);
    await assignDriver(SHP_ASSIGNED, DRIVER);
    await assignDriver(SHP_NOCONSENT, DRIVER);
    // SHP_OTHER is deliberately assigned to a DIFFERENT driver so this driver is unassigned to it.
    await assignDriver(SHP_OTHER, "some-other-driver");
    // Consent (CA) lives ONLY on SHP_ASSIGNED.
    const r = await post(SHP_ASSIGNED, consentInput(SHP_ASSIGNED), await opsTok());
    expect(r.status).toBe(201);
  });

  it("driver posting to a shipment NOT assigned to them → 403, nothing inserted", async () => {
    const ts = 1_720_000_100_001;
    const res = await postPosition(positionInput(SHP_OTHER, TEST_DEVICE_ID, ts), await driverTok());
    expect(res.status).toBe(403);
    expect(await positionCountAll(SHP_OTHER)).toBe(0);
  });

  it("assigned driver but device_id NOT registered to them → 403, nothing inserted", async () => {
    const ts = 1_720_000_100_002;
    const res = await postPosition(positionInput(SHP_ASSIGNED, "device-not-registered", ts), await driverTok());
    expect(res.status).toBe(403);
    expect(await positionCount(SHP_ASSIGNED, "device-not-registered", ts)).toBe(0);
  });

  it("assigned driver + registered device but NO consent on the stream → 403 GATE_BLOCKED(consent), nothing inserted", async () => {
    const ts = 1_720_000_100_003;
    const res = await postPosition(positionInput(SHP_NOCONSENT, TEST_DEVICE_ID, ts), await driverTok());
    expect(res.status).toBe(403);
    expect(res.body?.code).toBe("GATE_BLOCKED");
    expect(res.body?.gate?.required_evidence).toContain("consent");
    expect(await positionCount(SHP_NOCONSENT, TEST_DEVICE_ID, ts)).toBe(0);
  });

  it("assigned driver + registered device + a consent document present → 201, the row lands", async () => {
    const ts = 1_720_000_100_004;
    const res = await postPosition(positionInput(SHP_ASSIGNED, TEST_DEVICE_ID, ts), await driverTok());
    expect(res.status).toBe(201);
    expect(await positionCount(SHP_ASSIGNED, TEST_DEVICE_ID, ts)).toBe(1);
  });
});
