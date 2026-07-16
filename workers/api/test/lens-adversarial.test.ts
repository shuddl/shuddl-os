import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { EVENT_KINDS, type EventKind } from "@shuddl/contracts";
import { KIND_VISIBILITY_DEFAULTS } from "@shuddl/ledger/visibility";
import { DRIVER_KINDS } from "@shuddl/ledger/lens";
import { canonicalBytes, sha256Hex } from "@shuddl/ledger/canonical";
import { ensureSchema, token, TENANT_SLUG } from "./helpers.js";

// REQ-015 / I6 — THE ADVERSARIAL LENS SUITE (WP-02 DoD: "lens tests prove scoping").
//
// Every case seeds through the REAL append path (POST /v1/shipments/:id/events) — direct DB inserts
// would prove nothing about the routes — and then asserts on the RAW serialized response body a client
// would receive. The lens is derived from the JWT claim ONLY; a forged party_id/tenant on the wire is
// never consulted. Sibling to the WP-01 tenant-isolation suite (REQ-025), which case 10 extends here.

// The cast: one tenant, shipper P1, consignee P2, cartage P3, drivers D1/D2. Ids are prefixed `adv-`
// and are unique to this file — the harness shares ONE D1 across files (isolatedStorage:false), so we
// scope every stream/party/shipment id to ourselves and never assume an empty table.
const P1 = "adv-p1-shipper";
const P2 = "adv-p2-consignee";
const P3 = "adv-p3-cartage";
const D1 = "adv-d1";
const D2 = "adv-d2";

const SHP_A = "adv-shp-a"; // comprehensive: one event of every route-appendable kind; assigned D1
const SHP_B = "adv-shp-b"; // P2-only; assigned D2
const SHP_GEO = "adv-shp-geo"; // geo-privacy case; P1+P2; OFD flipped mid-test
const FIRE_1 = "adv-fire-1"; // firehose keyset streams
const FIRE_2 = "adv-fire-2";

const HEX64 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const GEO = { lat_e6: 37_421_000, lon_e6: -122_084_000, accuracy_m: 5 };

// WP-08 T5 — a permissive facility for the SHP_A appointment.set seed (see payloadFor). UTC + open-all-day +
// a single DAILY slot at 08:00 (minute 480) + same-day allowed, no lead/horizon: the fixed 08:00-UTC window
// aligns to the slot and clears every rule regardless of when the suite runs.
const ADV_FACILITY_ID = "adv-fac";
const ADV_SLOT_KEY = "adv-slot";
const ADV_APPT_WINDOW_START = Date.UTC(2025, 0, 1, 8, 0, 0); // 08:00:00 UTC → local minute-of-day 480 in UTC

// ---- tokens (claim-only lens; never a header/param) --------------------------------------
const opsTok = (): Promise<string> => token({ sub: "adv-ops", tenant: TENANT_SLUG, role: "ops" });
const portalTok = (partyId: string): Promise<string> =>
  token({ sub: `${partyId}-user`, tenant: TENANT_SLUG, role: "portal", party_id: partyId });
const driverTok = (driver: string): Promise<string> => token({ sub: driver, tenant: TENANT_SLUG, role: "driver" });

// ---- per-kind minimal-valid payloads / actor overrides -----------------------------------
function payloadFor(kind: EventKind): Record<string, unknown> {
  switch (kind) {
    case "booking.created":
      return { quote_event_id: "evt-quote-1", division: "main", shipper_party_id: P1, consignee_party_id: P2, bill_to_party_id: P2 };
    case "quote.priced":
      // REQ-003/031: lines are required and must sum to sell (90_000 + 30_000 = 120_000).
      return { sell: 120_000, lines: [{ kind: "freight", code: "freight", amount_cents: 90_000 }, { kind: "fsc", code: "fsc", amount_cents: 30_000 }], floors: { contribution: 60_000, full: 90_000, target: 100_000 }, versions: { rate_config_ids: ["rc-1"] }, basis: {} };
    case "pod.signed":
      return { signature_hash: HEX64, geo: { ...GEO }, unwitnessed: true };
    case "custody.transferred":
      return { from_party: P1, to_party: P3, geo: { ...GEO }, unwitnessed: true };
    case "agent.acted":
      return { agent: "biller", action: "draft", basis: [{ kind: "event", id: "e-1" }], confidence_bps: 9_000 };
    case "invoice.issued":
      return { invoice_id: `inv-${SHP_A}`, party_id: P2, division: "main", lines: [{ line_no: 1, kind: "freight", amount_cents: 120_000, gl_map: "4000-REV" }] };
    case "split.computed":
      return { total_cents: 120_000, allocations: [{ party_id: P3, share_bps: 3_000 }, { party_id: P1, share_bps: 7_000 }] };
    case "stop.arrived":
    case "stop.departed":
      return { geo: { ...GEO }, auto: true };
    case "freight.counted":
      return { pieces: 12 };
    case "freight.photographed":
      return { photo_hash: HEX64, photo_kind: "freight" };
    case "dims.captured":
      return { l_in: 48, w_in: 40, h_in: 60, pieces: 4, method: "camera" };
    case "seal.applied":
      return { seal_id: "seal-1", photo_hash: HEX64 };
    case "osd.captured":
      return { photo_hash: HEX64, reason_code: "damage" };
    case "exception.raised":
      // REQ-050 exception gate: a raised exception needs a photo + reason_code on its (loose) payload.
      return { photo_hash: HEX64, reason_code: "damage", note: "adv fixture" };
    case "delivery.evidenced":
      return { placed_photo_hash: HEX64, geo: { ...GEO } };
    // WP-07: the comms/quote-lifecycle kinds now carry typed payloads (were loose {}).
    case "message.received":
      return { channel: "email", from_ref: "shipper@example.com", body_ref: "r2://msg/inbound-1" };
    case "message.sent":
      return { channel: "email", to_ref: "shipper@example.com", body_ref: "r2://msg/outbound-1" };
    case "quote.requested":
      return { request: { origin_zip: "97201", dest_zip: "98101" } };
    case "quote.sent":
      return { quote_event_id: "evt-quote-1", to_ref: "shipper@example.com", message_event_id: "evt-message-1" };
    case "quote.accepted":
      return { quote_event_id: "evt-quote-1" };
    // WP-08: the booking/scheduler kinds now carry typed payloads (were loose {}).
    case "credit.checked":
      return { party_id: P2, status: "clear" };
    case "appointment.set":
      // WP-08 T5: appointment.set is now GATED — it claims the shipment's (booking-materialized) pickup leg
      // against a real facility slot. This lens fixture only needs the event ON the stream, so it books the
      // permissive ADV_FACILITY (seeded in beforeAll): UTC, open all day, a daily slot at 08:00 (minute 480),
      // same-day allowed, no lead/horizon — so the fixed 08:00-UTC window passes the gate every run.
      return { leg_kind: "pickup", facility_id: ADV_FACILITY_ID, slot_key: ADV_SLOT_KEY, window_start_ts: ADV_APPT_WINDOW_START, window_end_ts: ADV_APPT_WINDOW_START + 3_600_000 };
    case "pickup.scheduled":
      return { facility_id: "facility-1", window_start_ts: 1_720_000_000_000, window_end_ts: 1_720_003_600_000 };
    case "dispatch.assigned":
      return { driver_user_id: D1 };
    default:
      return {};
  }
}

