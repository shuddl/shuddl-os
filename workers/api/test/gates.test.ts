import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyChain, hashEvent } from "@shuddl/ledger/chain";
import { rowToEvent } from "@shuddl/ledger/lens";
import { signEvent } from "@shuddl/ledger/sign";
import { assertNever } from "../src/do/sequencer.js";
import {
  FENCE_CENTER,
  INSIDE,
  OUTSIDE,
  TENANT_SLUG,
  TEST_DEVICE_ID,
  ensureSchema,
  post,
  requiredEvidence,
  seedLeg,
  seedShipment,
  streamCount as countEvents,
  testDeviceSigningKey,
  token,
} from "./helpers.js";

// REQ-030 / REQ-007 / REQ-044/045/046/049/050/166 — THE ADVERSARIAL GATE SUITE.
//
// Every case drives the REAL API path (POST /v1/shipments/:id/events → sequencer DO → Gatekeeper),
// NOT a UI and NOT the pure gate. That is the whole point of REQ-030: the gate is enforced
// SERVER-SIDE in the ledger, so no client — UI, script, or direct API call — can bypass it. The gate
// CONTEXT (fence, isInterline, operating_state) is sourced SERVER-SIDE (legs / policy / a server
// derivation), never from the request body, so a driver cannot spoof "the fence is here" or "this
// isn't interline". For every gate we prove BOTH directions: a block returns GATE_BLOCKED with the
// missing evidence AND appends ZERO events (a refusal never half-writes), and the same transition
// APPENDS once its evidence is on the stream. Then: a named override (REQ-049) releases a block and is
// permanently recorded on the event; a malformed override is a clean 400; and a full happy-path stop
// chains end to end.

const TENANT = TENANT_SLUG;
const HEX64 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const HEX64_B = "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00";

// FENCE_CENTER / INSIDE / OUTSIDE — the shared delivery-fence fixture (helpers.ts). INSIDE sits on the
// fence, OUTSIDE ~1.5 km north; both derive to "CA", so ONE ConsentAck("CA") covers every stamp here.
// post / requiredEvidence / seedShipment / seedLeg / streamCount (countEvents) are shared from helpers.ts.

const opsTok = (): Promise<string> => token({ sub: "u-gate-ops", tenant: TENANT, role: "ops" });

function input(shipmentId: string, kind: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    shipment_id: shipmentId,
    ts: 1_720_000_000_000,
    actor: { party: "party-shipper" },
    party_refs: [],
    evidence: [],
    source: "native",
    confidence: 10_000,
    kind,
    payload: {},
    ...over,
  };
}

// A device-signed input (co-signed custody / a driver stamp): actor.device is the registered test
// device, and `sig` is a real P-256 signature over the clientView, which the DO verifies.
async function signedInput(shipmentId: string, kind: string, over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const i = input(shipmentId, kind, {
    actor: { party: "party-carrier", user: "user-driver", device: TEST_DEVICE_ID },
    ...over,
  });
  i.sig = await signEvent(i as Parameters<typeof signEvent>[0], await testDeviceSigningKey());
  return i;
}

const consentPayload = (state: string): Record<string, unknown> => ({
  doc_kind: "consent",
  policy_version: "v1",
  operating_state: state,
  acknowledged: true,
});

async function rawRows(shipmentId: string): Promise<Record<string, string | number | null>[]> {
  const res = await env.TENANT_A_DB.prepare("SELECT * FROM events WHERE stream_id = ? ORDER BY seq").bind(`s:${shipmentId}`).all();
  return res.results as Record<string, string | number | null>[];
}

beforeAll(async () => {
  await ensureSchema(env); // parties (party-shipper/-carrier/-consignee/-bill-to), the device key, tenant policy
});

// ─── REQ-044 — pickup depart is blocked until count + photo + custody are on the stream ─────────────
describe("pickup depart gate (REQ-044)", () => {
  const shp = "gate-pickup";
  it("stop.departed with no prior count/photo/custody → GATE_BLOCKED listing all three, ZERO append", async () => {
    await seedShipment(shp);
    const before = await countEvents(shp);
    const r = await post(shp, input(shp, "stop.departed", { payload: { geo: { ...INSIDE }, auto: true } }), await opsTok());
    expect(r.status).toBe(403);
    expect(r.json?.code).toBe("GATE_BLOCKED");
    expect(requiredEvidence(r)).toEqual(["freight.counted", "freight.photographed", "custody.transferred"]);
    expect(await countEvents(shp)).toBe(before); // a block NEVER appends
  });

  it("appends once count + freight photo + custody precede it", async () => {
    const s = "gate-pickup-ok";
    await seedShipment(s);
    expect((await post(s, input(s, "freight.counted", { payload: { pieces: 12 } }), await opsTok())).status).toBe(201);
    expect((await post(s, input(s, "freight.photographed", { payload: { photo_hash: HEX64, photo_kind: "freight" } }), await opsTok())).status).toBe(201);
    expect((await post(s, input(s, "custody.transferred", { payload: { from_party: "party-shipper", to_party: "party-carrier", unwitnessed: true } }), await opsTok())).status).toBe(201);
    const depart = await post(s, input(s, "stop.departed", { payload: { geo: { ...INSIDE }, auto: true } }), await opsTok());
    expect(depart.status).toBe(201);
  });
});

