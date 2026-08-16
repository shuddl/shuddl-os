import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { hashEvent } from "@shuddl/ledger/chain";
import { rowToEvent } from "@shuddl/ledger/lens";
import { DISPATCH_REQUIRED_DOC_KIND } from "@shuddl/ledger/gates/transition-gates";
import {
  TENANT_SLUG,
  ensureSchema,
  post,
  requiredEvidence,
  seedLeg,
  seedShipment,
  streamCount as countEvents,
  token,
} from "./helpers.js";

// REQ-043 (WP-08 T7) — THE DISPATCH GATE over the REAL API path (POST /v1/shipments/:id/events →
// sequencer DO → Gatekeeper). REQ-030: enforced SERVER-SIDE in the ledger, unbypassable by any client.
// dispatch.assigned (sending a driver to a booked shipment) is BLOCKED until the shipment has BOTH (a) a
// claimed APPOINTMENT and (b) the required DOCS. Both facts are SERVER-SOURCED from THIS tenant's D1
// read-models — legs.appt_slot_key (set by T5's appointment.set) for the appointment, and a documents row of
// the dispatch-required kind ('ratecon') for the docs — NEVER from the request body. Every block returns 403
// GATE_BLOCKED + the EXACT missing subset (deterministic order) + ZERO append. A named override (REQ-049)
// releases a missing-prereq dispatch and is permanently stamped onto the hashed event.

const TENANT = TENANT_SLUG;
const HEX64 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const opsTok = (): Promise<string> => token({ sub: "u-t7-ops", tenant: TENANT, role: "ops" });

// A valid dispatch.assigned EventInput (client-suppliable subset). Fresh uuid per call. The driver rides the
// payload; the gate ignores it — the gated facts are the server-sourced appointment + docs, never the body.
function dispatchInput(shipmentId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    shipment_id: shipmentId,
    ts: 1_720_000_000_000,
    actor: { party: "party-carrier" },
    party_refs: [],
    evidence: [],
    source: "native",
    confidence: 10_000,
    kind: "dispatch.assigned",
    payload: { driver_user_id: "u-driver" },
    ...over,
  };
}

// Claim a dock appointment on the pickup skeleton leg — the SAME read-model mutation T5's appointment.set
// projection performs (sets legs.appt_slot_key / appt_service_date). A per-shipment-unique slot_key + NULL
// facility_id keeps the partial ux_legs_slot index collision-free across this file's shared D1. This is what
// #enforceDispatch reads for hasAppointment — never the client event.
async function claimAppointment(shipmentId: string): Promise<void> {
  await env.TENANT_A_DB.prepare(
    "UPDATE legs SET appt_slot_key = ?, appt_service_date = '2026-08-03' WHERE shipment_id = ? AND kind = 'pickup'",
  )
    .bind(`slot-${shipmentId}`, shipmentId)
    .run();
}

// Seed the dispatch-required carrier paperwork: a documents row of the SHARED DISPATCH_REQUIRED_DOC_KIND
// ('ratecon', the rate-confirmation-class doc REQ-043 requires before a driver rolls). Using the ONE exported
// constant means a rename that would silently fail-close the gate forever instead fails THIS test loudly.
async function seedRatecon(shipmentId: string): Promise<void> {
  await env.TENANT_A_DB.prepare(
    "INSERT OR IGNORE INTO documents (id, shipment_id, kind, r2_key, hash) VALUES (?,?,?,?,?)",
  )
    .bind(`doc-${shipmentId}-ratecon`, shipmentId, DISPATCH_REQUIRED_DOC_KIND, `r2/${shipmentId}/ratecon`, HEX64)
    .run();
}

// A booked shipment with its pickup skeleton leg (appt_slot_key NULL) — the starting state before any
// appointment claim or doc. Mirrors what booking.created (T4/T5) leaves on a fresh stream.
async function seedBooked(shipmentId: string): Promise<void> {
  await seedShipment(shipmentId);
  await seedLeg(shipmentId, 0, "pickup", null);
}

