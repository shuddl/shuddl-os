import { SELF, env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyChain } from "@shuddl/ledger/chain";
import { rowToEvent } from "@shuddl/ledger/lens";
import type { LedgerEvent } from "@shuddl/contracts";
import { renderQuoteReply } from "@shuddl/agents";
import { DISPATCH_REQUIRED_DOC_KIND } from "@shuddl/ledger/gates/transition-gates";
import { handleQuoteAccepted, QuoteAcceptedTrigger, bookingEventIdFor } from "../../agents/src/booking.js";
import type { BookingDeps } from "../../agents/src/booking.js";
import type { SeqStubLike } from "../../agents/src/biller.js";
import type { AppendedEvent } from "../src/do/sequencer.js";
import { localServiceDate, localWall } from "../src/appointment-window.js";
import type { Env } from "../src/index.js";
import {
  TENANT_SLUG,
  TEST_FACILITY,
  TEST_RATE_CONFIG,
  TEST_TRANSIT_MATRIX,
  ensureSchema,
  post,
  requiredEvidence,
  seedFacility,
  seedLeg,
  seedRateConfig,
  seedShipment,
  seedTransitMatrix,
  streamCount as countEvents,
  token,
  type Res,
} from "./helpers.js";

// ─── WP-08 T9 — THE SCHEDULER HEARTBEAT (the WP-08 acceptance demo, end to end through EVERY real seam) ──
//
// The ONE causal chain the DoD (genesis/08 WP-08) demands — "double-book impossible in test; reschedule
// flows emit events; consignee-contact gate enforced at booking" — driven through REAL seams and asserted
// step by step, nothing mocked. Every write lands through the real sequencer DO (real Gatekeeper gates,
// real projections); the quote is a real POST /v1/rate; the booking is the real Booking agent (T8) fed the
// EXACT queue trigger the DO enqueued for a real quote.accepted. Only the ratecon document (its generation
// is REQ-184-deferred) and the tenant configs (rate/transit/facility) are seeded — everything causal is real.
//
//   ① QUOTE → ACCEPT → GATED BOOKING (REQ-059/028/042/047/182/181): a real /v1/rate prices the lane WITH an
//      honest transit window ("N business days", REQ-059); a real quote.accepted enqueues the Booking trigger;
//      the real agent books THROUGH the gated DO → shipment `booked`, T4 party-correction, T5 skeleton legs.
//   ② EVIDENCE-RECIPIENT GATE at booking (REQ-047/182): a bill_to with no deliverable contact → the agent HOLDS
//      (held(evidence_recipient), no booking) — the real T6 gate inside the real DO, caught by the real agent.
//   ③ APPOINTMENT claims a dock slot (REQ-052): a real appointment.set claims a seeded facility slot → 201.
//   ④ DOUBLE-BOOK IMPOSSIBLE (REQ-028 — the DoD centerpiece): a SECOND claim on the same (facility,slot,date)
//      → 400 slot_taken + ZERO append; AND the simultaneous TOCTOU variant (Promise.allSettled) → EXACTLY ONE
//      commits, COUNT(*)===1 — the ux_legs_slot index is the atomic arbiter.
//   ⑤ DISPATCH gated then allowed (REQ-043): dispatch.assigned with no ratecon → 403 ["docs"]; seed the ratecon;
//      dispatch.assigned → 201, shipment `dispatched` with the assigned driver.
//   ⑥ RESCHEDULE emits events + frees the slot (REQ-028): appointment.set{reschedule_of} moves the claim; the
//      OLD slot is claimable again; BOTH appointment.set events are retained (append-only, I3/I7).
//
// isolatedStorage is OFF (shared D1): every id here is heartbeat-unique so nothing collides with sibling files.

const TENANT = TENANT_SLUG;
const MAIN = "sched-heartbeat-1"; // the ONE shipment that threads the whole chain (quote→book→appoint→dispatch→reschedule)
const LANE = { origin_zip: "97005", dest_zip: "80012" }; // 97005→"970"→Z1, 80012→"800"→Z5 ⇒ TEST_TRANSIT_MATRIX Z1→Z5 = 3 business days
const TRANSIT_DAYS = 3;