// actor.party for pod/custody/osd/exception MUST be a real party (passport FK); dispatch.assigned's
// actor.user is the driver the status-cache projection binds the shipment to.
function actorFor(kind: EventKind): { party: string; user?: string; device?: string } {
  if (kind === "dispatch.assigned") return { party: P1, user: D1 };
  return { party: P1 };
}

function buildInput(shipmentId: string, kind: EventKind, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    shipment_id: shipmentId,
    ts: 1_720_000_000_000,
    actor: actorFor(kind),
    party_refs: [P1, P2, P3],
    evidence: [],
    source: "native",
    confidence: 10_000,
    kind,
    payload: payloadFor(kind),
    ...over,
  };
}

// A ConsentAck document.attached payload (REQ-166) for a given operating state. The consent gate is
// NON-overridable, so every stream that appends a GPS stamp must carry one of these first. `operating_state`
// must equal the server-derived jurisdiction of the stamp — GEO (37.421,-122.084) derives to "CA".
const consentPayload = (state: string): Record<string, unknown> => ({
  doc_kind: "consent",
  policy_version: "v1",
  operating_state: state,
  acknowledged: true,
});

interface AppendResult {
  status: number;
  body: string;
  json: Record<string, unknown> | null;
}

async function append(shipmentId: string, input: Record<string, unknown>, tok: string): Promise<AppendResult> {
  const res = await SELF.fetch(`https://api.local/v1/shipments/${shipmentId}/events`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await res.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  return { status: res.status, body, json: parsed };
}

// The server-emit-only kinds (REQ-030 / REQ-003): money is a projection the SERVER emits, never a client
// fact — the public events route now REFUSES them (see the SERVER-EMITTED case below). This lens suite
// legitimately needs them ON the streams to prove READ visibility, so it seeds them the way the server
// does: THROUGH the sequencer DO stub directly (the Rater/Biller's internal seam), never the public route.
const SERVER_ONLY_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
  "invoice.issued",
  "invoice.corrected",
  "split.computed",
  "payment.received",
  "settlement.executed",
]);
type SeqStub = DurableObjectStub & { append(req: { tenant: string; streamId: string; input: unknown }): Promise<{ id: string } & Record<string, unknown>> };
async function appendInternal(shipmentId: string, input: Record<string, unknown>): Promise<AppendResult> {
  const streamId = `s:${shipmentId}`;
  const stub = env.SHIPMENT_SEQ.get(env.SHIPMENT_SEQ.idFromName(`${TENANT_SLUG}|${streamId}`)) as unknown as SeqStub;
  const event = await stub.append({ tenant: TENANT_SLUG, streamId, input }); // the DO's gates (I2, projections) still run
  return { status: 201, body: JSON.stringify(event), json: event };
}
// Seed by the server's own path for a server-only kind, else the public route (what a client would use).
function seed(shipmentId: string, input: Record<string, unknown>, kind: EventKind, tok: string): Promise<AppendResult> {
  return SERVER_ONLY_KINDS.has(kind) ? appendInternal(shipmentId, input) : append(shipmentId, input, tok);
}

interface ListResult {
  status: number;
  body: string;
  events: Array<Record<string, unknown>>;
  next_cursor: string | null;
}

