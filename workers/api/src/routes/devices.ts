import type { Hono } from "hono";
import { z } from "@shuddl/contracts";
import { sha256Hex } from "@shuddl/ledger/canonical";
import { ApiError } from "../middleware/error.js";
import { requireRole } from "../middleware/auth.js";
import type { Env, Vars } from "../index.js";

// Task 11 Step 4 (REQ-013/016/011/025) — authenticated device enrollment. A driver PWA mints a P-256
// signing key on-device (device-key.ts) and registers its PUBLIC half here; the sequencer later verifies
// device signatures against it (users.device_keys[]). This route is the control-plane authority for that
// binding:
//   · IDENTITY FROM AUTH ONLY — the device binds to session.sub in session.tenant. The device_id is
//     DERIVED server-side from the key (never trusted from the body), and a body-supplied driver id is
//     rejected outright (the strict schema).
//   · UNIQUENESS — a device already registered (and active) to a DIFFERENT driver in the tenant cannot be
//     re-claimed (409). Re-enrolling one's OWN key is idempotent.
//   · REVOCATION — POST /v1/devices/:id/revoke retires a device; a revoked device drops off the active
//     list and a later re-enroll reactivates it.
//   · TENANT ISOLATION — every read/write is scoped by the tenant slug from the JWT (join to tenants), so
//     a device in one tenant is invisible to another.
//
// NOTE (follow-up, outside Task 11's file list): the sequencer's device-signature accept path
// (workers/api/src/do/sequencer.ts #deviceKey) and the positions ownership check (gate-context.ts
// deviceOwnedBy) do NOT yet exclude a `revoked_ts`-marked entry — so revocation is enforced here at the
// control-plane record + this surface's reads, but end-to-end signature REJECTION of a revoked device
// needs a matching predicate in those two readers. Flagged rather than silently editing files this task
// does not own.

// The strict enrollment body — ONLY the public key. Any extra top-level field (a body-supplied driver_id
// / sub) fails .strict() ⇒ 400, so the client can never smuggle an identity claim. The inner JWK allows
// the standard EC public fields (and passthrough for ext/key_ops) but REQUIRES kty/crv/x/y.
const DeviceEnrollBody = z
  .object({
    public_jwk: z
      .object({ kty: z.string(), crv: z.string(), x: z.string(), y: z.string() })
      .passthrough(),
  })
  .strict();

interface DeviceEntry {
  device_id: string;
  public_jwk: Record<string, unknown>;
  enrolled_ts?: number;
  revoked_ts?: number | null;
}

// Derive the device_id from the public key EXACTLY as the client does (device-key.ts): `dev_` + the hex
// SHA-256 of the SPKI encoding. Returns null on an unimportable/malformed key (→ 400). Never trusts a
// client-supplied device_id — the id is a pure function of the key the client proves it holds.
async function deriveDeviceId(jwk: JsonWebKey): Promise<string | null> {
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
  } catch {
    return null;
  }
  try {
    const spki = await crypto.subtle.exportKey("spki", key);
    return `dev_${await sha256Hex(new Uint8Array(spki))}`;
  } catch {
    return null;
  }
}

// The authenticated driver's control-plane user row, scoped by the tenant slug from the JWT (REQ-025).
async function loadUser(control: D1Database, tenant: string, sub: string): Promise<{ id: string; device_keys: string } | null> {
  return control
    .prepare("SELECT u.id AS id, u.device_keys AS device_keys FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE t.slug = ? AND u.id = ?")
    .bind(tenant, sub)
    .first<{ id: string; device_keys: string }>();
}

function parseEntries(raw: string): DeviceEntry[] {
  try {
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? (arr as DeviceEntry[]) : [];
  } catch {
    return [];
  }
}