// ─── REQ-046 — delivery is blocked until a prior arrival sits cleanly INSIDE the (server-sourced) fence ─
describe("delivery geofence gate (REQ-046)", () => {
  const shp = "gate-delivery";
  it("signature + placed photo but the prior arrival is OUTSIDE the fence → GATE_BLOCKED ['geofence'], no append", async () => {
    await seedShipment(shp);
    await seedLeg(shp, 0, "delivery", FENCE_CENTER); // the fence is the delivery leg's dest geo — SERVER side
    const ops = await opsTok();
    expect((await post(shp, input(shp, "document.attached", { payload: consentPayload("CA") }), ops)).status).toBe(201);
    expect((await post(shp, input(shp, "stop.arrived", { payload: { geo: { ...OUTSIDE }, auto: true } }), ops)).status).toBe(201);
    expect((await post(shp, input(shp, "pod.signed", { payload: { signature_hash: HEX64, geo: { ...OUTSIDE }, unwitnessed: true } }), ops)).status).toBe(201);
    // The forced placed-freight photo (REQ-063), whose hash the POD reuses — the delivery gate binds the
    // POD's placed_photo_hash to THIS captured photo (a fabricated hash alone no longer clears the pillar).
    expect((await post(shp, input(shp, "freight.photographed", { payload: { photo_hash: HEX64, photo_kind: "placed" } }), ops)).status).toBe(201);

    const before = await countEvents(shp);
    const blocked = await post(shp, input(shp, "delivery.evidenced", { payload: { placed_photo_hash: HEX64, geo: { ...INSIDE } } }), ops);
    expect(blocked.status).toBe(403);
    expect(requiredEvidence(blocked)).toEqual(["geofence"]); // pod + placed photo bound; ONLY the fence fails
    expect(await countEvents(shp)).toBe(before);
  });

  it("appends once a prior arrival is INSIDE the fence (pod + placed photo already present)", async () => {
    const ops = await opsTok();
    expect((await post(shp, input(shp, "stop.arrived", { payload: { geo: { ...INSIDE }, auto: true } }), ops)).status).toBe(201);
    const ok = await post(shp, input(shp, "delivery.evidenced", { payload: { placed_photo_hash: HEX64, geo: { ...INSIDE } } }), ops);
    expect(ok.status).toBe(201);
  });
});

// ─── REQ-045 — an interline custody handoff needs a seal + a co-signed (device) receiver ack ─────────
describe("interline custody gate (REQ-045)", () => {
  it("no seal + unwitnessed on an interline leg → GATE_BLOCKED ['seal.applied','receiver_ack'], no append", async () => {
    const shp = "gate-interline";
    await seedShipment(shp);
    await seedLeg(shp, 0, "interline", null); // isInterline is sourced from THIS leg, not the request body
    const before = await countEvents(shp);
    const r = await post(shp, input(shp, "custody.transferred", { payload: { from_party: "party-carrier", to_party: "party-interline", unwitnessed: true } }), await opsTok());
    expect(r.status).toBe(403);
    expect(requiredEvidence(r)).toEqual(["seal.applied", "receiver_ack"]);
    expect(await countEvents(shp)).toBe(before);
  });

  it("appends with a seal + a device co-signed transfer", async () => {
    const shp = "gate-interline-ok";
    await seedShipment(shp);
    await seedLeg(shp, 0, "interline", null);
    const ops = await opsTok();
    expect((await post(shp, input(shp, "seal.applied", { payload: { seal_id: "seal-1", photo_hash: HEX64 } }), ops)).status).toBe(201);
    // REQ-045 needs the RECEIVER's cosig on the payload — NOT the transferring party's actor.device sig.
    const cosigned = await signedInput(shp, "custody.transferred", { payload: { from_party: "party-carrier", to_party: "party-interline", cosig: "receiver-cosign-abc" } });
    expect((await post(shp, cosigned, ops)).status).toBe(201);
  });

  it("a non-interline (consignee) handoff with no seal STILL appends — the gate does not apply", async () => {
    const shp = "gate-noninterline";
    await seedShipment(shp); // no interline leg → isInterline false → the seal/ack gate is a no-op
    const r = await post(shp, input(shp, "custody.transferred", { payload: { from_party: "party-carrier", to_party: "party-consignee", unwitnessed: true } }), await opsTok());
    expect(r.status).toBe(201);
  });
});

