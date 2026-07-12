import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyChain } from "@shuddl/ledger/chain";
import { rowToEvent } from "@shuddl/ledger/lens";
import {
  assertDelivery,
  GateError,
  REQUIRED_EVIDENCE,
  type Fence,
} from "@shuddl/ledger/gates/transition-gates";
import type { EventInput, EventKind, LedgerEvent } from "@shuddl/contracts";
import { capture, type CaptureParams, type DeviceContext, type EvidenceField } from "@shuddl/driver-core";
import {
  CONSENT,
  FENCE_CENTER,
  INSIDE,
  OUTSIDE,
  TENANT_SLUG,
  TEST_DEVICE_ID,
  ensureSchema,
  nextEvidenceBytes,
  post,
  requiredEvidence,
  seedDeliveryLeg,
  seedShipment,
  streamCount,
  testDeviceSigningKey,
  token,
  type Res,
} from "./helpers.js";

// ─── REQ-046 — THE POD HEARTBEAT (WP-05 Task 9) ─────────────────────────────────────────────────────
//
// The end-to-end proof that the delivery gate COMPLETES and FIRES the POD. Drive the full delivery
// sequence through the REAL sequencer (POST /v1/shipments/:id/events → sequencer DO → Gatekeeper),
// every step a driver-core-signed OFFLINE capture (the same `capture` the PWA and the airplane soak
// use), in gate-valid order:
//
//   document.attached{ConsentAck} → stop.arrived(INSIDE the seeded fence)
//     → freight.photographed{placed}  (the FORCED placed-freight photo, REQ-063; its hash is threaded)
//     → pod.signed(signature_hash + geo)
//     → delivery.evidenced(placed_photo_hash + geo)   ← THE POD
//
// The POD (`delivery.evidenced`) is the single event the Biller projects downstream. This test proves
// it LANDS with its full evidence bundle on the happy path, and is BLOCKED (never appends) when any of
// the three evidence pillars — geofence, pod.signed, placed photo — is missing.
//
// ─── WP-06 BOUNDARY — READ THIS (REQ-046 DoD) ───────────────────────────────────────────────────────
// The acceptance demo is "signature at a door → invoice event + consignee photo email <5s". WP-05 fires
// ONLY the POD. The Biller (WP-06) is what PROJECTS `delivery.evidenced` → `invoice.issued` + the
// consignee evidence email; the "<5s email" lands when WP-06 closes. This test therefore:
//   • asserts the POD FIRES with its evidence bundle (placed_photo_hash + geo, and a co-present
//     pod.signed carrying signature_hash + geo), and
//   • asserts NO money + NO email is emitted here — zero money_lines after the POD (money.ts projects a
//     line ONLY on invoice.issued; delivery.evidenced/pod.signed are no-ops, verified).
// It NEVER emits invoice.issued or any email — that is WP-06's job, on purpose.
//
// VENUE / SCOPE (honest note, mirroring gates.test + airplane-soak): the reused, pre-registered test
// device (`TEST_DEVICE_ID`, helpers.ts) co-signs every capture, and the sync POSTs carry an OPS token
// (unrestricted write scope) — the driver-assignment write gate is a separate concern (gates.test /
// routes). isolatedStorage is OFF (all api test files share ONE D1), so every case is scoped to its own
// shipment/stream id and never assumes an empty table.
//
// The HTTP + fence/seed fixtures (post/Res/requiredEvidence/streamCount/seedShipment/seedDeliveryLeg/
// FENCE_CENTER/INSIDE/OUTSIDE/CONSENT/nextEvidenceBytes) are SHARED from helpers.ts — one source of
// truth for the append path and the fence, so gates.test / airplane-soak / this file cannot drift.

const TENANT = TENANT_SLUG;
const HEX64_RE = /^[0-9a-f]{64}$/;
const FENCE: Fence = { ...FENCE_CENTER, radius_m: 150 }; // what the DO derives from the leg + default radius