async function rawRows(shipmentId: string): Promise<Record<string, string | number | null>[]> {
  const res = await env.TENANT_A_DB.prepare("SELECT * FROM events WHERE stream_id = ? ORDER BY seq").bind(`s:${shipmentId}`).all();
  return res.results as Record<string, string | number | null>[];
}

beforeAll(async () => {
  await ensureSchema(env);
});

// ─── (a) booked, NO appointment (skeleton legs, appt_slot_key NULL) + NO doc → 403 both, ZERO append ──
describe("dispatch gate blocks a bare booked shipment (REQ-043)", () => {
  it("no appointment + no doc → 403 GATE_BLOCKED ['appointment','docs'], ZERO append", async () => {
    const shp = "t7-bare";
    await seedBooked(shp);
    const before = await countEvents(shp);
    const r = await post(shp, dispatchInput(shp), await opsTok());
    expect(r.status).toBe(403);
    expect(r.json?.code).toBe("GATE_BLOCKED");
    expect(requiredEvidence(r)).toEqual(["appointment", "docs"]); // deterministic order
    expect(await countEvents(shp)).toBe(before); // a block NEVER appends
  });
});

// ─── (b) appointment claimed, NO doc → 403 ['docs'] ───────────────────────────────────────────────────
describe("dispatch gate blocks when only the appointment is present (REQ-043)", () => {
  it("appointment claimed but no rate-con → 403 GATE_BLOCKED ['docs'], ZERO append", async () => {
    const shp = "t7-appt-only";
    await seedBooked(shp);
    await claimAppointment(shp); // legs.appt_slot_key set — the server-sourced appointment fact
    const before = await countEvents(shp);
    const r = await post(shp, dispatchInput(shp), await opsTok());
    expect(r.status).toBe(403);
    expect(requiredEvidence(r)).toEqual(["docs"]);
    expect(await countEvents(shp)).toBe(before);
  });
});

// ─── (c) doc present, NO appointment → 403 ['appointment'] ────────────────────────────────────────────
describe("dispatch gate blocks when only the docs are present (REQ-043)", () => {
  it("rate-con on file but no appointment → 403 GATE_BLOCKED ['appointment'], ZERO append", async () => {
    const shp = "t7-doc-only";
    await seedBooked(shp);
    await seedRatecon(shp); // a documents row of kind 'ratecon' — the server-sourced docs fact
    const before = await countEvents(shp);
    const r = await post(shp, dispatchInput(shp), await opsTok());
    expect(r.status).toBe(403);
    expect(requiredEvidence(r)).toEqual(["appointment"]);
    expect(await countEvents(shp)).toBe(before);
  });
});

