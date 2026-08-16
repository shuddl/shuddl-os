import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { generateDeviceKey } from "@shuddl/driver-core";
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

  // §1470 (REQ-013/016) — ONE KEY, BOTH DERIVATIONS, ASSERTED EQUAL.
  //
  // `device_id` is computed INDEPENDENTLY in two places: `packages/driver-core/src/device-key.ts` (the driver,
  // from its own CryptoKey) and `workers/api/src/routes/devices.ts` (the server, by importing the enrolled
  // JWK). Both build `dev_` + hex SHA-256 of the SPKI encoding, and `devices.ts` states the coupling in a
  // comment — *"Derive the device_id from the public key EXACTLY as the client does (device-key.ts)"* — which
  // is the shape that is always a missing test. Nothing fed one key through both: the case above generates a
  // JWK with a TEST-LOCAL helper and asserts only that the result starts with `dev_`.
  //
  // What a divergence costs, traced rather than assumed: the driver's locally-computed id is the offline
  // dedupe key `(device_id, device_seq)`, and `sequencer.ts:317@device_id` requires a device-namespaced event's
  // `device_id` to equal `actor.device` AND its signature to verify — a guard written so one device cannot
  // squat another's slot. If the two derivations disagreed, every driver would sign captures under an id the
  // server never registered, and EVERY device-namespaced append would be refused. Fail-closed, so this is an
  // availability cliff rather than a mis-attribution — and one that no unit test would surface, because each
  // side is self-consistent. The only way to see it is one key through both.
  it("§1470: the id the DRIVER computes equals the id the SERVER derives (one key, both derivations)", async () => {
    const key = await generateDeviceKey(); // the REAL driver path, not the test's genPublicJwk
    const t = await token({ sub: DRIVER_A, tenant: TENANT_SLUG, role: "driver" });
    const res = await enroll(t, { public_jwk: key.publicJwk });
    expect(res.status === 200 || res.status === 201, "enrollment of a driver-core key must succeed").toBe(true);
    expect(
      res.body?.device_id,
      "the server derived a DIFFERENT device_id than the driver computed for the same key. The driver signs " +
        "captures under its own id and the sequencer requires that id to match the registered device, so a " +
        "divergence refuses every device-namespaced append. Keep `dev_` + hex SHA-256 of the SPKI encoding on " +
        "both sides (device-key.ts / devices.ts).",
    ).toBe(key.device_id);
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

  it("REQ-025: a token whose TENANT and SUB disagree cannot reach the other tenant's user row (audit §395)", async () => {
    // THE CLAIM IS THE BOUNDARY. `loadUser` resolves the caller as
    // `users u JOIN tenants t ON t.id = u.tenant_id WHERE t.slug = ? AND u.id = ?` — BOTH halves from the JWT.
    // Every test above pairs a tenant with one of ITS OWN subs, so none of them observes the join: dropping
    // `t.slug = ?` and matching on `u.id` alone left all 764 api tests GREEN.
    //
    // WHAT THE GUARD ACTUALLY STOPS. A tenant-a token carrying a tenant-b `sub` would load tenant-b's user row,
    // and both device writes are `UPDATE users SET device_keys = ? WHERE id = ?` — no tenant predicate of their
    // own. So the join is the ONLY thing standing between a mismatched claim and a cross-tenant WRITE onto the
    // driver-auth root. CLAUDE.md rule 8 calls a cross-tenant read anywhere a build failure; this is the read
    // that precedes the write, on the one database that is NOT physically partitioned.
    const mismatched = await token({ sub: DRIVER_B, tenant: TENANT_SLUG, role: "driver" });

    const enrolled = await enroll(mismatched, { public_jwk: await genPublicJwk() });
    expect(enrolled.status, "a mismatched claim must not resolve a principal").toBe(404);
    expect(enrolled.body?.device_id).toBeUndefined();

    const listed = await SELF.fetch("https://api.local/v1/devices", { headers: bearer(mismatched) });
    expect(listed.status).toBe(404);

    // And nothing was written to tenant-b's row — the assertion the 404 alone does not make.
    const row = await env.CONTROL_DB.prepare("SELECT device_keys FROM users WHERE id = ?").bind(DRIVER_B).first<{ device_keys: string }>();
    const keys = JSON.parse(row?.device_keys ?? "[]") as unknown[];
    const bOwn = await listDevices(await token({ sub: DRIVER_B, tenant: "tenant-b", role: "driver" }));
    expect(keys.length, "tenant-b's device list must be untouched by a tenant-a-claimed token").toBe(bOwn.ids.length);
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

  // REQ-025/013 — AN AUTHENTICATED PRINCIPAL WITH NO CONTROL-PLANE ROW (audit §375).
  //
  // `loadUser` resolves the caller against `users JOIN tenants ON t.slug = ?`, so it returns null for a
  // token whose `sub` has no row IN THIS TENANT — a deleted user, or a `sub` belonging to another tenant
  // carried on a token minted for this one. All three device handlers guard that with an IDENTICAL
  // `404 UNKNOWN PRINCIPAL`.
  //
  // WHY THESE EXIST. Changing that guard's status in EACH handler independently left all 757 api tests
  // GREEN — three times. The guard is replicated per handler, and one identical message across three
  // routes reads, in review, as "covered": a test asserting `404 UNKNOWN PRINCIPAL` proves nothing about
  // WHICH handler produced it, and in fact none did. This is the §81 sibling-guard shape without even a
  // sibling — the same guard, three times, observed zero times.
  //
  // The failure without them is a 500, not a leak: every handler dereferences `user` on the next line, so
  // a missing guard crashes rather than proceeds. That is why this is coverage of a correct guard (Low),
  // not an open hole — but device enrollment is the driver-auth root, and a regression that made
  // `loadUser` return a default instead of null would be silent on all three routes at once.
  const ghost = (): Promise<string> => token({ sub: "driver-with-no-control-row", tenant: TENANT_SLUG, role: "driver" });

  it("ENROLL by a principal with no control-plane row → 404, never a 500 and never an enrollment", async () => {
    const res = await enroll(await ghost(), { public_jwk: await genPublicJwk() });
    expect(res.status).toBe(404);
    expect(res.body?.device_id, "nothing may be enrolled for a principal that does not exist").toBeUndefined();
  });

  it("LIST by a principal with no control-plane row → 404, not an empty 200", async () => {
    // An empty 200 would be the dangerous degradation: indistinguishable from "this driver has no
    // devices", so a broken resolver would read as a normal, quiet state.
    const res = await SELF.fetch("https://api.local/v1/devices", { headers: bearer(await ghost()) });
    expect(res.status).toBe(404);
  });

  it("REVOKE by a principal with no control-plane row → 404 (the guard, not the device lookup)", async () => {
    // This handler has TWO 404s — the principal guard here, and `DEVICE NOT FOUND FOR THIS DRIVER` below
    // it. The device id is deliberately one that exists for nobody, so the status alone cannot say which
    // fired; the MESSAGE is the discriminator, per the §82 authoring rule.
    const res = await SELF.fetch("https://api.local/v1/devices/dev_nonexistent/revoke", { method: "POST", headers: mut(await ghost()) });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toBe("UNKNOWN PRINCIPAL");
  });
});

// §1587 (REQ-013/016/118) — `device_keys` IS ONE JSON COLUMN, SO EVERY WRITE IS A READ-MODIFY-WRITE.
//
// Both mutating routes read the whole array, change it in memory, and write it back. With an unguarded
// `UPDATE … WHERE id = ?` that is last-writer-wins, and MEASURED it lost data: two concurrent enrollments left
// **one** key. The driver then holds a key the control plane never recorded, and every event it signs is refused
// `UNAUTHORIZED: device signature` — a driver whose captures fail for no visible reason.
//
// The second case is the one that matters more. An enroll that read the array BEFORE a revoke landed writes it
// back afterwards and **resurrects the revoked key**: a phone reported lost stays able to sign. Both are now
// held by a compare-and-set on the exact bytes read, with a bounded retry.
//
// These drive the REAL routes concurrently rather than simulating an interleaving, so they assert the property
// (no update is lost) and not a particular schedule.
describe("§1587 REQ-013/016: concurrent device-key writes do not lose each other", () => {
  it("two enrollments racing each other BOTH survive (neither key is silently dropped)", async () => {
    await env.CONTROL_DB.prepare("INSERT OR IGNORE INTO users (id, tenant_id, email, role, auth, device_keys) VALUES (?,?,?,?,?,?)")
      .bind("u-race-1", "t-a", "race1@tenant-a.test", "driver", "{}", "[]")
      .run();
    const t = await token({ sub: "u-race-1", tenant: TENANT_SLUG, role: "driver" });
    // FIVE at once, not two, deliberately. Whether any two requests actually interleave between their read and
    // their write is the scheduler's business, so a 2-way race detects the defect only sometimes — measured, it
    // and the revoke case below traded which one reded run to run. With five writers a schedule in which NONE
    // overlaps is vanishingly unlikely, which is what makes this a regression test rather than a coin flip.
    const jwks = await Promise.all(Array.from({ length: 5 }, () => genPublicJwk()));
    const results = await Promise.all(jwks.map((jwk) => enroll(t, { public_jwk: jwk })));

    // THE PROPERTY IS `accepted ⇒ persisted`, not `all five succeed`. Optimistic concurrency does not promise
    // that every contender wins: a writer whose three attempts all lose the compare-and-set is REFUSED 409
    // ("CONTENDED — RETRY"), which is a caller-visible, retryable outcome. Asserting all five 2xx would be
    // asserting a promise the design does not make — the first draft of this case did exactly that and failed
    // against a correct implementation. What must never happen is a 2xx whose key is not there afterwards.
    const accepted = results.filter((r) => r.status === 200 || r.status === 201);
    expect(accepted.length, "under contention at least one writer should still win").toBeGreaterThanOrEqual(1);

    const listed = await listDevices(t);
    expect(
      listed.ids.length,
      `${accepted.length} enrollments were ACCEPTED but ${listed.ids.length} keys survive — an accepted write ` +
        "was overwritten. `device_keys` is a whole-array write, so without a compare-and-set a writer clobbers " +
        "everyone who read before it. The lost device signs events the control plane cannot verify, and the " +
        "driver sees captures refused for no visible reason.",
    ).toBe(accepted.length);
    expect(new Set(listed.ids).size, "the surviving devices must be distinct").toBe(listed.ids.length);
  });

  it("a revoke racing an enroll does NOT resurrect the revoked key", async () => {
    await env.CONTROL_DB.prepare("INSERT OR IGNORE INTO users (id, tenant_id, email, role, auth, device_keys) VALUES (?,?,?,?,?,?)")
      .bind("u-race-2", "t-a", "race2@tenant-a.test", "driver", "{}", "[]")
      .run();
    const t = await token({ sub: "u-race-2", tenant: TENANT_SLUG, role: "driver" });
    const lost = await enroll(t, { public_jwk: await genPublicJwk() });
    const lostId = lost.body?.device_id;
    expect(lostId, "setup: the device to be revoked must enrol").toBeDefined();

    // The lost phone is revoked at the same moment the driver enrols its replacement.
    const [revokeStatus] = await Promise.all([revoke(t, lostId!), enroll(t, { public_jwk: await genPublicJwk() })]);
    expect(revokeStatus).toBe(200);

    const listed = await listDevices(t);
    expect(
      listed.ids,
      "the REVOKED device is active again — the enrol wrote back an array it had read before the revoke landed. " +
        "A phone reported lost can sign events until someone notices.",
    ).not.toContain(lostId);
    expect(listed.ids.length, "the replacement device must still be enrolled").toBe(1);
  });
});