// ─── REQ-050 — an exception is blocked until its payload carries a photo AND a reason code ───────────
describe("exception gate (REQ-050)", () => {
  const shp = "gate-exception";
  it("exception.raised with no photo/reason → GATE_BLOCKED ['exception_photo','reason_code'], no append", async () => {
    await seedShipment(shp);
    const before = await countEvents(shp);
    const r = await post(shp, input(shp, "exception.raised", { payload: {} }), await opsTok());
    expect(r.status).toBe(403);
    expect(requiredEvidence(r)).toEqual(["exception_photo", "reason_code"]);
    expect(await countEvents(shp)).toBe(before);
  });
  it("appends with both a photo and a reason code", async () => {
    const r = await post(shp, input(shp, "exception.raised", { payload: { photo_hash: HEX64, reason_code: "damage" } }), await opsTok());
    expect(r.status).toBe(201);
  });
});

// ─── REQ-166 — a GPS stamp is blocked until a ConsentAck for its (server-derived) operating state ────
// stop.arrived is the sequencer-reachable GPS stamp; position.updated takes the partition bypass route,
// which enforces the SAME gate (out of this DO's scope).
describe("consent-before-GPS gate (REQ-166)", () => {
  const shp = "gate-consent";
  it("stop.arrived with no consent doc for the state → GATE_BLOCKED ['consent'], no append", async () => {
    await seedShipment(shp);
    const before = await countEvents(shp);
    const r = await post(shp, input(shp, "stop.arrived", { payload: { geo: { ...INSIDE }, auto: true } }), await opsTok());
    expect(r.status).toBe(403);
    expect(requiredEvidence(r)).toEqual(["consent"]);
    expect(await countEvents(shp)).toBe(before);
  });
  it("appends after a document.attached{ConsentAck} for the derived state (CA)", async () => {
    const ops = await opsTok();
    expect((await post(shp, input(shp, "document.attached", { payload: consentPayload("CA") }), ops)).status).toBe(201);
    const r = await post(shp, input(shp, "stop.arrived", { payload: { geo: { ...INSIDE }, auto: true } }), ops);
    expect(r.status).toBe(201);
  });
  it("a consent acknowledged for a DIFFERENT state does not cover this stamp (blocked ['consent'])", async () => {
    const s = "gate-consent-wrongstate";
    await seedShipment(s);
    const ops = await opsTok();
    expect((await post(s, input(s, "document.attached", { payload: consentPayload("TX") }), ops)).status).toBe(201);
    const r = await post(s, input(s, "stop.arrived", { payload: { geo: { ...INSIDE }, auto: true } }), ops); // INSIDE derives to CA, not TX
    expect(r.status).toBe(403);
    expect(requiredEvidence(r)).toEqual(["consent"]);
  });

  // WP-05 exit audit (REQ-166): a stamp deriving to the UNKNOWN-jurisdiction sentinel "XX" (a coordinate
  // outside every box — here Kansas) can't be consented, even with an "XX" document on the stream.
  it("a stamp deriving to XX (Kansas) is blocked even WITH an 'XX' document — you can't consent to an unknown state", async () => {
    const s = "gate-consent-xx";
    await seedShipment(s);
    const ops = await opsTok();
    // document.attached is a loose payload, so an "XX" claim is STORED — but it is not a valid ConsentAck,
    // and the stamp derives to XX, so the gate blocks up front regardless.
    expect((await post(s, input(s, "document.attached", { payload: consentPayload("XX") }), ops)).status).toBe(201);
    const KANSAS = { lat_e6: 38_500_000, lon_e6: -98_000_000, accuracy_m: 5 };
    const r = await post(s, input(s, "stop.arrived", { payload: { geo: KANSAS, auto: true } }), ops);
    expect(r.status).toBe(403);
    expect(requiredEvidence(r)).toEqual(["consent"]);
  });
});