async function listShipment(shipmentId: string, tok: string, query = ""): Promise<ListResult> {
  const res = await SELF.fetch(`https://api.local/v1/shipments/${shipmentId}/events${query}`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  const body = await res.text();
  const parsed = res.status === 200 ? (JSON.parse(body) as { events: Array<Record<string, unknown>>; next_cursor: string | null }) : { events: [], next_cursor: null };
  return { status: res.status, body, events: parsed.events, next_cursor: parsed.next_cursor };
}

async function listFirehose(tok: string, query = ""): Promise<ListResult> {
  const res = await SELF.fetch(`https://api.local/v1/events${query}`, { headers: { Authorization: `Bearer ${tok}` } });
  const body = await res.text();
  const parsed = res.status === 200 ? (JSON.parse(body) as { events: Array<Record<string, unknown>>; next_cursor: string | null }) : { events: [], next_cursor: null };
  return { status: res.status, body, events: parsed.events, next_cursor: parsed.next_cursor };
}

const kindsOf = (events: Array<Record<string, unknown>>): Set<string> => new Set(events.map((e) => e.kind as string));

// The route-appendable kinds: every kind except position.updated (which bypasses the sequencer and lives
// in the `positions` partition — POST /v1/positions, not the events table; the DO rejects it here).
const APPENDABLE = EVENT_KINDS.filter((k) => k !== "position.updated");

// Seeded ids captured for cross-referencing (invoice.issued -> invoice.corrected -> netting).
let invoiceIssuedId = "";
let invoiceCorrectedId = "";

beforeAll(async () => {
  await ensureSchema(env);
  const ops = await opsTok();
  // REQ-185 — credit.checked is a privileged FINANCE decision; the public route now refuses an ops POST of
  // it. Seed it with a finance principal so this fixture still exercises the real route path for that kind.
  const fin = await token({ sub: "adv-fin-seed", tenant: TENANT_SLUG, role: "finance" });

  // P1/P2/P3 must exist as parties: they are actors on passport-accruing events (FK parties(id)). P2 is the
  // bill_to on the seeded booking.created, so it carries a deliverable email so the REQ-182 booking
  // evidence-recipient gate (WP-08 T6) passes — the seed exercises the happy booking path, not the gate.
  const advContacts = JSON.stringify([{ kind: "primary", email: "adv-billto@tenant-a.test" }]);
  for (const [id, kind, contacts] of [[P1, "shipper", "[]"], [P2, "consignee", advContacts], [P3, "carrier", "[]"]] as const) {
    await env.TENANT_A_DB.prepare("INSERT OR IGNORE INTO parties (id, kind, names, contacts) VALUES (?,?,?,?)").bind(id, kind, "{}", contacts).run();
  }

  // WP-08 T5: the permissive facility SHP_A's appointment.set books against (the booking.created leg it
  // claims is materialized by the first ORDER kind). UTC, open all day, one daily 08:00 slot, no rules.
  {
    const allDay = [{ open_min: 0, close_min: 1440 }];
    const weekly: Record<string, unknown> = {};
    for (let d = 0; d < 7; d++) weekly[String(d)] = allDay;
    await env.TENANT_A_DB.prepare(
      "INSERT OR IGNORE INTO facilities (id, kind, hours, capacity_slots, appointment_rules) VALUES (?,?,?,?,?)",
    )
      .bind(
        ADV_FACILITY_ID,
        "dock",
        JSON.stringify({ tz: "UTC", weekly }),
        JSON.stringify([{ slot_key: ADV_SLOT_KEY, window_start_min: 480, window_end_min: 540 }]),
        JSON.stringify({ allow_same_day: true }),
      )
      .run();
  }

  // The delivery leg supplies the REQ-046 geofence server-side (its dest geo, matched to the stamp).
  // Real per-stop provisioning is booking's job (WP-08); the lens fixture seeds it directly.
  async function seedDeliveryLeg(shipmentId: string): Promise<void> {
    await env.TENANT_A_DB.prepare(
      "INSERT OR IGNORE INTO legs (id, shipment_id, seq, kind, executor_party_id, geo) VALUES (?,?,?,?,?,?)",
    )
      .bind(`adv-leg-del-${shipmentId}`, shipmentId, 0, "delivery", P1, JSON.stringify({ lat_e6: GEO.lat_e6, lon_e6: GEO.lon_e6 }))
      .run();
  }

  // WP-08 T7 (REQ-043): dispatch.assigned is now GATED — blocked until the shipment has a claimed appointment
  // (a leg with appt_slot_key, set by T5's appointment.set) AND the required carrier paperwork (a documents row
  // of kind 'ratecon'). This lens fixture only needs the event ON the stream, so it provisions both prereqs
  // directly against the read-models (never the client event): a slot claim on the booking-materialized pickup
  // leg + a ratecon doc. SHP_A's later appointment.set legitimately re-claims the same pickup leg (a realistic
  // post-dispatch reschedule); the manual claim uses a NULL facility + per-shipment slot key so it never
  // collides on ux_legs_slot with the real appointment.set claim.
  async function seedDispatchPrereqs(shipmentId: string): Promise<void> {
    await env.TENANT_A_DB.prepare(
      "UPDATE legs SET appt_slot_key = ?, appt_service_date = '2026-08-03' WHERE shipment_id = ? AND kind = 'pickup'",
    )
      .bind(`adv-dispatch-preclaim-${shipmentId}`, shipmentId)
      .run();
    await env.TENANT_A_DB.prepare(
      "INSERT OR IGNORE INTO documents (id, shipment_id, kind, r2_key, hash) VALUES (?,?,?,?,?)",
    )
      .bind(`adv-doc-ratecon-${shipmentId}`, shipmentId, "ratecon", `r2/${shipmentId}/ratecon`, HEX64)
      .run();
  }

  // ---- Shipment A: one of every route-appendable kind, in dependency order ----
  // booking.created first (creates the shipments row); dispatch.assigned binds D1; pod.signed before
  // invoice.issued (I2 gate); invoice.corrected references the issued event id.
  const ORDER: EventKind[] = [
    "booking.created", "dispatch.assigned",
    "quote.requested", "quote.priced", "quote.sent", "quote.accepted", "quote.expired",
    "credit.checked", "appointment.set", "pickup.scheduled",
    "stop.arrived", "freight.counted", "freight.photographed", "dims.captured",
    "custody.transferred", "seal.applied", "stop.departed",
    "exception.raised", "osd.captured", "pod.signed", "delivery.evidenced",
    "invoice.issued", "payment.received", "settlement.executed", "split.computed",
    "message.received", "message.sent", "call.transcribed",
    "document.attached", "approval.requested", "approval.decided", "agent.acted", "authority.flipped",
  ];
  // The WP-05 Gatekeeper gates are enforced SERVER-SIDE on this real append path, so the fixture must
  // now carry the evidence each gated transition needs: a ConsentAck before the first GPS stamp
  // (REQ-166, NON-overridable), and a delivery leg so the delivery geofence (REQ-046) resolves — its
  // dest geo IS the stop.arrived coords, so the seeded arrival clears the fence. The pickup-depart gate
  // (REQ-044) clears on its own because count/photo/custody precede stop.departed in ORDER.
  for (const kind of ORDER) {
    if (kind === "dispatch.assigned") await seedDispatchPrereqs(SHP_A); // REQ-043: appt + ratecon before dispatch
    if (kind === "stop.arrived") {
      const c = await append(SHP_A, buildInput(SHP_A, "document.attached", { payload: consentPayload("CA") }), ops);
      if (c.status !== 201) throw new Error(`seed ${SHP_A}/consent failed: ${c.status} ${c.body}`);
    }
    if (kind === "delivery.evidenced") {
      await seedDeliveryLeg(SHP_A);
      // REQ-046 (WP-05 exit audit): the delivery gate binds the POD's placed_photo_hash to a prior
      // freight.photographed{placed}. Seed that placed photo (photo_hash === the POD's HEX64) first.
      const p = await append(SHP_A, buildInput(SHP_A, "freight.photographed", { payload: { photo_hash: HEX64, photo_kind: "placed" } }), ops);
      if (p.status !== 201) throw new Error(`seed ${SHP_A}/placed-photo failed: ${p.status} ${p.body}`);
    }
    // credit.checked is finance-only at the route (REQ-185); every other kind seeds as ops.
    const r = await seed(SHP_A, buildInput(SHP_A, kind), kind, kind === "credit.checked" ? fin : ops);
    if (r.status !== 201) throw new Error(`seed ${SHP_A}/${kind} failed: ${r.status} ${r.body}`);
    if (kind === "invoice.issued") invoiceIssuedId = r.json!.id as string;
  }
  // invoice.corrected — a void (full reversal) so the money nets to zero (case 8). A server-only kind:
  // seeded through the DO stub (the public route now refuses it — REQ-030), the I7 gate still runs.
  {
    const r = await appendInternal(
      SHP_A,
      buildInput(SHP_A, "invoice.corrected", {
        payload: { invoice_id: `inv-${SHP_A}`, corrects_event_id: invoiceIssuedId, reason: "reweigh correction", reissue_lines: [] },
      }),
    );
    if (r.status !== 201) throw new Error(`seed ${SHP_A}/invoice.corrected failed: ${r.status} ${r.body}`);
    invoiceCorrectedId = r.json!.id as string;
  }
  // sanity: A appended every appendable kind
  expect(new Set(APPENDABLE).size).toBe(ORDER.length + 1); // +1 for invoice.corrected

  // ---- Shipment B: P2-only, assigned D2 ----
  await append(SHP_B, buildInput(SHP_B, "booking.created", { party_refs: [P2] }), ops).then((r) => {
    if (r.status !== 201) throw new Error(`seed ${SHP_B}/booking failed: ${r.body}`);
  });
  await seedDispatchPrereqs(SHP_B); // REQ-043: appt + ratecon before SHP_B's dispatch.assigned
  await append(SHP_B, buildInput(SHP_B, "dispatch.assigned", { party_refs: [P2], actor: { party: P2, user: D2 } }), ops);
  // Consent-before-GPS (REQ-166) for SHP_B's stamp too; party_refs P2-only so case 3 (P1 sees nothing) holds.
  await append(SHP_B, buildInput(SHP_B, "document.attached", { party_refs: [P2], payload: consentPayload("CA") }), ops);
  await append(SHP_B, buildInput(SHP_B, "stop.arrived", { party_refs: [P2] }), ops);
  await append(SHP_B, buildInput(SHP_B, "custody.transferred", { party_refs: [P2], actor: { party: P2 }, payload: { from_party: P2, to_party: P3, geo: { ...GEO }, unwitnessed: true } }), ops);

  // ---- Shipment GEO: P1+P2, geo-bearing kinds; OFD flipped mid-test in case 5 ----
  await append(SHP_GEO, buildInput(SHP_GEO, "booking.created", { party_refs: [P1, P2] }), ops);
  await append(SHP_GEO, buildInput(SHP_GEO, "custody.transferred", { party_refs: [P1, P2] }), ops);
  await append(SHP_GEO, buildInput(SHP_GEO, "pod.signed", { party_refs: [P1, P2] }), ops);

  // ---- Firehose keyset streams: two streams with overlapping seq ranges (0,1,2 each) ----
  for (const shp of [FIRE_1, FIRE_2]) {
    for (let i = 0; i < 3; i++) await append(shp, buildInput(shp, "quote.requested"), ops);
  }
});

// 1 — a portal party never sees internal-visibility kinds on a shipment it IS party to.
describe("case 1: portal P1 sees zero internal kinds", () => {
  it("no approval.*, agent.acted, split.computed, credit.checked, call.transcribed in the raw body", async () => {
    const res = await listShipment(SHP_A, await portalTok(P1));
    expect(res.status).toBe(200);
    for (const hidden of ["approval.requested", "approval.decided", "agent.acted", "split.computed", "credit.checked", "call.transcribed"]) {
      expect(res.body).not.toContain(hidden);
    }
    // positive control: P1 DOES see a counterparty kind on the same shipment
    expect(res.body).toContain("pod.signed");
  });
});

// 2 — quote internals are redacted for a party lens: sell stays, floors/basis/versions vanish.
describe("case 2: P1 reads quote.priced with margins stripped", () => {
  it("payload.sell present; 'floors' / 'basis' / 'versions' appear NOWHERE in the body", async () => {
    const res = await listShipment(SHP_A, await portalTok(P1));
    const priced = res.events.find((e) => e.kind === "quote.priced");
    expect(priced).toBeDefined();
    expect((priced!.payload as Record<string, unknown>).sell).toBe(120_000);
    for (const s of ["floors", "basis", "versions"]) expect(res.body).not.toContain(s);
  });
});

// 3 — a party lens can't cross to another party's shipment; a forged ?party_id is ignored (claim wins).
describe("case 3: P1 on a P2-only shipment is empty; forged party_id is ignored", () => {
  it("empty, and identical with a forged ?party_id=P2 on the query string", async () => {
    const tok = await portalTok(P1);
    const clean = await listShipment(SHP_B, tok);
    const forged = await listShipment(SHP_B, tok, `?party_id=${P2}`);
    expect(clean.status).toBe(200);
    expect(clean.events).toEqual([]);
    expect(forged.status).toBe(200);
    expect(forged.events).toEqual([]); // the claim wins — the query param never widens the lens
    expect(forged.body).toBe(clean.body);
  });
});

// 4 — driver lens: another driver's shipment is invisible; even on its OWN shipment a non-driver kind
// (invoice.issued) is excluded by the allowlist.
describe("case 4: driver D1 scoping", () => {
  it("D1 on D2's shipment is empty", async () => {
    const res = await listShipment(SHP_B, await driverTok(D1));
    expect(res.status).toBe(200);
    expect(res.events).toEqual([]);
  });
  it("D1 on its own shipment sees driver kinds but never invoice.issued", async () => {
    const res = await listShipment(SHP_A, await driverTok(D1));
    expect(res.status).toBe(200);
    expect(res.body).not.toContain("invoice.issued");
    expect(res.body).not.toContain("invoice.corrected");
    expect(kindsOf(res.events).has("pod.signed")).toBe(true); // a driver kind IS present
  });
});

// 5 — geo privacy is structural (not just position.updated): a consignee gets coarse coords with no
// accuracy pre-OFD, exact coords once out-for-delivery. Tested on custody.transferred AND pod.signed.
describe("case 5: consignee P2 geo coarsens pre-OFD, unlocks post-OFD", () => {
  it("coarse (lat_e6 % 100000 === 0, no accuracy_m) before OFD; exact after the flag flips", async () => {
    const p2 = await portalTok(P2);
    const pre = await listShipment(SHP_GEO, p2);
    const geoOf = (evs: Array<Record<string, unknown>>, kind: string): Record<string, unknown> =>
      (evs.find((e) => e.kind === kind)!.payload as { geo: Record<string, unknown> }).geo;

    for (const kind of ["custody.transferred", "pod.signed"]) {
      const g = geoOf(pre.events, kind);
      // `=== 0` (not toBe/Object.is): a negative multiple's modulo is -0, still a clean multiple.
      expect((g.lat_e6 as number) % 100_000 === 0).toBe(true);
      expect((g.lon_e6 as number) % 100_000 === 0).toBe(true);
      expect(g.lat_e6).not.toBe(GEO.lat_e6); // and it is actually coarsened, not the exact value
      expect(g.accuracy_m).toBeUndefined();
    }

    // Flip out-for-delivery (driver PWA gesture in prod; ops append here) and re-read. SHP_GEO never got
    // the pickup evidence, so this depart is released with a named REQ-049 override (the fixture is
    // exercising the OFD projection, not the pickup gate).
    const flip = await append(
      SHP_GEO,
      buildInput(SHP_GEO, "stop.departed", {
        party_refs: [P1, P2],
        override: { by: "adv-ops", reason: "OFD flip fixture" },
        payload: { geo: { ...GEO }, auto: false, out_for_delivery: true },
      }),
      await opsTok(),
    );
    expect(flip.status).toBe(201);

    const post = await listShipment(SHP_GEO, p2);
    for (const kind of ["custody.transferred", "pod.signed"]) {
      const g = geoOf(post.events, kind);
      expect(g.lat_e6).toBe(GEO.lat_e6); // exact now
      expect(g.lon_e6).toBe(GEO.lon_e6);
      expect(g.accuracy_m).toBe(GEO.accuracy_m);
    }
  });
});

// 6 — requested_visibility can only NARROW: a widening request is dropped, the event stays internal.
describe("case 6: requested_visibility 'counterparty' on an internal kind is ignored", () => {
  it("approval.requested stays internal (the POST response body proves the stored visibility)", async () => {
    const r = await append(SHP_A, buildInput(SHP_A, "approval.requested", { requested_visibility: "counterparty" }), await opsTok());
    expect(r.status).toBe(201);
    expect(r.json!.visibility).toBe("internal"); // counterparty is WIDER than internal -> not applied
    // and it never surfaces to P1
    const p1 = await listShipment(SHP_A, await portalTok(P1));
    expect(p1.events.some((e) => e.id === r.json!.id)).toBe(false);
  });
});

// 7 — a custody.transferred naming two parties is seen once by each — no duplication, no leak.
describe("case 7: custody.transferred with P1 and P3 in party_refs", () => {
  it("P1 sees it exactly once; P3 sees it exactly once", async () => {
    for (const party of [P1, P3]) {
      const res = await listShipment(SHP_A, await portalTok(party));
      const custody = res.events.filter((e) => e.kind === "custody.transferred");
      expect(custody).toHaveLength(1);
    }
  });
});

// 8 — a correction pair is both visible under a party lens AND nets to zero (I7 inside a lens).
describe("case 8: correction pair visible to P1, money nets to zero", () => {
  it("both legs in P1's body; money_lines for the pair sum to zero", async () => {
    const res = await listShipment(SHP_A, await portalTok(P1));
    expect(res.events.some((e) => e.id === invoiceIssuedId)).toBe(true);
    expect(res.events.some((e) => e.id === invoiceCorrectedId)).toBe(true);
    const row = await env.TENANT_A_DB.prepare(
      "SELECT COALESCE(SUM(amount_cents),0) AS total FROM money_lines WHERE event_id IN (?, ?)",
    )
      .bind(invoiceIssuedId, invoiceCorrectedId)
      .first<{ total: number }>();
    expect(row!.total).toBe(0);
  });
});

// 8b — REQ-179 (pulled forward from WP-11): the portal is the FIRST counterparty surface to read an
// invoice.issued event. The counterparty (party) lens must see NO margin/GL internals — `division`
// (top-level) and every `lines[].gl_map` (nested inside the lines array) — while KEEPING the sell/totals/
// line amounts it legitimately owes. The tenant (ops) lens still sees everything (redaction is per-lens).
describe("case 8b: invoice.issued margin/GL internals stripped for a counterparty lens (REQ-179)", () => {
  it("P1 (party) sees NO division and NO lines[].gl_map; amounts stay — ops sees both", async () => {
    const party = await listShipment(SHP_A, await portalTok(P1));
    const tenant = await listShipment(SHP_A, await opsTok());

    const pInv = party.events.find((e) => e.id === invoiceIssuedId);
    const tInv = tenant.events.find((e) => e.id === invoiceIssuedId);
    expect(pInv, "P1 must see the invoice.issued event").toBeDefined();
    expect(tInv, "ops must see the invoice.issued event").toBeDefined();

    // party lens: the internals are gone at every depth.
    const pPayload = pInv!.payload as { division?: unknown; lines: Array<Record<string, unknown>> };
    expect(pPayload.division).toBeUndefined();
    expect(pPayload.lines.length).toBeGreaterThan(0);
    for (const l of pPayload.lines) expect("gl_map" in l).toBe(false);
    // ...but the sell/totals/line amounts a counterparty owes are KEPT.
    expect(pPayload.lines[0]!.amount_cents).toBe(120_000);
    expect(pPayload.lines[0]!.kind).toBe("freight");
    // the gl_map VALUE never appears ANYWHERE in P1's raw body (the chart of accounts never ships).
    expect(party.body).not.toContain("4000-REV");

    // tenant lens: the SAME event carries the internals, unredacted (redaction is per-lens).
    const tPayload = tInv!.payload as { division?: unknown; lines: Array<Record<string, unknown>> };
    expect(tPayload.division).toBe("main");
    expect(tPayload.lines[0]!.gl_map).toBe("4000-REV");
  });
});

// 9 — THE I6 SWEEP: every route-appendable kind × {tenant, party, driver} lens, asserted against the
// REAL exported maps (KIND_VISIBILITY_DEFAULTS + DRIVER_KINDS). Internal kinds never reach party/driver.
describe("case 9: table-driven I6 visibility sweep on shipment A", () => {
  it("each lens sees exactly the kinds its scope permits", async () => {
    const driverAllow = new Set<string>(DRIVER_KINDS);
    const tenant = kindsOf((await listShipment(SHP_A, await opsTok())).events);
    const party = kindsOf((await listShipment(SHP_A, await portalTok(P1))).events);
    const driver = kindsOf((await listShipment(SHP_A, await driverTok(D1))).events);

    for (const kind of APPENDABLE) {
      const isInternal = KIND_VISIBILITY_DEFAULTS[kind] === "internal";
      // tenant lens sees the unredacted truth — every appended kind is present.
      expect(tenant.has(kind), `tenant should see ${kind}`).toBe(true);
      // party lens sees a kind iff it is NOT internal.
      expect(party.has(kind), `party visibility wrong for ${kind}`).toBe(!isInternal);
      // driver lens sees a kind iff it is NOT internal AND on the driver allowlist.
      expect(driver.has(kind), `driver visibility wrong for ${kind}`).toBe(!isInternal && driverAllow.has(kind));
    }
    // explicit spot-checks so a map regression can't pass by making every kind vanish
    expect(party.has("credit.checked")).toBe(false);
    expect(driver.has("invoice.issued")).toBe(false);
    expect(driver.has("pod.signed")).toBe(true);
  });
});

// 9b — INDEPENDENT I6 guards. Case 9 above derives its expectation from the SAME maps the routes
// consume, so a map regression moves both sides in lockstep and the sweep still passes (it cannot go
// red on a real leak — proven: flipping authority.flipped to counterparty leaves case 9 green). These
// two guards do NOT import the map under test. A hardcoded internal-kind literal proves BEHAVIOR (no
// internal control event ever reaches a party/driver body); a frozen 35-pair snapshot proves the MAP
// itself, so any drift fails a dedicated, obviously-named test instead of moving the goalposts.
const INTERNAL_KINDS_FROZEN = [
  "credit.checked", "split.computed", "call.transcribed",
  "approval.requested", "approval.decided", "agent.acted", "authority.flipped",
] as const;

const FROZEN_DEFAULTS: Record<EventKind, "internal" | "counterparty" | "public"> = {
  "quote.requested": "counterparty", "quote.priced": "counterparty", "quote.sent": "counterparty",
  "quote.accepted": "counterparty", "quote.expired": "counterparty", "booking.created": "counterparty",
  "appointment.set": "counterparty", "pickup.scheduled": "counterparty", "dispatch.assigned": "counterparty",
  "stop.arrived": "counterparty", "freight.counted": "counterparty", "freight.photographed": "counterparty",
  "dims.captured": "counterparty", "custody.transferred": "counterparty", "seal.applied": "counterparty",
  "stop.departed": "counterparty", "position.updated": "counterparty", "exception.raised": "counterparty",
  "osd.captured": "counterparty", "pod.signed": "counterparty", "delivery.evidenced": "counterparty",
  "invoice.issued": "counterparty", "invoice.corrected": "counterparty", "payment.received": "counterparty",
  "settlement.executed": "counterparty", "message.received": "counterparty", "message.sent": "counterparty",
  "document.attached": "counterparty",
  "credit.checked": "internal", "split.computed": "internal", "call.transcribed": "internal",
  "approval.requested": "internal", "approval.decided": "internal", "agent.acted": "internal",
  "authority.flipped": "internal",
};

describe("case 9b: independent I6 guards (do NOT import the map under test)", () => {
  it("no internal control kind ever reaches a party or driver lens (hardcoded literal, not the map)", async () => {
    const party = await listShipment(SHP_A, await portalTok(P1));
    const driver = await listShipment(SHP_A, await driverTok(D1));
    // shipment A carries one event of every appendable kind (incl. all seven below), so a leak shows up.
    for (const kind of INTERNAL_KINDS_FROZEN) {
      expect(party.body, `party lens leaked internal kind ${kind}`).not.toContain(kind);
      expect(driver.body, `driver lens leaked internal kind ${kind}`).not.toContain(kind);
    }
  });

  it("KIND_VISIBILITY_DEFAULTS equals its frozen 35-pair snapshot (drift fails HERE, by name)", () => {
    expect(Object.keys(FROZEN_DEFAULTS)).toHaveLength(35);
    expect(KIND_VISIBILITY_DEFAULTS).toEqual(FROZEN_DEFAULTS);
  });
});

// The firehose: composite (stream_id, seq) keyset — tenant-lens roles only; portal/driver must scope
// by shipment. A cursor at a stream boundary must NOT drop the next stream's low-seq rows.
describe("firehose GET /v1/events", () => {
  it("is forbidden to portal and driver sessions (they must scope by shipment)", async () => {
    expect((await listFirehose(await portalTok(P1))).status).toBe(403);
    expect((await listFirehose(await driverTok(D1))).status).toBe(403);
  });

  it("composite cursor advances past a stream boundary without dropping low-seq rows", async () => {
    const ops = await opsTok();
    // cursor at the end of FIRE_1 (seq 2). FIRE_2's rows have seq 0,1,2 (<= 2): a seq-only filter would
    // wrongly drop them; the composite (stream_id,seq) keyset must return all three.
    const res = await listFirehose(ops, `?cursor=${encodeURIComponent(`s:${FIRE_1}:2`)}&limit=500`);
    expect(res.status).toBe(200);
    const fire2 = res.events.filter((e) => e.stream_id === `s:${FIRE_2}`).map((e) => e.seq as number).sort((a, b) => a - b);
    expect(fire2).toEqual([0, 1, 2]);
    // and the cursor excludes FIRE_1's already-seen rows
    expect(res.events.some((e) => e.stream_id === `s:${FIRE_1}` && (e.seq as number) <= 2)).toBe(false);
  });

  it("paginates with a keyset cursor across the whole tenant with no dropped or duplicated rows", async () => {
    const ops = await opsTok();
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let i = 0; i < 200; i++) {
      const q: string = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : "?limit=100";
      const page: ListResult = await listFirehose(ops, q);
      expect(page.status).toBe(200);
      for (const e of page.events) {
        const key = `${e.stream_id as string}:${e.seq as number}`;
        expect(seen.has(key), `duplicate keyset row ${key}`).toBe(false);
        seen.add(key);
      }
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    // our six firehose rows are all present exactly once
    for (const shp of [FIRE_1, FIRE_2]) for (let s = 0; s < 3; s++) expect(seen.has(`s:${shp}:${s}`)).toBe(true);
  });

  it("surfaces a bad cursor mode (after_seq without a shipment scope) as a clean 400, not a 500", async () => {
    const res = await SELF.fetch("https://api.local/v1/events?after_seq=1", { headers: { Authorization: `Bearer ${await opsTok()}` } });
    expect(res.status).toBe(400);
  });
});

// Driver WRITE authorization (the handler rule the plan leaves to the route): a driver may append only
// to a shipment assigned to them.
describe("driver append authorization", () => {
  it("D2 cannot append to D1's shipment (FORBIDDEN)", async () => {
    const r = await append(SHP_A, buildInput(SHP_A, "stop.arrived"), await driverTok(D2));
    expect(r.status).toBe(403);
  });
  it("D1 CAN append to its own assigned shipment", async () => {
    const r = await append(SHP_A, buildInput(SHP_A, "stop.arrived"), await driverTok(D1));
    expect(r.status).toBe(201);
  });
  it("a finance/read role cannot append at all (role gate)", async () => {
    const r = await append(SHP_A, buildInput(SHP_A, "stop.arrived"), await token({ sub: "adv-fin", tenant: TENANT_SLUG, role: "finance" }));
    expect(r.status).toBe(403);
  });
});

// REQ-030 / REQ-003 — money is a PROJECTION the SERVER emits, never a client fact. The anomaly /
// penny-parity / executing-share-floor gates that make an invoice.issued safe live in the Biller's
// composeInvoice, NOT in the DO append gate — so a client that hand-crafts one and POSTs it to the
// public events route would BYPASS every one of them (the DO only runs the I2 gate). The route refuses
// the server-emitted money kinds OUTRIGHT — before the DO gate — so even a well-formed one on a stream
// that HAS a pod.signed (the I2 gate would otherwise pass, and it was accepted 201 before this fix) is
// rejected. The server's OWN emissions ride the SeqStub directly (rate.ts / biller.ts) and never
// traverse this route, so they are unaffected (the biller/heartbeat suites stay green).
describe("server-emitted money kinds are refused at the public route (REQ-030)", () => {
  const SHP = "adv-shp-serveronly";
  const forgedInvoice = (): Record<string, unknown> =>
    buildInput(SHP, "invoice.issued", {
      // a WELL-FORMED, absurd $222,084 invoice — the anomaly gate lives in composeInvoice, not the DO.
      payload: { invoice_id: `inv-forged-${SHP}`, party_id: P2, division: "main", lines: [{ line_no: 1, kind: "freight", amount_cents: 22_208_400, gl_map: "4000-REV" }] },
    });

  beforeAll(async () => {
    const ops = await opsTok();
    // A pod-BEARING stream: the DO's I2 gate would PASS here, so before this fix the forged invoice.issued
    // was accepted (201). booking.created creates the shipments row; pod.signed is ungated (actor P1 exists).
    await append(SHP, buildInput(SHP, "booking.created", { party_refs: [P1] }), ops);
    const p = await append(SHP, buildInput(SHP, "pod.signed", { party_refs: [P1] }), ops);
    if (p.status !== 201) throw new Error(`seed ${SHP}/pod.signed failed: ${p.status} ${p.body}`);
  });

  it("an ops principal POSTing a hand-crafted $222,084 invoice.issued -> 403 FORBIDDEN server-only; NOTHING appended, NO money_lines", async () => {
    const ops = await opsTok();
    const r = await append(SHP, forgedInvoice(), ops);
    expect(r.status).toBe(403);
    expect(r.json!.code).toBe("FORBIDDEN"); // NOT GATE_BLOCKED — refused at the route, before the DO gate
    expect(r.body).toContain("SERVER-EMITTED");

    const list = await listShipment(SHP, ops);
    expect(kindsOf(list.events).has("invoice.issued")).toBe(false); // the forged event never landed
    const ml = await env.TENANT_A_DB.prepare("SELECT COUNT(*) AS n FROM money_lines WHERE shipment_id = ?").bind(SHP).first<{ n: number }>();
    expect(ml!.n).toBe(0); // and the money projection never ran
  });

  it("a driver principal is refused the SAME way — the server-only refusal fires BEFORE the driver write-scope check", async () => {
    const r = await append(SHP, forgedInvoice(), await driverTok(D1));
    expect(r.status).toBe(403);
    // 'SERVER-EMITTED', not 'DRIVER NOT ASSIGNED': the server-only gate is checked first, so the reason a
    // client sees can never be forged into a mere scope miss.
    expect(r.body).toContain("SERVER-EMITTED");
  });

  it("every server-emitted money kind is refused (the whole set, not just invoice.issued)", async () => {
    const ops = await opsTok();
    for (const kind of ["invoice.issued", "invoice.corrected", "split.computed", "payment.received", "settlement.executed"] as const) {
      const r = await append(SHP, buildInput(SHP, kind), ops);
      expect(r.status, `${kind} must be refused at the route`).toBe(403);
      expect(r.body).toContain("SERVER-EMITTED");
    }
  });
});

// NOTE (WP-06 exit audit, REQ-030): the former "gate refusal envelope" case posted invoice.issued —
// a SERVER-EMITTED kind — through the PUBLIC route to reach the DO's I2 gate and prove the route
// translates a gate refusal into the envelope with gate.required_evidence. That case was itself
// exercising the money-projection hole (a client could POST invoice.issued), now closed above. The
// route's gate-envelope translation for a CLIENT-drivable gated transition is covered by pod.test.ts
// (delivery.evidenced with no pod.signed -> GATE_BLOCKED ['pod.signed']); the DO's I2 gate itself by
// sequencer.test.ts (invoice.issued via the internal stub -> GATE_BLOCKED). So it is removed here.

// Mutations require an Idempotency-Key (the WP-01 middleware); confirm the ledger routes are under it.
describe("mutation idempotency", () => {
  it("POST /v1/shipments/:id/events without Idempotency-Key is 400", async () => {
    const res = await SELF.fetch(`https://api.local/v1/shipments/${SHP_A}/events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await opsTok()}`, "content-type": "application/json" },
      body: JSON.stringify(buildInput(SHP_A, "stop.arrived")),
    });
    expect(res.status).toBe(400);
  });
});