// Read the stream back as verifiable LedgerEvents / count its money projection (pod-specific probes).
async function streamEvents(shipmentId: string): Promise<LedgerEvent[]> {
  const res = await env.TENANT_A_DB.prepare("SELECT * FROM events WHERE stream_id = ? ORDER BY seq")
    .bind(`s:${shipmentId}`)
    .all();
  return (res.results as Record<string, string | number | null>[]).map((r) => rowToEvent(r));
}
// WP-06 boundary probe: money.ts writes a money_line ONLY on invoice.issued. Zero here proves the POD
// fired WITHOUT any money projection — the invoice is a separate, later (WP-06) event.
async function moneyLineCount(shipmentId: string): Promise<number> {
  const row = await env.TENANT_A_DB.prepare("SELECT COUNT(*) AS n FROM money_lines WHERE shipment_id = ?")
    .bind(shipmentId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ── one reused device + monotonic counters (deterministic; never Date.now / Math.random) ─────────────
let deviceCtx: DeviceContext;
let opsTok: string;
let seq = 0; // per-device offline dedupe counter — monotonic, never reused across the whole file
let clock = 1_720_000_000_000; // captured_ts base; +1 per capture

// Capture a driver-core-signed OFFLINE event and POST it through the real sequencer. Evidence-bearing
// steps (the forced placed photo, the signature) hash their bytes AT capture (REQ-017); the hash lands
// in `evidenceField` and comes back for threading (the placed hash → the terminal delivery.evidenced).
async function driveStep(
  shipmentId: string,
  kind: EventKind,
  payload: Record<string, unknown>,
  evidenceField?: EvidenceField,
): Promise<{ res: Res; event: EventInput; hash?: string }> {
  const ts = clock++;
  const params: CaptureParams = { shipment_id: shipmentId, kind, payload, ts, captured_ts: ts, actor_user: "user-driver" };
  if (evidenceField !== undefined) params.evidence = { bytes: nextEvidenceBytes(), field: evidenceField };
  const { event, deferred } = await capture(params, deviceCtx);
  const res = await post(shipmentId, event, opsTok);
  return deferred ? { res, event, hash: deferred.hash } : { res, event };
}

beforeAll(async () => {
  await ensureSchema(env); // parties + tenant policy + the shared driver `u-driver` / device `device-1`

  deviceCtx = {
    device_id: TEST_DEVICE_ID,
    privateKey: await testDeviceSigningKey(),
    party: "party-carrier",
    nextSeq: () => seq++, // MONOTONIC per device (REQ-016) — the offline dedupe key
  };
  opsTok = await token({ sub: "u-pod-ops", tenant: TENANT, role: "ops" });

  for (const id of ["pod-happy", "pod-outside", "pod-nosig", "pod-nophoto"]) {
    await seedShipment(id);
    await seedDeliveryLeg(id);
  }
});

describe("POD heartbeat — the delivery gate completes and fires delivery.evidenced (REQ-046)", () => {
  it("HAPPY PATH: the full delivery sequence appends every step and the POD lands with its evidence bundle", async () => {
    const shp = "pod-happy";

    // 1. consent for the arrival's server-derived operating state (INSIDE → CA), before any GPS stamp.
    expect((await driveStep(shp, "document.attached", { ...CONSENT })).res.status).toBe(201);
    // 2. arrival cleanly INSIDE the seeded delivery fence — the geofence pillar.
    expect((await driveStep(shp, "stop.arrived", { geo: { ...INSIDE }, auto: false })).res.status).toBe(201);
    // 3. the FORCED placed-freight photo (REQ-063). Its hash is threaded into the POD, exactly as the
    //    driver flow threads photo_placed → delivered's delivery.evidenced.
    const placed = await driveStep(shp, "freight.photographed", { photo_kind: "placed" }, "photo_hash");
    expect(placed.res.status).toBe(201);
    expect(placed.hash).toMatch(HEX64_RE);
    // 4. the receiver's signature on glass — the pod.signed pillar (signature_hash hashed at capture).
    const signed = await driveStep(shp, "pod.signed", { geo: { ...INSIDE } }, "signature_hash");
    expect(signed.res.status).toBe(201);
    expect(signed.hash).toMatch(HEX64_RE);
    // 5. THE POD — delivery.evidenced referencing the threaded placed hash + the arrival geo. The gate
    //    PASSES because geofence + pod.signed + placed photo are ALL on the stream (assertDelivery).
    const pod = await driveStep(shp, "delivery.evidenced", { placed_photo_hash: placed.hash, geo: { ...INSIDE } });
    expect(pod.res.status, JSON.stringify(pod.res.json)).toBe(201);

    // The stream is EXACTLY the five gate-valid events, in order — an out-of-order / extra / duplicate
    // or dropped emit fails here in one line.
    const events = await streamEvents(shp);
    expect(events.map((e) => e.kind)).toEqual([
      "document.attached",
      "stop.arrived",
      "freight.photographed",
      "pod.signed",
      "delivery.evidenced",
    ]);

    // The POD LANDED and is QUERYABLE on the stream, carrying its full evidence bundle. The geo is the
    // WHOLE point of the POD — WHERE it was left — so assert the exact in-fence coordinate, not merely
    // that a geo is present (a zeroed/default/wrong geo must fail).
    const podEvent = events.find((e) => e.kind === "delivery.evidenced");
    expect(podEvent, "the POD must be queryable on the completed delivery stream").toBeDefined();
    const podPayload = podEvent!.payload as { placed_photo_hash?: string; geo?: unknown };
    expect(podPayload.placed_photo_hash).toBe(placed.hash);
    expect(podPayload.placed_photo_hash).toMatch(HEX64_RE); // 64-hex content hash of the placed photo
    expect(podPayload.geo).toEqual(INSIDE); // exact in-fence coordinate — where it was left

    // The pod.signed carries the signature hash (64-hex) + the exact signing geo.
    const sigEvent = events.find((e) => e.kind === "pod.signed");
    const sigPayload = sigEvent!.payload as { signature_hash?: string; geo?: unknown };
    expect(sigPayload.signature_hash).toBe(signed.hash);
    expect(sigPayload.signature_hash).toMatch(HEX64_RE);
    expect(sigPayload.geo).toEqual(INSIDE);

    // The chain verifies over the completed delivery stream (dense seq, every prev_hash/hash link holds).
    expect((await verifyChain(events)).ok).toBe(true);

    // WP-06 BOUNDARY (explicit): the POD fired, but NO money + NO email here. money.ts projects a line
    // ONLY on invoice.issued; delivery.evidenced is a projection no-op. The Biller (WP-06) is what turns
    // this POD into invoice.issued + the <5s consignee evidence email — not WP-05.
    expect(await moneyLineCount(shp)).toBe(0);
    expect(events.some((e) => e.kind === "invoice.issued")).toBe(false);
  });

  it("CONTROL — geofence: the SAME sequence but the arrival is OUTSIDE the fence → POD GATE_BLOCKED ['geofence'], POD does NOT land", async () => {
    const shp = "pod-outside";

    expect((await driveStep(shp, "document.attached", { ...CONSENT })).res.status).toBe(201);
    // OUTSIDE also derives to CA, so the consent covers the stamp — the arrival itself APPENDS; it just
    // does not sit inside the fence, which is what the delivery gate later checks.
    expect((await driveStep(shp, "stop.arrived", { geo: { ...OUTSIDE }, auto: false })).res.status).toBe(201);
    const placed = await driveStep(shp, "freight.photographed", { photo_kind: "placed" }, "photo_hash");
    expect(placed.res.status).toBe(201);
    expect((await driveStep(shp, "pod.signed", { geo: { ...OUTSIDE } }, "signature_hash")).res.status).toBe(201);

    const before = await streamCount(shp);
    const pod = await driveStep(shp, "delivery.evidenced", { placed_photo_hash: placed.hash, geo: { ...OUTSIDE } });
    expect(pod.res.status).toBe(403);
    expect(pod.res.json?.code).toBe("GATE_BLOCKED");
    expect(requiredEvidence(pod.res)).toEqual(["geofence"]); // pod + placed present; ONLY the fence fails
    expect(await streamCount(shp), "a blocked POD never half-writes").toBe(before);
    expect((await streamEvents(shp)).some((e) => e.kind === "delivery.evidenced")).toBe(false); // POD absent
  });

  it("CONTROL — signature: omit the pod.signed → POD GATE_BLOCKED ['pod.signed'], POD does NOT land", async () => {
    const shp = "pod-nosig";

    expect((await driveStep(shp, "document.attached", { ...CONSENT })).res.status).toBe(201);
    expect((await driveStep(shp, "stop.arrived", { geo: { ...INSIDE }, auto: false })).res.status).toBe(201);
    const placed = await driveStep(shp, "freight.photographed", { photo_kind: "placed" }, "photo_hash");
    expect(placed.res.status).toBe(201);
    // (no pod.signed — the receiver never signed)

    const before = await streamCount(shp);
    const pod = await driveStep(shp, "delivery.evidenced", { placed_photo_hash: placed.hash, geo: { ...INSIDE } });
    expect(pod.res.status).toBe(403);
    expect(pod.res.json?.code).toBe("GATE_BLOCKED");
    expect(requiredEvidence(pod.res)).toEqual(["pod.signed"]); // geofence + placed present; ONLY the signature fails
    expect(await streamCount(shp)).toBe(before);
    expect((await streamEvents(shp)).some((e) => e.kind === "delivery.evidenced")).toBe(false);
  });

  it("CONTROL — placed photo: it is DOUBLY load-bearing — a required POD field (schema) AND a gate pillar", async () => {
    // WHY this control is split from the two above: `DeliveryEvidencedPayload` mandates
    // `placed_photo_hash: Hash64` (strict). So the forced photo is enforced FIRST by the SCHEMA — a POD
    // literally cannot be constructed without it — which means a schema-VALID delivery.evidenced always
    // carries the hash, and the gate's ['placed_freight_photo'] token is reachable only when NEITHER the
    // incoming hash NOR a prior freight.photographed{placed} exists. We prove BOTH layers.

    // (a) SCHEMA layer: a delivery.evidenced with NO placed_photo_hash cannot even be CAPTURED —
    //     EventInput.parse throws in driver-core `capture`, before anything is signed or posted. The
    //     forced photo is a required field of the POD, the strongest possible "load-bearing".
    await expect(
      capture({ shipment_id: "pod-nophoto", kind: "delivery.evidenced", payload: { geo: { ...INSIDE } }, ts: clock++ }, deviceCtx),
    ).rejects.toThrow();

    // (b) GATE layer: the EXACT pure gate the sequencer invokes (assertDelivery). Given a clean prior
    //     stream (arrival INSIDE the fence + a pod.signed — geofence and signature both satisfied) but
    //     NO placed photo anywhere (incoming has none, no prior freight.photographed{placed}), the gate
    //     blocks with exactly ['placed_freight_photo']. This is the token the driver PWA renders.
    const priorClean = [
      { kind: "stop.arrived", payload: { geo: { ...INSIDE }, auto: false } },
      { kind: "pod.signed", payload: { signature_hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", geo: { ...INSIDE } } },
    ] as unknown as LedgerEvent[];
    const incomingNoPhoto = { kind: "delivery.evidenced", payload: { geo: { ...INSIDE } } } as unknown as LedgerEvent;

    let thrown: unknown;
    try {
      assertDelivery(priorClean, incomingNoPhoto, { fence: FENCE });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(GateError);
    expect((thrown as GateError).required_evidence).toEqual([REQUIRED_EVIDENCE.placed_freight_photo]);

    // And the positive side of the SAME gate: once a prior freight.photographed{placed} IS on the stream,
    // the placed-photo pillar is satisfied via the prior path — the gate passes (no throw). This is the
    // gate-level mirror of the driver flow's forced photo_placed step feeding the terminal.
    const priorWithPhoto = [
      ...priorClean,
      { kind: "freight.photographed", payload: { photo_kind: "placed" } } as unknown as LedgerEvent,
    ];
    expect(() => assertDelivery(priorWithPhoto, incomingNoPhoto, { fence: FENCE })).not.toThrow();
  });
});