// ─── REQ-049 — a NAMED override releases a block AND is permanently recorded on the event ────────────
describe("named override (REQ-049)", () => {
  it("an elevated-role override APPENDS; override.by is STAMPED to the authenticated author (client's claim overridden)", async () => {
    const shp = "gate-override";
    await seedShipment(shp);
    // The client CLAIMS a `by` — the route must OVERRIDE it with the authenticated session identity
    // (opsTok's sub = "u-gate-ops"), keeping only the client's `reason`. An accountability record that
    // can't be forged.
    const clientClaim = { by: "not-the-real-author", reason: "receiver waiting; count captured on paper BOL" };
    const r = await post(shp, input(shp, "stop.departed", { payload: { geo: { ...INSIDE }, auto: true }, override: clientClaim }), await opsTok());
    expect(r.status).toBe(201);
    const stamped = { by: "u-gate-ops", reason: clientClaim.reason };
    expect(r.json?.override).toEqual(stamped); // echoed on the append response — by is the authenticated sub

    // Permanently visible on the STORED event (REQ-049): the override rides the chained, hashed bytes.
    const rows = await rawRows(shp);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(JSON.parse(String(row.override_json))).toEqual(stamped);
    expect(await hashEvent(rowToEvent(row))).toBe(row.hash); // the override is INSIDE the verified hash
  });

  it("a DRIVER-token override is 403 FORBIDDEN with ZERO append — an override needs an elevated role", async () => {
    const shp = "gate-override-driver";
    await seedShipment(shp);
    const before = await countEvents(shp);
    const driverTok = await token({ sub: "u-gate-driver", tenant: TENANT, role: "driver" });
    const r = await post(shp, input(shp, "stop.departed", { payload: { geo: { ...INSIDE }, auto: true }, override: { by: "x", reason: "trust me" } }), driverTok);
    expect(r.status).toBe(403);
    expect(await countEvents(shp)).toBe(before); // nothing appended when a non-elevated role attempts an override
  });

  it("a malformed (blank) override is a clean 400 VALIDATION_FAILED, not a silent pass", async () => {
    const shp = "gate-override-bad";
    await seedShipment(shp);
    const before = await countEvents(shp);
    const r = await post(shp, input(shp, "stop.departed", { payload: { geo: { ...INSIDE }, auto: true }, override: { by: "  ", reason: "" } }), await opsTok());
    expect(r.status).toBe(400);
    expect(r.json?.code).toBe("VALIDATION_FAILED");
    expect(await countEvents(shp)).toBe(before); // an unaccountable override never releases the gate
  });

  it("the consent gate is NON-overridable — a named override does NOT release a consent block", async () => {
    const shp = "gate-consent-nooverride";
    await seedShipment(shp);
    const r = await post(shp, input(shp, "stop.arrived", { payload: { geo: { ...INSIDE }, auto: true }, override: { by: "dispatcher-jane", reason: "trust me" } }), await opsTok());
    expect(r.status).toBe(403);
    expect(requiredEvidence(r)).toEqual(["consent"]); // consent is a legal precondition, not a waivable evidence item
  });
});

// ─── the gate-dispatch exhaustiveness guard fails LOUD (no silent ungated append) ───────────────────
describe("gate dispatch exhaustiveness (REQ-030 fail-loud, not fail-open)", () => {
  it("assertNever throws — a GATED_KINDS/switch desync is a compile error AND a runtime throw, never a fall-through", () => {
    // In shipped code this is unreachable (the switch is exhaustive over GatedKind); this proves the
    // runtime belt: if a future kind were added to GATED_KINDS without a switch case, the append throws
    // instead of writing an UNGATED event.
    expect(() => assertNever("stop.teleported" as never)).toThrow(/unreachable gate dispatch/);
  });
});

// ─── the happy path chains: arrive → count → photo → custody → depart → sign → deliver ───────────────
describe("happy-path stop chains and verifies (REQ-007/030)", () => {
  it("a fully-evidenced pickup+delivery appends every event and the chain verifies", async () => {
    const shp = "gate-happy";
    await seedShipment(shp);
    await seedLeg(shp, 0, "delivery", FENCE_CENTER);
    const ops = await opsTok();
    const steps: Array<[string, Record<string, unknown>]> = [
      ["document.attached", { payload: consentPayload("CA") }],
      ["stop.arrived", { payload: { geo: { ...INSIDE }, auto: true } }],
      ["freight.counted", { payload: { pieces: 12 } }],
      ["freight.photographed", { payload: { photo_hash: HEX64, photo_kind: "freight" } }],
      ["custody.transferred", { payload: { from_party: "party-shipper", to_party: "party-carrier", unwitnessed: true } }],
      ["stop.departed", { payload: { geo: { ...INSIDE }, auto: true } }],
      ["pod.signed", { payload: { signature_hash: HEX64_B, geo: { ...INSIDE }, unwitnessed: true } }],
      // the forced placed-freight photo — its hash is what the POD's placed_photo_hash binds to (REQ-046/063).
      ["freight.photographed", { payload: { photo_hash: HEX64_B, photo_kind: "placed" } }],
      ["delivery.evidenced", { payload: { placed_photo_hash: HEX64_B, geo: { ...INSIDE } } }],
    ];
    for (const [kind, over] of steps) {
      const r = await post(shp, input(shp, kind, over), ops);
      expect(r.status, `${kind} should append`).toBe(201);
    }
    const events = (await rawRows(shp)).map((r) => rowToEvent(r));
    expect(events).toHaveLength(steps.length);
    expect((await verifyChain(events)).ok).toBe(true);
  });
});