// POST /v1/positions — the partition. Bypasses the sequencer; PK (shipment_id, device_id, ts) +
// INSERT OR IGNORE dedupes the row; hash = sha256(canonical(row)) is stable across re-ingest.
describe("POST /v1/positions", () => {
  // REQ-190 (2026-07-15 audit C-1) — the raw-GPS bypass now re-enforces the SAME server-side gates the
  // sequencer's stop.arrived path does: driver-assignment scope, device-registration, and consent-before-
  // GPS (REQ-030/166). So the partition-mechanics assertions below (hash, dedupe, PK-conflict) must post
  // through a driver that PASSES those gates, else they'd 403 before ever reaching the INSERT. Seed once:
  // a control-plane driver that OWNS the posting devices, each position shipment ASSIGNED to that driver,
  // and a CA ConsentAck on each stream (POS_CA derives via deriveOperatingState to "CA").
  const POS_DRIVER = "adv-pos-driver";
  const POS_CA = { lat_e6: 37_421_000, lon_e6: -122_084_000 }; // deriveOperatingState -> "CA"
  const posTok = (): Promise<string> => token({ sub: POS_DRIVER, tenant: TENANT_SLUG, role: "driver" });

  async function postPosition(input: Record<string, unknown>, tok: string): Promise<Response> {
    return SELF.fetch("https://api.local/v1/positions", {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  beforeAll(async () => {
    // The posting driver OWNS dev-x / dev-y / dev-c on the control plane (device-registration gate). The
    // public_jwk is unused by the positions route's ownership check (raw pings carry no signed envelope —
    // the [CONFIRM] per-ping signature is a separate decision), so a placeholder JWK suffices here.
    await env.CONTROL_DB.prepare("INSERT OR IGNORE INTO users (id, tenant_id, email, role, auth, device_keys) VALUES (?,?,?,?,?,?)")
      .bind(POS_DRIVER, "t-a", "adv-pos-driver@tenant-a.test", "driver", "{}", JSON.stringify([
        { device_id: "dev-x", public_jwk: {} },
        { device_id: "dev-y", public_jwk: {} },
        { device_id: "dev-c", public_jwk: {} },
      ]))
      .run();
    const ops = await opsTok();
    for (const id of ["adv-pos-1", "adv-pos-2", "adv-pos-conflict"]) {
      // status_cache carries the assignment the positions route checks (assigned_driver === session.sub).
      await env.TENANT_A_DB.prepare("INSERT OR IGNORE INTO shipments (id, shipper_party_id, consignee_party_id, bill_to_party_id, status_cache, created_ts) VALUES (?,?,?,?,?,0)")
        .bind(id, "party-shipper", "party-consignee", "party-bill-to", JSON.stringify({ assigned_driver: POS_DRIVER }))
        .run();
      // A CA ConsentAck on the stream so the consent-before-GPS gate passes for a POS_CA-derived ("CA") ping.
      const r = await append(id, buildInput(id, "document.attached", { payload: consentPayload("CA") }), ops);
      expect(r.status).toBe(201);
    }
  });

  it("a driver posts a position; the row lands with a canonical hash", async () => {
    const pos = { shipment_id: "adv-pos-1", device_id: "dev-x", ts: 1_720_000_000_111, lat_e6: POS_CA.lat_e6, lon_e6: POS_CA.lon_e6, accuracy_m: 5, speed_cms: 1_500 };
    const res = await postPosition(pos, await posTok());
    expect(res.status).toBe(201);
    const row = await env.TENANT_A_DB.prepare("SELECT * FROM positions WHERE shipment_id=? AND device_id=? AND ts=?").bind(pos.shipment_id, pos.device_id, pos.ts).first<Record<string, string | number | null>>();
    expect(row).not.toBeNull();
    const expected = await sha256Hex(canonicalBytes({ shipment_id: pos.shipment_id, device_id: pos.device_id, ts: pos.ts, lat_e6: pos.lat_e6, lon_e6: pos.lon_e6, accuracy_m: pos.accuracy_m, speed_cms: pos.speed_cms }));
    expect(row!.hash).toBe(expected);
    expect(row!.recorded_at).toEqual(expect.any(Number));
  });

  it("re-ingesting the same position (fresh Idempotency-Key) is a no-op dedupe, not an error", async () => {
    const pos = { shipment_id: "adv-pos-2", device_id: "dev-y", ts: 1_720_000_000_222, lat_e6: POS_CA.lat_e6, lon_e6: POS_CA.lon_e6 };
    expect((await postPosition(pos, await posTok())).status).toBe(201);
    expect((await postPosition(pos, await posTok())).status).toBe(201); // PK + INSERT OR IGNORE
    const n = await env.TENANT_A_DB.prepare("SELECT COUNT(*) AS n FROM positions WHERE shipment_id=? AND device_id=? AND ts=?").bind(pos.shipment_id, pos.device_id, pos.ts).first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it("rejects a float coordinate (integer-only canonical law)", async () => {
    // Parse (PositionInput.safeParse) runs BEFORE the gates, so a float is 400 regardless of assignment.
    const res = await postPosition({ shipment_id: "adv-pos-3", device_id: "dev-z", ts: 1_720_000_000_333, lat_e6: 1.5, lon_e6: 2 }, await posTok());
    expect(res.status).toBe(400);
  });

  // A PK conflict with DIFFERENT data trips positions_guard_ins (RAISE(ABORT)). Integrity holds (the row
  // is NOT rewritten), but it is a CLIENT conflict — it must surface as 400, never a 500 (which a client
  // would retry forever and which would pollute Watchtower's unhandled-error alarm).
  it("a same-PK re-ingest with DIFFERENT coordinates is a 400 (not a 500), and the row is not rewritten", async () => {
    // Both coords stay inside the CA box so the consent gate passes on BOTH posts and the conflict reaches
    // the INSERT guard (not a gate block): the SAME (shipment, device, ts) with a DIFFERENT lat → different
    // hash → positions_guard_ins aborts.
    const base = { shipment_id: "adv-pos-conflict", device_id: "dev-c", ts: 1_720_000_000_777, lat_e6: 37_421_000, lon_e6: -122_084_000 };
    expect((await postPosition(base, await posTok())).status).toBe(201);

    const conflict = await postPosition({ ...base, lat_e6: 37_422_000 }, await posTok());
    expect(conflict.status).toBe(400);
    const body = JSON.parse(await conflict.text()) as { code: string };
    expect(body.code).toBe("VALIDATION_FAILED"); // NOT INTERNAL -> the error.unhandled/500 path was NOT taken

    // integrity: the stored row still carries the ORIGINAL coordinates (the guard blocked the overwrite)
    const row = await env.TENANT_A_DB.prepare("SELECT lat_e6 FROM positions WHERE shipment_id=? AND device_id=? AND ts=?").bind(base.shipment_id, base.device_id, base.ts).first<{ lat_e6: number }>();
    expect(row!.lat_e6).toBe(base.lat_e6);
  });

  it("requires an Idempotency-Key", async () => {
    // The idempotency middleware runs before the handler, so a missing key is 400 before the gates.
    const res = await SELF.fetch("https://api.local/v1/positions", {
      method: "POST",
      headers: { Authorization: `Bearer ${await posTok()}`, "content-type": "application/json" },
      body: JSON.stringify({ shipment_id: "adv-pos-4", device_id: "d", ts: 1, lat_e6: 1, lon_e6: 2 }),
    });
    expect(res.status).toBe(400);
  });

  it("a read/portal role cannot post positions (role gate)", async () => {
    const res = await postPosition({ shipment_id: "adv-pos-5", device_id: "d", ts: 1, lat_e6: 1, lon_e6: 2 }, await portalTok(P1));
    expect(res.status).toBe(403);
  });
});

// Minor route-level coverage the probes confirmed but the shipped suite did not assert.
describe("route-level geo + position.updated event handling", () => {
  it("a driver lens keeps geo EXACT — coarsening is a party-only projection (doc 07 §02)", async () => {
    const res = await listShipment(SHP_A, await driverTok(D1));
    const custody = res.events.find((e) => e.kind === "custody.transferred");
    expect(custody).toBeDefined();
    const g = (custody!.payload as { geo: Record<string, unknown> }).geo;
    expect(g.lat_e6).toBe(GEO.lat_e6);
    expect(g.lon_e6).toBe(GEO.lon_e6);
    expect(g.accuracy_m).toBe(GEO.accuracy_m);
  });

  it("a position.updated EVENT on the events route is rejected 400 — positions own the partition, not the log", async () => {
    const shp = "adv-shp-posevent";
    const r = await append(shp, buildInput(shp, "position.updated", { payload: { lat_e6: 1, lon_e6: 2 } }), await opsTok());
    expect(r.status).toBe(400);
  });
});

// case 10 — REQ-085 (WP-09 Task 6): the PORTAL DOCUMENTS lens. A documents row carries its OWN `visibility`
// (DERIVED, at evidence write, from the recording event — I6), and GET /v1/shipments/:id/documents scopes
// it exactly as the events read does: a portal party sees ONLY visibility<>'internal' docs AND only on a
// shipment its lens can see; ops (tenant lens) sees all. The signed-URL resolver enforces the SAME gate —
// a party can never get a download URL for an internal doc. Doc rows are seeded DIRECTLY here (the READ lens
// is what is under test; the derivation itself is proven in documents.test.ts).
describe("case 10: portal documents lens + fail-closed signed URL (REQ-085)", () => {
  const SHP_DOCS = "adv-shp-docs";
  const CP_DOC = "adv-doc-cp"; // counterparty — P1 sees it
  const INT_DOC = "adv-doc-int"; // internal — P1 never sees it

  async function listDocs(shipmentId: string, tok: string): Promise<{ status: number; ids: Set<string> }> {
    const res = await SELF.fetch(`https://api.local/v1/shipments/${shipmentId}/documents`, { headers: { Authorization: `Bearer ${tok}` } });
    const parsed = res.status === 200 ? ((await res.json()) as { documents: Array<{ id: string }> }) : { documents: [] };
    return { status: res.status, ids: new Set(parsed.documents.map((d) => d.id)) };
  }
  async function docUrlStatus(documentId: string, tok: string): Promise<number> {
    const res = await SELF.fetch(`https://api.local/v1/documents/${documentId}/url`, { headers: { Authorization: `Bearer ${tok}` } });
    return res.status;
  }

  beforeAll(async () => {
    // A counterparty event scopes P1 to the shipment (P1 in party_refs); bill_to P2 carries an email so the
    // booking evidence-recipient gate passes (see the file-level beforeAll).
    const ops = await opsTok();
    const b = await append(SHP_DOCS, buildInput(SHP_DOCS, "booking.created", { party_refs: [P1] }), ops);
    if (b.status !== 201) throw new Error(`seed ${SHP_DOCS}/booking failed: ${b.status} ${b.body}`);
    await env.TENANT_A_DB.prepare("INSERT OR IGNORE INTO documents (id, shipment_id, kind, r2_key, hash, visibility) VALUES (?,?,?,?,?,?)")
      .bind(CP_DOC, SHP_DOCS, "photo", `evidence/${TENANT_SLUG}/${SHP_DOCS}/cp`, HEX64, "counterparty")
      .run();
    await env.TENANT_A_DB.prepare("INSERT OR IGNORE INTO documents (id, shipment_id, kind, r2_key, hash, visibility) VALUES (?,?,?,?,?,?)")
      .bind(INT_DOC, SHP_DOCS, "ratecon", `evidence/${TENANT_SLUG}/${SHP_DOCS}/int`, HEX64, "internal")
      .run();
  });

  it("portal P1 lists ONLY the counterparty doc, never the internal one; ops sees both", async () => {
    const p1 = await listDocs(SHP_DOCS, await portalTok(P1));
    expect(p1.status).toBe(200);
    expect(p1.ids.has(CP_DOC)).toBe(true);
    expect(p1.ids.has(INT_DOC)).toBe(false);

    const ops = await listDocs(SHP_DOCS, await opsTok());
    expect(ops.ids.has(CP_DOC)).toBe(true);
    expect(ops.ids.has(INT_DOC)).toBe(true);
  });

  it("a signed-URL request for the INTERNAL doc → 404 (fail-closed); the counterparty doc → 200", async () => {
    expect(await docUrlStatus(INT_DOC, await portalTok(P1))).toBe(404);
    expect(await docUrlStatus(CP_DOC, await portalTok(P1))).toBe(200);
  });

  it("a portal party NOT on the shipment sees no docs and gets no URL", async () => {
    const other = await listDocs(SHP_DOCS, await portalTok(P2));
    expect(other.ids.has(CP_DOC)).toBe(false);
    expect(await docUrlStatus(CP_DOC, await portalTok(P2))).toBe(404);
  });
});