export function mountDeviceRoutes(app: Hono<{ Bindings: Env; Variables: Vars }>): void {
  // POST /v1/devices — enroll the driver's P-256 public key. driver-only.
  app.post("/v1/devices", requireRole("driver"), async (c) => {
    const parsed = DeviceEnrollBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError("VALIDATION_FAILED", 400, "BODY MUST BE { public_jwk } — NO OTHER FIELDS");

    const deviceId = await deriveDeviceId(parsed.data.public_jwk as JsonWebKey);
    if (deviceId === null) throw new ApiError("VALIDATION_FAILED", 400, "public_jwk IS NOT A VALID P-256 PUBLIC KEY");

    const session = c.get("session");
    const control = c.env.CONTROL_DB;
    const user = await loadUser(control, session.tenant, session.sub);
    if (user === null) throw new ApiError("NOT_FOUND", 404, "UNKNOWN PRINCIPAL");

    // Uniqueness — an ACTIVE registration of this device to ANOTHER driver in the tenant blocks the claim.
    const conflict = await control
      .prepare(
        "SELECT u.id AS uid FROM users u JOIN tenants t ON t.id = u.tenant_id, json_each(u.device_keys) je " +
          "WHERE t.slug = ?1 AND u.id != ?2 AND json_extract(je.value,'$.device_id') = ?3 AND json_extract(je.value,'$.revoked_ts') IS NULL LIMIT 1",
      )
      .bind(session.tenant, session.sub, deviceId)
      .first<{ uid: string }>();
    if (conflict !== null) throw new ApiError("VALIDATION_FAILED", 409, "DEVICE ALREADY ENROLLED TO ANOTHER DRIVER");

    const entries = parseEntries(user.device_keys);
    const now = Date.now();
    const idx = entries.findIndex((e) => e.device_id === deviceId);
    let status: 200 | 201 = 201;
    if (idx >= 0) {
      // Own key: idempotent when active, REACTIVATE when previously revoked (drop revoked_ts, restamp).
      entries[idx] = { device_id: deviceId, public_jwk: parsed.data.public_jwk, enrolled_ts: now };
      status = 200;
    } else {
      entries.push({ device_id: deviceId, public_jwk: parsed.data.public_jwk, enrolled_ts: now });
    }
    await control.prepare("UPDATE users SET device_keys = ? WHERE id = ?").bind(JSON.stringify(entries), session.sub).run();
    return c.json({ device_id: deviceId, enrolled: true }, status);
  });

  // GET /v1/devices — the driver's ACTIVE (non-revoked) devices. driver-only, tenant-scoped.
  app.get("/v1/devices", requireRole("driver"), async (c) => {
    const session = c.get("session");
    const user = await loadUser(c.env.CONTROL_DB, session.tenant, session.sub);
    if (user === null) throw new ApiError("NOT_FOUND", 404, "UNKNOWN PRINCIPAL");
    const devices = parseEntries(user.device_keys)
      .filter((e) => e.revoked_ts == null)
      .map((e) => ({ device_id: e.device_id, enrolled_ts: e.enrolled_ts ?? null }));
    return c.json({ devices });
  });

  // POST /v1/devices/:device_id/revoke — retire one of the driver's own devices. driver-only.
  app.post("/v1/devices/:device_id/revoke", requireRole("driver"), async (c) => {
    const session = c.get("session");
    const deviceId = c.req.param("device_id");
    const user = await loadUser(c.env.CONTROL_DB, session.tenant, session.sub);
    if (user === null) throw new ApiError("NOT_FOUND", 404, "UNKNOWN PRINCIPAL");
    const entries = parseEntries(user.device_keys);
    const entry = entries.find((e) => e.device_id === deviceId && e.revoked_ts == null);
    if (entry === undefined) throw new ApiError("NOT_FOUND", 404, "DEVICE NOT FOUND FOR THIS DRIVER");
    entry.revoked_ts = Date.now();
    await c.env.CONTROL_DB.prepare("UPDATE users SET device_keys = ? WHERE id = ?").bind(JSON.stringify(entries), session.sub).run();
    return c.json({ device_id: deviceId, revoked: true });
  });
}
