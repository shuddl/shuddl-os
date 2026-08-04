import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureSchema, token, TENANT_SLUG } from "./helpers.js";

// Task 11 Step 4 (REQ-013/016/011/025) — POST /v1/devices enrolls a driver's P-256 PUBLIC key and binds
// it to the AUTHENTICATED driver (session.sub) with uniqueness, revocation, and tenant isolation. The
// device_id is DERIVED server-side from the key (never trusted from the body), the binding uses the JWT
// principal ONLY (a body-supplied driver id is rejected), and a device registered to one driver cannot be
// claimed by another. GET /v1/devices lists the driver's ACTIVE devices; POST /v1/devices/:id/revoke
// retires one.

const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
const mut = (t: string): Record<string, string> => ({
  Authorization: `Bearer ${t}`,
  "Idempotency-Key": crypto.randomUUID(),
  "content-type": "application/json",
});

async function genPublicJwk(): Promise<JsonWebKey> {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
}

interface EnrollRes {
  status: number;
  body: { device_id?: string } | null;
}
async function enroll(t: string, extraBody: Record<string, unknown>): Promise<EnrollRes> {
  const res = await SELF.fetch("https://api.local/v1/devices", { method: "POST", headers: mut(t), body: JSON.stringify(extraBody) });
  let body: { device_id?: string } | null = null;
  try {
    body = (await res.json()) as { device_id?: string };
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function listDevices(t: string): Promise<{ status: number; ids: string[] }> {
  const res = await SELF.fetch("https://api.local/v1/devices", { headers: bearer(t) });
  const body = (await res.json().catch(() => ({ devices: [] }))) as { devices?: { device_id: string }[] };
  return { status: res.status, ids: (body.devices ?? []).map((d) => d.device_id) };
}

async function revoke(t: string, deviceId: string): Promise<number> {
  const res = await SELF.fetch(`https://api.local/v1/devices/${deviceId}/revoke`, { method: "POST", headers: mut(t) });
  return res.status;
}

const DRIVER_A = "u-dev-a";
const DRIVER_A2 = "u-dev-a2";
const DRIVER_B = "u-dev-b"; // tenant-b

beforeAll(async () => {
  await ensureSchema(env);
  await env.CONTROL_DB.prepare("INSERT OR IGNORE INTO tenants (id, name, slug, plan, policy, created_ts) VALUES (?,?,?,?,?,?)")
    .bind("t-b", "Tenant B", "tenant-b", "pilot", "{}", 0)
    .run();
  const users: [string, string, string][] = [
    [DRIVER_A, "t-a", "dev-a@tenant-a.test"],
    [DRIVER_A2, "t-a", "dev-a2@tenant-a.test"],
    [DRIVER_B, "t-b", "dev-b@tenant-b.test"],
  ];
  for (const [id, tid, email] of users) {
    await env.CONTROL_DB.prepare("INSERT OR IGNORE INTO users (id, tenant_id, email, role, auth, device_keys) VALUES (?,?,?,?,?,?)")
      .bind(id, tid, email, "driver", "{}", "[]")
      .run();
  }
});

describe("POST /v1/devices — authenticated device enrollment (REQ-013/016/025)", () => {
  it("enrolls a driver's P-256 key, deriving the device_id server-side, and lists it", async () => {
    const t = await token({ sub: DRIVER_A, tenant: TENANT_SLUG, role: "driver" });
    const jwk = await genPublicJwk();
    const res = await enroll(t, { public_jwk: jwk });
    expect(res.status === 200 || res.status === 201).toBe(true);
    expect(res.body?.device_id?.startsWith("dev_")).toBe(true);
    const listed = await listDevices(t);
    expect(listed.ids).toContain(res.body?.device_id);
  });

  it("re-enrolling the SAME key is idempotent — one device entry, not two", async () => {
    const t = await token({ sub: DRIVER_A, tenant: TENANT_SLUG, role: "driver" });
    const jwk = await genPublicJwk();
    const first = await enroll(t, { public_jwk: jwk });
    const again = await enroll(t, { public_jwk: jwk });
    expect(again.body?.device_id).toBe(first.body?.device_id);
    const listed = await listDevices(t);
    expect(listed.ids.filter((d) => d === first.body?.device_id)).toHaveLength(1);
  });

  // Audit §94 — the COMPLEMENT of the uniqueness rule, and the third revoked_ts site. The 409 above is
  // scoped to an ACTIVE registration: once a device is revoked it must be re-claimable, or an off-boarded
  // driver's handset is permanently unusable by the next driver. Removing the `revoked_ts IS NULL` clause
  // from that uniqueness query left the suite green (§93's "does each site fail independently" applied to
  // all five revoked_ts sites), so the fail-CLOSED direction was unpinned.
  it("a REVOKED device CAN be claimed by another driver — the 409 is scoped to ACTIVE registrations", async () => {
    const jwk = await genPublicJwk();
    const ta = await token({ sub: DRIVER_A, tenant: TENANT_SLUG, role: "driver" });
    const ta2 = await token({ sub: DRIVER_A2, tenant: TENANT_SLUG, role: "driver" });
    const first = await enroll(ta, { public_jwk: jwk });
    const deviceId = String(first.body?.device_id);
    expect(await revoke(ta, deviceId)).toBe(200);
    // Now the SAME key enrols for a different driver: the prior registration is revoked, so it does not block.
    const reclaimed = await enroll(ta2, { public_jwk: jwk });
    expect(reclaimed.status === 200 || reclaimed.status === 201).toBe(true);
    expect((await listDevices(ta2)).ids).toContain(deviceId);
  });

  it("UNIQUENESS: a device registered to one driver cannot be claimed by another (409)", async () => {
    const jwk = await genPublicJwk();
    const ta = await token({ sub: DRIVER_A, tenant: TENANT_SLUG, role: "driver" });
    const ta2 = await token({ sub: DRIVER_A2, tenant: TENANT_SLUG, role: "driver" });
    const first = await enroll(ta, { public_jwk: jwk });
    expect(first.status === 200 || first.status === 201).toBe(true);
    const stolen = await enroll(ta2, { public_jwk: jwk });
    expect(stolen.status).toBe(409);
    // The device stays bound to DRIVER_A only.
    expect((await listDevices(ta)).ids).toContain(first.body?.device_id);
    expect((await listDevices(ta2)).ids).not.toContain(first.body?.device_id);
  });

  it("NEVER trusts a driver id from the body — an extra identity field is rejected (strict)", async () => {
    const t = await token({ sub: DRIVER_A, tenant: TENANT_SLUG, role: "driver" });
    const jwk = await genPublicJwk();
    const res = await enroll(t, { public_jwk: jwk, driver_id: DRIVER_A2, sub: DRIVER_A2 });
    expect(res.status).toBe(400);
  });

  it("TENANT ISOLATION: a device enrolled in tenant-a is invisible to a tenant-b driver", async () => {
    const jwk = await genPublicJwk();
    const ta = await token({ sub: DRIVER_A, tenant: TENANT_SLUG, role: "driver" });
    const tb = await token({ sub: DRIVER_B, tenant: "tenant-b", role: "driver" });
    const enrolled = await enroll(ta, { public_jwk: jwk });
    const bList = await listDevices(tb);
    expect(bList.ids).not.toContain(enrolled.body?.device_id);
    // A tenant-b driver can still enroll its own key independently.
    const bEnroll = await enroll(tb, { public_jwk: await genPublicJwk() });
    expect(bEnroll.status === 200 || bEnroll.status === 201).toBe(true);
    expect((await listDevices(tb)).ids).toContain(bEnroll.body?.device_id);
  });

  it("REVOCATION: a revoked device drops off the active list; re-enrolling reactivates it", async () => {
    const t = await token({ sub: DRIVER_A, tenant: TENANT_SLUG, role: "driver" });
    const jwk = await genPublicJwk();
    const res = await enroll(t, { public_jwk: jwk });
    const deviceId = res.body?.device_id as string;
    expect(await revoke(t, deviceId)).toBe(200);
    expect((await listDevices(t)).ids).not.toContain(deviceId);
    const re = await enroll(t, { public_jwk: jwk });
    expect(re.body?.device_id).toBe(deviceId);
    expect((await listDevices(t)).ids).toContain(deviceId);
  });

  it("a non-driver role cannot enroll a device (403)", async () => {
    const t = await token({ sub: "u1", tenant: TENANT_SLUG, role: "ops" });
    const res = await enroll(t, { public_jwk: await genPublicJwk() });
    expect(res.status).toBe(403);
  });

  it("an invalid public key is rejected (400)", async () => {
    const t = await token({ sub: DRIVER_A, tenant: TENANT_SLUG, role: "driver" });
    const res = await enroll(t, { public_jwk: { kty: "EC", crv: "P-256", x: "not-a-key" } });
    expect(res.status).toBe(400);
  });
});