// A no-contact broker bill_to — the REQ-182 evidence-recipient hold (② negative). Its OWN party id, never the shared cast.
const BILL_TO_NOCONTACT = "hb-billto-nocontact";

// ── dock-slot instants (mirrors appointments.test's DST-safe construction; a Monday >= now+3d, within horizon) ──
const LA = "America/Los_Angeles"; // TEST_FACILITY.hours.tz
const AM = "mon-am-dock-1"; // Monday 08:00–12:00 (min 480..720, dow 1)
const PM = "mon-pm-dock-1"; // Monday 12:00–17:00 (min 720..1020, dow 1)
const DAY = 86_400_000;

// The inverse of localWall (two-pass, tz-offset-correcting; Mondays never straddle a US DST switch, so it converges).
function zonedTimeToEpoch(y: number, mo: number, d: number, minuteOfDay: number, tz: string): number {
  const hh = Math.floor(minuteOfDay / 60);
  const mm = minuteOfDay % 60;
  const guess = Date.UTC(y, mo - 1, d, hh, mm);
  const w = localWall(guess, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  return guess - (asUtc - guess);
}
function nextLocalDow(targetDow: number, minDaysOut: number, base = Date.now()): { y: number; mo: number; d: number } {
  let probe = base + minDaysOut * DAY;
  for (let i = 0; i < 21; i++) {
    const w = localWall(probe, LA);
    if (w.dow === targetDow) return { y: w.year, mo: w.month, d: w.day };
    probe += DAY;
  }
  throw new Error(`no local dow ${targetDow} found`);
}
const MON = nextLocalDow(1, 3);
const AM_START = zonedTimeToEpoch(MON.y, MON.mo, MON.d, 480, LA);
const AM_END = zonedTimeToEpoch(MON.y, MON.mo, MON.d, 720, LA);
const PM_START = zonedTimeToEpoch(MON.y, MON.mo, MON.d, 720, LA);
const PM_END = zonedTimeToEpoch(MON.y, MON.mo, MON.d, 1020, LA);
const SERVICE_DATE = localServiceDate(AM_START, LA); // the occurrence key both AM and PM share

let clock = 1_733_100_000_000; // this file's own monotonic actor-ts base (own streams anyway)

// ── the Booking agent's consumer deps against the REAL DO + D1 (mirrors booking.test / biller.test) ─────
const seqStub: SeqStubLike = {
  append: (req) =>
    (env.SHIPMENT_SEQ.get(env.SHIPMENT_SEQ.idFromName(`${req.tenant}|${req.streamId}`)) as unknown as SeqStubLike).append(req),
};
const bookingDeps: BookingDeps = { db: env.TENANT_A_DB, seq: seqStub };

// The bare DO stub surface for the simultaneous-race variant (the union RPC mapper explodes — mirrors appointments.test).
type SeqStub = DurableObjectStub & { append(req: { tenant: string; streamId: string; input: unknown }): Promise<AppendedEvent> };
function stubFor(streamId: string): SeqStub {
  return env.SHIPMENT_SEQ.get(env.SHIPMENT_SEQ.idFromName(`${TENANT}|${streamId}`)) as unknown as SeqStub;
}

// A valid appointment.set EventInput (client-suppliable subset). Fresh uuid per call; the payload levers ride `payloadOver`.
function apptInput(shipmentId: string, facilityId: string, payloadOver: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    shipment_id: shipmentId,
    ts: clock++,
    actor: { party: "party-shipper" },
    party_refs: [],
    evidence: [],
    source: "native",
    confidence: 10_000,
    kind: "appointment.set",
    payload: { leg_kind: "pickup", facility_id: facilityId, slot_key: AM, window_start_ts: AM_START, window_end_ts: AM_END, ...payloadOver },
  };
}

