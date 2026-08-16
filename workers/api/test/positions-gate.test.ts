import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { TENANT_SLUG, TEST_DEVICE_ID, ensureSchema, ensureTenantBSchema, post, seedShipment, token } from "./helpers.js";
import { eventFixture } from "@shuddl/contracts";
import { eventToRow } from "@shuddl/ledger/lens";
import { canonicalPositionBytes } from "@shuddl/ledger/anchor";
import { sha256Hex } from "@shuddl/ledger/canonical";

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

  // Audit §81 — asserts the REASON, not just the status. All three gates below answer 403, and SHP_OTHER
  // deliberately has no consent, so this case passed even with the assignment gate DELETED: it 403d from the
  // consent gate instead. A wrong-reason pass on a security test is indistinguishable from a right one until
  // someone removes the gate, which is exactly when you need it.
  it("driver posting to a shipment NOT assigned to them → 403 DRIVER NOT ASSIGNED (not merely some 403), nothing inserted", async () => {
    const ts = 1_720_000_100_001;
    const res = await postPosition(positionInput(SHP_OTHER, TEST_DEVICE_ID, ts), await driverTok());
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain("DRIVER NOT ASSIGNED");
    expect(await positionCountAll(SHP_OTHER)).toBe(0);
  });

  it("assigned driver but device_id NOT registered to them → 403, nothing inserted", async () => {
    const ts = 1_720_000_100_002;
    const res = await postPosition(positionInput(SHP_ASSIGNED, "device-not-registered", ts), await driverTok());
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain("DEVICE NOT REGISTERED");
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

  // §1629 (REQ-025/030) — THE FAIL-OPEN DIRECTION OF THE CONSENT GATE, which nothing covered.
  //
  // `loadStreamPrior(db, …)` takes the SESSION tenant's handle, so the gate's answer is computed from tenant
  // data — the §1628 shape, where a wrong handle changes the ANSWER rather than emptying it. Measured: pointing
  // that one call at tenant-b's D1 leaves `isolation.test.ts` (the REQ-025 gate) at 68/68 GREEN and reds 7 tests
  // here and in `lens-adversarial` — **all of them fail-CLOSED**, because tenant-b has no consent so legitimate
  // posts break. That is the safe direction, and it is the only one the suite could see.
  //
  // The dangerous direction is this one: a ConsentAck sitting in ANOTHER tenant's D1 for the same shipment id,
  // authorising GPS capture that THIS tenant's stream never authorised. Consent is the one gate where failing
  // open is a privacy breach rather than an outage, so it is worth pinning explicitly. Under the mutation this
  // case returns 201 instead of 403.
  it("a ConsentAck in ANOTHER tenant's D1 never unblocks this tenant's stream (REQ-025 value direction)", async () => {
    await ensureTenantBSchema(env);
    // The SAME shipment id tenant-a deliberately has no consent for, consented in tenant-b only.
    const e = eventFixture("document.attached", {
      id: crypto.randomUUID(),
      stream_id: `s:${SHP_NOCONSENT}`,
      shipment_id: SHP_NOCONSENT,
      seq: 0,
      visibility: "internal",
      party_refs: [],
      payload: { doc_kind: "consent", policy_version: "v1", operating_state: "CA", acknowledged: true },
    });
    const row = eventToRow(e);
    row.hash = "b1".padEnd(64, "0"); // unique 64-hex — keeps UNIQUE(hash) and the append-only insert guard happy
    const cols = Object.keys(row);
    await env.TENANT_B_DB.prepare(`INSERT OR IGNORE INTO events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
      .bind(...cols.map((c) => row[c]))
      .run();

    const ts = 1_720_000_100_013;
    const res = await postPosition(positionInput(SHP_NOCONSENT, TEST_DEVICE_ID, ts), await driverTok());
    // The reason must be UNCHANGED by tenant-b's row — same code, same required evidence (audit §81: assert the
    // REASON; a bare 403 here would also pass if the assignment or device gate had refused for its own reason).
    expect(res.status, "tenant-b's ConsentAck granted GPS capture on tenant-a's stream").toBe(403);
    expect(res.body?.code).toBe("GATE_BLOCKED");
    expect(res.body?.gate?.required_evidence).toContain("consent");
    expect(await positionCount(SHP_NOCONSENT, TEST_DEVICE_ID, ts)).toBe(0);
  });

  it("an `override` key on a position post is REFUSED OUTRIGHT (400) — it cannot even be expressed (audit §387)", async () => {
    // MIRRORS `booking-gate.test.ts`'s "a credit override does NOT rescue a no-contact recipient", which the
    // recipient gate has and this one did not. Both gates are declared NON-OVERRIDABLE the same way — neither
    // takes a `GateCtx`, so an override "cannot even be handed to it — a compile-time guarantee".
    //
    // WHAT THIS ACTUALLY FOUND. The first version of this test asserted 403 GATE_BLOCKED(consent), reasoning that
    // an override would be ignored. It got **400**: the request body is `.strict()`, so an unknown `override` key
    // is refused at PARSE time, before any gate runs. That is a stronger guarantee than being ignored — on this
    // surface an override is not overridden, it is inexpressible — and it is the property worth pinning, because
    // loosening the schema (`.passthrough()`, or adding an `override` field "for symmetry with events") would
    // silently make it expressible again and this test would go red.
    //
    // Consent is where that matters most: `evidence_recipient` failing open ships a booking nobody can be
    // emailed; consent failing open records a driver's location with no recorded permission — the CONFIRM-gated
    // counsel item (GO-LIVE-CHECKLIST, driver location-consent), not an evidence gap.
    const ts = 1_720_000_100_009;
    const withOverride = { ...positionInput(SHP_NOCONSENT, TEST_DEVICE_ID, ts), override: { by: "ops-lead", reason: "customer escalation" } };
    const res = await postPosition(withOverride, await driverTok());
    expect(res.status, "an override key must be refused by the strict body parse, not merely ignored").toBe(400);
    expect(await positionCount(SHP_NOCONSENT, TEST_DEVICE_ID, ts), "a refused ping must insert NOTHING").toBe(0);
  });

  it("and WITHOUT the override key the consent gate is what blocks — the 400 above is not masking a pass", async () => {
    // Non-vacuity control. Without it the test above would pass even if the consent gate had been deleted: a 400
    // proves the parse refused the request, never that the gate behind it still works.
    const ts = 1_720_000_100_010;
    const res = await postPosition(positionInput(SHP_NOCONSENT, TEST_DEVICE_ID, ts), await driverTok());
    expect(res.status).toBe(403);
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

// REQ-254 (audit §86) — REVOCATION MUST REVOKE.
//
// The devices suite proved a revoked key drops off the enrollment surface's active list. Nothing proved it
// loses WRITE access, and it did not: `deviceOwnedBy` (this route) and the sequencer's `#deviceKey` both
// matched on device_id alone, ignoring `revoked_ts`. So revoking a stolen or off-boarded driver's phone
// removed it from a list while it kept appending positions and signed events — the operator's one lever
// against a compromised device did nothing to the two paths that matter.
//
// A `devices.ts` comment had flagged exactly this ("needs a matching predicate in those two readers") and it
// lived ONLY there — no checklist row, no test. Both readers now carry `revoked_ts IS NULL`.
describe("REQ-254: a REVOKED device loses write access, not just its place on a list", () => {
  const REVOKED_DEVICE = "device-revoked-1";

  it("a revoked device is refused (403 DEVICE NOT REGISTERED), nothing inserted", async () => {
    // APPEND a revoked device — never rewrite the array. The api worker runs with isolatedStorage:false, so
    // this control-plane row is SHARED with every other test file; an earlier draft replaced device_keys
    // wholesale with a stub public_jwk and broke ten Biller tests that verify real POD signatures. Read,
    // append, write back.
    const row = await env.CONTROL_DB.prepare("SELECT device_keys FROM users WHERE id = ?").bind("u-driver").first<{ device_keys: string }>();
    const entries = JSON.parse(String(row?.device_keys ?? "[]")) as Array<Record<string, unknown>>;
    if (!entries.some((e) => e.device_id === REVOKED_DEVICE)) {
      entries.push({ device_id: REVOKED_DEVICE, public_jwk: {}, enrolled_ts: 1, revoked_ts: 2 });
      await env.CONTROL_DB.prepare("UPDATE users SET device_keys = ? WHERE id = ?").bind(JSON.stringify(entries), "u-driver").run();
    }
    const ts = 1_720_000_100_009;
    const res = await postPosition(positionInput(SHP_ASSIGNED, REVOKED_DEVICE, ts), await driverTok());
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain("DEVICE NOT REGISTERED");
    expect(await positionCount(SHP_ASSIGNED, REVOKED_DEVICE, ts)).toBe(0);
  });

  it("the driver's still-ACTIVE device is unaffected — revocation is per-device, not per-driver", async () => {
    const ts = 1_720_000_100_010;
    const res = await postPosition(positionInput(SHP_ASSIGNED, TEST_DEVICE_ID, ts), await driverTok());
    expect(res.status).toBe(201);
    expect(await positionCount(SHP_ASSIGNED, TEST_DEVICE_ID, ts)).toBe(1);
  });
});

// THE LOCKSTEP (audit §222). `/v1/positions` builds its integrity hash from an INLINE `canon` object
// (routes/positions.ts) and the daily anchor builds its Merkle leaf from `canonicalPositionBytes`
// (packages/ledger/src/anchor.ts) — two independent implementations of one canonical shape, in two
// packages, joined only by a comment: "Keep in lockstep with workers/api/src/routes/positions.ts."
//
// Measured, before this test existed: adding a field to the ledger side alone left ALL 1,365 tests green
// (614 ledger + 751 api). The anchor's own tests could not see it because they call
// canonicalPositionBytes on BOTH sides of their assertion — build the tree with it, verify the proof with
// it — so a mutation keeps them perfectly self-consistent while diverging from what was ingested (the
// §186/§187 shape, here on the byte law itself).
//
// This asserts the join the comment asks for: the hash the ROUTE stored must equal the hash of the bytes
// the ANCHOR would leaf. It is the only assertion in the repo that reads one side and computes the other.
describe("REQ-014/016 — the ingest hash and the anchor leaf are byte-identical", () => {
  it("the stored integrity hash equals sha256(canonicalPositionBytes(row))", async () => {
    const ts = 1_700_000_900_000;
    const input = {
      shipment_id: SHP_ASSIGNED,
      device_id: TEST_DEVICE_ID,
      ts,
      lat_e6: 37_421_000,
      lon_e6: -122_084_000,
      accuracy_m: 5,
      speed_cms: 1_200,
    };
    expect((await postPosition(input, await driverTok())).status).toBe(201);

    const row = await env.TENANT_A_DB.prepare(
      "SELECT shipment_id, device_id, ts, lat_e6, lon_e6, accuracy_m, speed_cms, hash FROM positions WHERE shipment_id = ? AND device_id = ? AND ts = ?",
    )
      .bind(SHP_ASSIGNED, TEST_DEVICE_ID, ts)
      .first<{
        shipment_id: string;
        device_id: string;
        ts: number;
        lat_e6: number;
        lon_e6: number;
        accuracy_m: number | null;
        speed_cms: number | null;
        hash: string;
      }>();
    expect(row).not.toBeNull();

    // Compute the ANCHOR's side from the stored row and compare to what the ROUTE wrote.
    const leaf = canonicalPositionBytes({
      shipment_id: row!.shipment_id,
      device_id: row!.device_id,
      ts: row!.ts,
      lat_e6: row!.lat_e6,
      lon_e6: row!.lon_e6,
      accuracy_m: row!.accuracy_m,
      speed_cms: row!.speed_cms,
    });
    expect(await sha256Hex(leaf)).toBe(row!.hash);
  });

  // THE ABSENT BRANCH (audit §429). The test above sends BOTH optional fields, so it only ever exercises
  // the present path — and the two implementations do not agree on how "absent" is spelled. The route omits
  // on `p.accuracy_m !== undefined` (a parsed request field, which the schema makes `number | undefined`
  // because accuracy_m is `.optional()`, never `.nullable()`); the anchor omits on `row.accuracy_m !== null`
  // (a D1 column, where the route's `?? null` landed). Those are consistent ONLY because of that schema
  // property. Making accuracy_m nullable — an unremarkable change, since clients routinely send null — puts
  // `accuracy_m: null` into the ingest's canonical bytes while the anchor still omits it, and every such
  // position's Merkle leaf stops matching the hash that was stored. This pins the branch that would break.
  it("a position with NO optional fields hashes identically on both sides (the omitted branch)", async () => {
    const ts = 1_700_000_901_000;
    expect(
      (await postPosition(
        { shipment_id: SHP_ASSIGNED, device_id: TEST_DEVICE_ID, ts, lat_e6: 37_421_001, lon_e6: -122_084_001 },
        await driverTok(),
      )).status,
    ).toBe(201);

    const row = await env.TENANT_A_DB.prepare(
      "SELECT shipment_id, device_id, ts, lat_e6, lon_e6, accuracy_m, speed_cms, hash FROM positions WHERE shipment_id = ? AND device_id = ? AND ts = ?",
    )
      .bind(SHP_ASSIGNED, TEST_DEVICE_ID, ts)
      .first<{
        shipment_id: string;
        device_id: string;
        ts: number;
        lat_e6: number;
        lon_e6: number;
        accuracy_m: number | null;
        speed_cms: number | null;
        hash: string;
      }>();
    expect(row).not.toBeNull();
    // Non-vacuity: this row must actually BE the omitted case, or the test silently re-runs the one above.
    expect(row!.accuracy_m).toBeNull();
    expect(row!.speed_cms).toBeNull();

    const leaf = canonicalPositionBytes({
      shipment_id: row!.shipment_id,
      device_id: row!.device_id,
      ts: row!.ts,
      lat_e6: row!.lat_e6,
      lon_e6: row!.lon_e6,
      accuracy_m: row!.accuracy_m,
      speed_cms: row!.speed_cms,
    });
    expect(await sha256Hex(leaf)).toBe(row!.hash);
  });
});