// ─── (d) BOTH present → 201 ───────────────────────────────────────────────────────────────────────────
describe("dispatch gate passes once both appointment + docs are present (REQ-043)", () => {
  it("appointment claimed AND rate-con on file → 201, appends once", async () => {
    const shp = "t7-both";
    await seedBooked(shp);
    await claimAppointment(shp);
    await seedRatecon(shp);
    const r = await post(shp, dispatchInput(shp), await opsTok());
    expect(r.status).toBe(201);
    expect(await countEvents(shp)).toBe(1);
  });

  it("a different kind of doc (BOL, not ratecon) does NOT satisfy the dispatch-required docs → 403 ['docs']", async () => {
    // Grounds hasDocs in the CONCRETE 'ratecon' kind: a BOL on the stream is not the rate-con-class paperwork
    // REQ-043 requires before a driver rolls, so the gate still fails closed on the docs pillar.
    const shp = "t7-wrong-doc";
    await seedBooked(shp);
    await claimAppointment(shp);
    await env.TENANT_A_DB.prepare("INSERT OR IGNORE INTO documents (id, shipment_id, kind, r2_key, hash) VALUES (?,?,?,?,?)")
      .bind(`doc-${shp}-bol`, shp, "BOL", `r2/${shp}/bol`, HEX64)
      .run();
    const r = await post(shp, dispatchInput(shp), await opsTok());
    expect(r.status).toBe(403);
    expect(requiredEvidence(r)).toEqual(["docs"]);
    expect(await countEvents(shp)).toBe(0);
  });

  it("§1674 a RETENTION-TOMBSTONED rate-con does NOT satisfy the docs pillar — deleted evidence is not evidence", async () => {
    // `ratecon` is a 'default'-class doc (1yr), so the retention sweep deletes its R2 bytes and marks the row
    // 'expired'. The row SURVIVES on purpose (an audit record that the doc existed) — which is exactly why a
    // gate that asks "does a row exist" gets the wrong answer. REQ-043's requirement is that the paperwork
    // EXISTS before a driver rolls; a tombstone says it deliberately does not.
    const shp = "t7-expired-doc";
    await seedBooked(shp);
    await claimAppointment(shp);
    await seedRatecon(shp);
    await env.TENANT_A_DB.prepare("UPDATE documents SET retention_status = 'expired' WHERE shipment_id = ? AND kind = ?")
      .bind(shp, DISPATCH_REQUIRED_DOC_KIND)
      .run();

    const r = await post(shp, dispatchInput(shp), await opsTok());
    expect(r.status, "a tombstoned rate-con must leave the docs pillar unsatisfied").toBe(403);
    expect(requiredEvidence(r)).toEqual(["docs"]);
    expect(await countEvents(shp), "and the refusal appends nothing").toBe(0);

    // The row is still there — the gate refused on its STATUS, not on its absence (or this proves nothing).
    const still = await env.TENANT_A_DB.prepare("SELECT retention_status FROM documents WHERE shipment_id = ? AND kind = ?")
      .bind(shp, DISPATCH_REQUIRED_DOC_KIND)
      .first<{ retention_status: string }>();
    expect(still?.retention_status, "control: the tombstoned row exists and is what the gate read").toBe("expired");
  });
});

// ─── (e) a NAMED override releases a missing-prereq dispatch AND is permanently stamped on the event ──
describe("named override releases the dispatch gate (REQ-049)", () => {
  it("an elevated-role override APPENDS a bare dispatch; override.by is STAMPED to the authenticated author", async () => {
    const shp = "t7-override";
    await seedBooked(shp); // NO appointment, NO doc — both prerequisites missing
    // The client CLAIMS a `by`; the route OVERRIDES it with the authenticated session identity (u-t7-ops),
    // keeping only the client's `reason` — an accountability record that can't be forged.
    const clientClaim = { by: "not-the-author", reason: "rate-con faxed; appt confirmed by phone — dispatching now" };
    const r = await post(shp, dispatchInput(shp, { override: clientClaim }), await opsTok());
    expect(r.status).toBe(201);
    const stamped = { by: "u-t7-ops", reason: clientClaim.reason };
    expect(r.json?.override).toEqual(stamped);

    // Permanently visible on the STORED, hashed event (REQ-049): the override rides the chained, hashed bytes.
    const rows = await rawRows(shp);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(JSON.parse(String(row.override_json))).toEqual(stamped);
    expect(await hashEvent(rowToEvent(row))).toBe(row.hash); // the override is INSIDE the verified hash
  });

  it("a DRIVER-token override is 403 FORBIDDEN with ZERO append — an override needs an elevated role", async () => {
    const shp = "t7-override-driver";
    await seedBooked(shp);
    const before = await countEvents(shp);
    const driverTok = await token({ sub: "u-t7-driver", tenant: TENANT, role: "driver" });
    const r = await post(shp, dispatchInput(shp, { override: { by: "x", reason: "trust me" } }), driverTok);
    expect(r.status).toBe(403);
    expect(await countEvents(shp)).toBe(before);
  });

  it("a malformed (blank) override is a clean 400 VALIDATION_FAILED, not a silent pass", async () => {
    const shp = "t7-override-bad";
    await seedBooked(shp);
    const before = await countEvents(shp);
    const r = await post(shp, dispatchInput(shp, { override: { by: "  ", reason: "" } }), await opsTok());
    expect(r.status).toBe(400);
    expect(r.json?.code).toBe("VALIDATION_FAILED");
    expect(await countEvents(shp)).toBe(before);
  });
});