// A valid dispatch.assigned EventInput. actor.user is the assigned driver the status_cache projection reads (⑤).
function dispatchInput(shipmentId: string): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    shipment_id: shipmentId,
    ts: clock++,
    actor: { party: "party-carrier", user: "u-driver" },
    party_refs: [],
    evidence: [],
    source: "native",
    confidence: 10_000,
    kind: "dispatch.assigned",
    payload: { driver_user_id: "u-driver" },
  };
}

// ── DB probes ────────────────────────────────────────────────────────────────────────────────────────
async function streamEvents(shipmentId: string): Promise<LedgerEvent[]> {
  const res = await env.TENANT_A_DB.prepare("SELECT * FROM events WHERE stream_id = ? ORDER BY seq").bind(`s:${shipmentId}`).all();
  return (res.results as Record<string, string | number | null>[]).map((r) => rowToEvent(r));
}
async function eventKinds(shipmentId: string, kind: string): Promise<LedgerEvent[]> {
  return (await streamEvents(shipmentId)).filter((e) => e.kind === kind);
}
async function shipmentState(id: string): Promise<string | undefined> {
  const row = await env.TENANT_A_DB.prepare("SELECT json_extract(status_cache, '$.state') AS state FROM shipments WHERE id = ?").bind(id).first<{ state: string | null }>();
  return row?.state ?? undefined;
}
async function assignedDriver(id: string): Promise<string | undefined> {
  const row = await env.TENANT_A_DB.prepare("SELECT json_extract(status_cache, '$.assigned_driver') AS d FROM shipments WHERE id = ?").bind(id).first<{ d: string | null }>();
  return row?.d ?? undefined;
}
async function shipmentParties(id: string): Promise<{ consignee: string; billTo: string } | undefined> {
  const row = await env.TENANT_A_DB.prepare("SELECT consignee_party_id, bill_to_party_id FROM shipments WHERE id = ?").bind(id).first<{ consignee_party_id: string; bill_to_party_id: string }>();
  return row === null ? undefined : { consignee: row.consignee_party_id, billTo: row.bill_to_party_id };
}
async function legKinds(shipmentId: string): Promise<string[]> {
  const res = await env.TENANT_A_DB.prepare("SELECT id, kind FROM legs WHERE shipment_id = ? ORDER BY seq").bind(shipmentId).all<{ id: string; kind: string }>();
  return res.results.map((r) => `${r.id}|${r.kind}`);
}
async function legSlot(shipmentId: string): Promise<string | null> {
  const row = await env.TENANT_A_DB.prepare("SELECT appt_slot_key FROM legs WHERE shipment_id = ? AND kind = 'pickup'").bind(shipmentId).first<{ appt_slot_key: string | null }>();
  return row?.appt_slot_key ?? null;
}
async function slotClaimCount(facilityId: string, slot: string): Promise<number> {
  const row = await env.TENANT_A_DB.prepare("SELECT COUNT(*) AS n FROM legs WHERE facility_id = ? AND appt_slot_key = ? AND appt_service_date = ?").bind(facilityId, slot, SERVICE_DATE).first<{ n: number }>();
  return row?.n ?? 0;
}

// ── seeders (the ONLY seeded shortcuts: tenant configs + the REQ-184-deferred ratecon doc) ─────────────
async function seedFac(id: string): Promise<void> {
  await seedFacility(env.TENANT_A_DB, { ...TEST_FACILITY, id });
}
// Seed the dispatch-required carrier paperwork: a documents row of the SHARED DISPATCH_REQUIRED_DOC_KIND
// ('ratecon'). REQ-184 (the rate-con GENERATION flow) is deferred, so — exactly as dispatch-gate.test does —
// the test seeds it. Using the ONE exported constant means a rename fails THIS test loudly, never silently.
const HEX64 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
async function seedRatecon(shipmentId: string): Promise<void> {
  await env.TENANT_A_DB.prepare("INSERT OR IGNORE INTO documents (id, shipment_id, kind, r2_key, hash) VALUES (?,?,?,?,?)")
    .bind(`doc-${shipmentId}-ratecon`, shipmentId, DISPATCH_REQUIRED_DOC_KIND, `r2/${shipmentId}/ratecon`, HEX64)
    .run();
}

// Seed a penny-parity-valid quote.priced + a quote.accepted naming it, THROUGH the real DO (② uses this for
// the held negative — the booking gate, not the quote, is what's under test there). Mirrors booking.test.
async function seedQuoteAndAccept(shipmentId: string): Promise<{ quoteId: string; acceptId: string }> {
  const quoteId = crypto.randomUUID();
  await seqStub.append({
    tenant: TENANT,
    streamId: `s:${shipmentId}`,
    input: {
      id: quoteId, shipment_id: shipmentId, ts: clock++, actor: { party: "agent:concierge" }, party_refs: [], evidence: [], source: "native", confidence: 10_000,
      kind: "quote.priced",
      payload: {
        sell: 120_000,
        lines: [ { kind: "freight", code: "freight", amount_cents: 90_000 }, { kind: "fsc", code: "fsc", amount_cents: 12_000 }, { kind: "accessorial", code: "liftgate", amount_cents: 18_000 } ],
        floors: { contribution: 60_000, full: 90_000, target: 100_000 },
        versions: { rate_config_ids: ["rc-hb-v1"] },
        basis: {},
      },
    },
  });
  const acceptId = crypto.randomUUID();
  await seqStub.append({
    tenant: TENANT,
    streamId: `s:${shipmentId}`,
    input: { id: acceptId, shipment_id: shipmentId, ts: clock++, actor: { party: "party-shipper" }, party_refs: [], evidence: [], source: "native", confidence: 10_000, kind: "quote.accepted", payload: { quote_event_id: quoteId } },
  });
  return { quoteId, acceptId };
}

// ── producer-side observation: swap a recording AGENT_QUEUE onto the live DO instance so the message the DO
// hands Cloudflare Queues for a committed quote.accepted is captured verbatim (the same honest spy booking.test
// documents), then fed — REAL wire payload — to the real consumer. ────────────────────────────────────────
async function patchAgentQueue(shipmentId: string, send: (m: unknown) => Promise<void>): Promise<void> {
  const stub = env.SHIPMENT_SEQ.get(env.SHIPMENT_SEQ.idFromName(`${TENANT}|s:${shipmentId}`));
  await runInDurableObject(stub, (instance) => {
    const inst = instance as unknown as { env: Env };
    inst.env = { ...inst.env, AGENT_QUEUE: { send } as unknown as Env["AGENT_QUEUE"] };
  });
}
// The enqueue rides ctx.waitUntil (off the response path), so give it a beat to settle.
async function settle(cond: () => boolean, ms = 1_000): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 10));
}

async function rate(shipmentId: string): Promise<Res> {
  const res = await SELF.fetch("https://api.local/v1/rate", {
    method: "POST",
    headers: { Authorization: `Bearer ${opsTok}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
    body: JSON.stringify({ shipment_id: shipmentId, ...LANE, weight_lb: 1000, dims: { l_in: 48, w_in: 40, h_in: 48, pieces: 2 } }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

let opsTok: string;

beforeAll(async () => {
  await ensureSchema(env);
  opsTok = await token({ sub: "u-driver", tenant: TENANT, role: "ops" }); // sub = the driver so ⑤ assigned_driver reads a real subject
  // ② the evidence-recipient hold party: credit-clear (null), NO deliverable contact, no opt-out → only the recipient gate can fire.
  await env.TENANT_A_DB.prepare("INSERT OR IGNORE INTO parties (id, kind, names, contacts, credit_status) VALUES (?,?,?,?,?)")
    .bind(BILL_TO_NOCONTACT, "broker", "{}", "[]", null)
    .run();
});

describe("SCHEDULER HEARTBEAT — quote → gated booking → appointment → double-book impossible → dispatch → reschedule (REQ-028/042/043/047/052/059)", () => {
  it("the WP-08 acceptance demo, one unbroken causal chain, through every real seam", async () => {
    // ═══ ① QUOTE → ACCEPT → GATED BOOKING ════════════════════════════════════════════════════════════
    await seedRateConfig(env.TENANT_A_DB, TEST_RATE_CONFIG);
    await seedTransitMatrix(env.TENANT_A_DB, TEST_TRANSIT_MATRIX); // Z1→Z5 = 3 business days (the honest window)
    await seedShipment(MAIN); // shipper=party-shipper, consignee=party-consignee, bill_to=party-bill-to (deliverable email)

    // A REAL POST /v1/rate: prices the lane AND records quote.priced (+ agent.acted) on the shipment stream.
    const rateRes = await rate(MAIN);
    expect(rateRes.status).toBe(200);
    const priced = rateRes.json as { status: string; sell_cents: number; transit: { status: string; business_days?: number } };
    expect(priced.status).toBe("PRICED");
    // REQ-059 — the HONEST transit window: a KNOWN business-day count for a matrix-covered lane, never fabricated.
    expect(priced.transit.status).toBe("known");
    expect(priced.transit.business_days).toBe(TRANSIT_DAYS);
    // …and the customer-facing quote reply carries it as "N business days" (the exact tenant-voice render, REQ-059/098).
    const reply = renderQuoteReply({ shipment_ref: MAIN, lane: LANE, sell_cents: priced.sell_cents, transit_days: priced.transit.business_days!, tenant_from_name: "Shuddl Dispatch" });
    expect(reply.html).toContain(`${TRANSIT_DAYS} business days`);

    // The quote.priced landed on the stream (the accept references it by id — a real read, never a hand-built id).
    const quoteRow = await env.TENANT_A_DB.prepare("SELECT id FROM events WHERE stream_id = ? AND kind = 'quote.priced'").bind(`s:${MAIN}`).first<{ id: string }>();
    expect(quoteRow).not.toBeNull();
    const quotePricedId = quoteRow!.id;

    // Arm the producer spy BEFORE the accept commits, so ITS enqueue is the one captured.
    const enqueued: unknown[] = [];
    await patchAgentQueue(MAIN, async (m) => { enqueued.push(m); });

    // A REAL quote.accepted through the real route → committed → the DO enqueues the Booking trigger.
    const acceptRes = await post(MAIN, {
      id: crypto.randomUUID(), shipment_id: MAIN, ts: clock++, actor: { party: "party-shipper" }, party_refs: [], evidence: [], source: "native", confidence: 10_000,
      kind: "quote.accepted", payload: { quote_event_id: quotePricedId },
    }, opsTok);
    expect(acceptRes.status, JSON.stringify(acceptRes.json)).toBe(201);
    const acceptId = (acceptRes.json as { id: string }).id;

    // The queue seam: EXACTLY the consumer's trigger was enqueued for the committed accept (its own Zod boundary accepts it).
    await settle(() => enqueued.length > 0);
    await new Promise((r) => setTimeout(r, 25)); // drain beat — a buggy duplicate a few macrotasks later would fail the length assert
    expect(enqueued).toHaveLength(1);
    const trigger = QuoteAcceptedTrigger.parse(enqueued[0]);
    expect(trigger).toEqual({ kind: "quote.accepted", tenant: TENANT, shipment_id: MAIN, event_id: acceptId });

    // Drive the REAL Booking agent (T8) with the CAPTURED trigger: it appends booking.created THROUGH the gated DO.
    const outcome = await handleQuoteAccepted(trigger, bookingDeps);
    expect(outcome.status, JSON.stringify(outcome)).toBe("booked");
    if (outcome.status !== "booked") throw new Error("unreachable");
    const bookings = await eventKinds(MAIN, "booking.created");
    expect(bookings).toHaveLength(1);
    expect(bookings[0]!.id).toBe(outcome.booking_event_id);
    expect(bookings[0]!.id).toBe(await bookingEventIdFor(acceptId)); // deterministic id — derived from the accept, never minted

    // The T4 read-model projection ran in the SAME booking batch: the shipment is `booked`, its row carries the
    // booked parties (the party-correction SET clause on the pre-existing quote-stage row), and the two
    // customer-facing skeleton legs materialized (T5) — the rows appointment.set will claim slots against.
    expect(await shipmentState(MAIN)).toBe("booked");
    expect(await shipmentParties(MAIN)).toEqual({ consignee: "party-consignee", billTo: "party-bill-to" });
    expect(await legKinds(MAIN)).toEqual([`${MAIN}:pickup|pickup`, `${MAIN}:delivery|delivery`]);

    // ═══ ② EVIDENCE-RECIPIENT GATE ENFORCED AT BOOKING (REQ-047/182) — the negative ═════════════════════
    // A bill_to with NO deliverable contact: the real T6 gate inside the real DO blocks the append; the real
    // Booking agent CATCHES the GATE_BLOCK and HOLDS (never DLQ-loops). No booking.created, never `booked`.
    const HELD = "sched-heartbeat-held";
    await env.TENANT_A_DB.prepare("INSERT OR IGNORE INTO shipments (id, shipper_party_id, consignee_party_id, bill_to_party_id, created_ts) VALUES (?,?,?,?,0)")
      .bind(HELD, "party-shipper", "party-consignee", BILL_TO_NOCONTACT).run();
    const held = await seedQuoteAndAccept(HELD);
    const heldOutcome = await handleQuoteAccepted({ kind: "quote.accepted", tenant: TENANT, shipment_id: HELD, event_id: held.acceptId }, bookingDeps);
    expect(heldOutcome.status, JSON.stringify(heldOutcome)).toBe("held");
    if (heldOutcome.status !== "held") throw new Error("unreachable");
    expect(heldOutcome.reason).toBe("evidence_recipient");
    expect(heldOutcome.required_evidence).toContain("evidence_recipient");
    expect(await eventKinds(HELD, "booking.created")).toHaveLength(0); // the gate aborted the append
    expect(await shipmentState(HELD)).toBeUndefined(); // never projected to booked

    // ═══ ③ APPOINTMENT CLAIMS A DOCK SLOT (REQ-052) ═════════════════════════════════════════════════════
    const FAC = "hb-fac";
    await seedFac(FAC);
    const claim = await post(MAIN, apptInput(MAIN, FAC), opsTok);
    expect(claim.status, JSON.stringify(claim.json)).toBe(201);
    const E1 = (claim.json as { id: string }).id; // the original appointment.set — ⑥ reschedules THIS one
    expect(await legSlot(MAIN)).toBe(AM); // the pickup leg now holds the claimed slot
    expect(await slotClaimCount(FAC, AM)).toBe(1);

    // ═══ ④ DOUBLE-BOOK IMPOSSIBLE (REQ-028 — the DoD centerpiece) ═══════════════════════════════════════
    // (a) sequential: a SECOND shipment claiming MAIN's already-held (facility, slot, date) → 400 slot_taken + ZERO append.
    const DBL = "sched-heartbeat-dbl";
    await seedShipment(DBL);
    await seedLeg(DBL, 0, "pickup", null); // the skeleton pickup leg the claim would UPDATE (equivalent to what booking.created leaves; booking.test (D))
    const before = await countEvents(DBL);
    const taken = await post(DBL, apptInput(DBL, FAC), opsTok);
    expect(taken.status).toBe(400);
    expect(taken.json?.code).toBe("VALIDATION_FAILED");
    expect(await countEvents(DBL)).toBe(before); // a refusal appends NOTHING
    expect(await slotClaimCount(FAC, AM)).toBe(1); // still claimed exactly once

    // (b) the simultaneous TOCTOU: two streams racing the SAME fresh slot via Promise.allSettled → EXACTLY ONE
    // commits. The per-stream mutex gives ZERO cross-stream exclusion; the ux_legs_slot UNIQUE INDEX is the sole
    // atomic arbiter (D1 single-writer) — the loser's whole batch aborts, the double-book event never commits.
    const RACE_FAC = "hb-fac-race";
    await seedFac(RACE_FAC);
    const ra = "sched-heartbeat-race-a";
    const rb = "sched-heartbeat-race-b";
    await seedShipment(ra); await seedShipment(rb);
    await seedLeg(ra, 0, "pickup", null); await seedLeg(rb, 0, "pickup", null);
    const results = await Promise.allSettled([
      stubFor(`s:${ra}`).append({ tenant: TENANT, streamId: `s:${ra}`, input: apptInput(ra, RACE_FAC) }),
      stubFor(`s:${rb}`).append({ tenant: TENANT, streamId: `s:${rb}`, input: apptInput(rb, RACE_FAC) }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1); // exactly one winner
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1); // exactly one loser
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/slot_taken/);
    // THE literal "double-book impossible" proof: the (facility, slot, service_date) is claimed exactly ONCE.
    expect(await slotClaimCount(RACE_FAC, AM)).toBe(1);
    // The loser's stream is untouched (a refusal never half-writes).
    const loser = results[0]?.status === "fulfilled" ? rb : ra;
    expect(await countEvents(loser)).toBe(0);

    // ═══ ⑤ DISPATCH GATED, THEN ALLOWED (REQ-043) ══════════════════════════════════════════════════════
    // MAIN is booked + scheduled (③) but has NO ratecon → the real dispatch gate blocks on ["docs"] only, ZERO append.
    const beforeDispatch = await countEvents(MAIN);
    const blockedDispatch = await post(MAIN, dispatchInput(MAIN), opsTok);
    expect(blockedDispatch.status).toBe(403);
    expect(blockedDispatch.json?.code).toBe("GATE_BLOCKED");
    expect(requiredEvidence(blockedDispatch)).toEqual(["docs"]); // appointment present; only the carrier paperwork is missing
    expect(await countEvents(MAIN)).toBe(beforeDispatch);

    // Seed the rate-con (REQ-184 generation deferred — the test seeds it, as the dispatch-gate tests do); now dispatch passes.
    await seedRatecon(MAIN);
    const dispatched = await post(MAIN, dispatchInput(MAIN), opsTok);
    expect(dispatched.status, JSON.stringify(dispatched.json)).toBe(201);
    expect(await shipmentState(MAIN)).toBe("dispatched");
    expect(await assignedDriver(MAIN)).toBe("u-driver"); // the projected assigned driver

    // ═══ ⑥ RESCHEDULE EMITS EVENTS + FREES THE SLOT (REQ-028, I3/I7) ════════════════════════════════════
    // A NEW appointment.set{reschedule_of: E1} atomically moves MAIN's claim mon-am → mon-pm.
    const resched = await post(MAIN, apptInput(MAIN, FAC, { slot_key: PM, window_start_ts: PM_START, window_end_ts: PM_END, reschedule_of: E1 }), opsTok);
    expect(resched.status, JSON.stringify(resched.json)).toBe(201);
    expect(await legSlot(MAIN)).toBe(PM);
    expect(await slotClaimCount(FAC, AM)).toBe(0); // the OLD slot is freed…
    expect(await slotClaimCount(FAC, PM)).toBe(1);

    // …and PROVABLY claimable again: a fresh shipment takes the vacated mon-am on the same date → 201.
    const RECLAIM = "sched-heartbeat-reclaim";
    await seedShipment(RECLAIM);
    await seedLeg(RECLAIM, 0, "pickup", null);
    expect((await post(RECLAIM, apptInput(RECLAIM, FAC), opsTok)).status).toBe(201);
    expect(await slotClaimCount(FAC, AM)).toBe(1);

    // Append-only (I3/I7): BOTH of MAIN's appointment.set events (the original claim + the reschedule) are retained.
    expect(await eventKinds(MAIN, "appointment.set")).toHaveLength(2);

    // ═══ THE WHOLE CHAIN IS ONE UNBROKEN, HASH-LINKED RECORD ═══════════════════════════════════════════
    // quote.priced → agent.acted → quote.accepted → booking.created → appointment.set → dispatch.assigned →
    // appointment.set(reschedule): every prev_hash → hash link holds across the entire scheduler heartbeat.
    const chain = await streamEvents(MAIN);
    expect(chain.map((e) => e.kind)).toEqual([
      "quote.priced", "agent.acted", "quote.accepted", "booking.created", "appointment.set", "dispatch.assigned", "appointment.set",
    ]);
    expect((await verifyChain(chain)).ok).toBe(true);
  });
});
