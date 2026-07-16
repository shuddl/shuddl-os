import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { LedgerEvent } from "@shuddl/contracts";
import { verifyChain } from "@shuddl/ledger/chain";
import { rowToEvent } from "@shuddl/ledger/lens";
import type { AppendedEvent } from "../src/do/sequencer.js";
import { localWall, localServiceDate } from "../src/appointment-window.js";
import {
  TENANT_SLUG,
  TEST_FACILITY,
  ensureSchema,
  post,
  seedFacility,
  seedLeg,
  seedShipment,
  streamCount as countEvents,
  token,
} from "./helpers.js";

// WP-08 T5 (REQ-028/052) — THE DoD CENTERPIECE: "double-book atomically impossible".
//
// Two bookings for the same dock slot are two DIFFERENT shipment streams on two DIFFERENT Durable Objects;
// the per-stream mutex gives ZERO cross-stream exclusion. The ATOMIC guarantee is D1's single-writer + the
// partial UNIQUE INDEX ux_legs_slot(facility_id, appt_slot_key, appt_service_date): the loser's db.batch
// (which carries the leg-claim UPDATE) violates the index and the WHOLE batch aborts, so the double-book
// event NEVER commits. The capacity GATE gives the clean 400 for the sequential case; the index is the sole
// arbiter for the simultaneous TOCTOU. Correctness is INDEPENDENT of the gate — dropping ux_legs_slot flips
// test (A) to COUNT===2 (the control noted in the DoD).
//
// D1 is SHARED across this file's tests (isolatedStorage off), and a slot claim PERSISTS, so each test uses
// its OWN facility id (part of the unique key) to stay independent — the same near-Monday occurrence is reused.

const TENANT = TENANT_SLUG;
const LA = "America/Los_Angeles"; // TEST_FACILITY.hours.tz
const AM = "mon-am-dock-1"; // slot: Monday 08:00–12:00 (min 480..720, dow 1)
const PM = "mon-pm-dock-1"; // slot: Monday 12:00–17:00 (min 720..1020, dow 1)
const DAY = 86_400_000;

// ---- constructing a valid slot instant (the inverse of localWall; test-only, DST-safe) ----------------
// Two-pass offset resolution: render the wall-clock guess, read what tz it actually is, correct by the tz
// offset at that instant. Mondays never straddle a US DST switch (those happen on Sundays), so it converges.
function zonedTimeToEpoch(y: number, mo: number, d: number, minuteOfDay: number, tz: string): number {
  const hh = Math.floor(minuteOfDay / 60);
  const mm = minuteOfDay % 60;
  const guess = Date.UTC(y, mo - 1, d, hh, mm);
  const w = localWall(guess, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  return guess - (asUtc - guess);
}

// The first calendar date (>= now + minDaysOut) whose LOCAL day-of-week is `targetDow`, in tz.
function nextLocalDow(targetDow: number, minDaysOut: number, base = Date.now()): { y: number; mo: number; d: number } {
  let probe = base + minDaysOut * DAY;
  for (let i = 0; i < 21; i++) {
    const w = localWall(probe, LA);
    if (w.dow === targetDow) return { y: w.year, mo: w.month, d: w.day };
    probe += DAY;
  }
  throw new Error(`no local dow ${targetDow} found`);
}

// A Monday >= now+3d (well within the 14-day horizon, past the 120-min lead, not same-day). BOTH the am and
// pm windows land on this SAME Monday so a reschedule am->pm stays on one occurrence date.
const MON = nextLocalDow(1, 3);
const AM_START = zonedTimeToEpoch(MON.y, MON.mo, MON.d, 480, LA); // 08:00 local
const AM_END = zonedTimeToEpoch(MON.y, MON.mo, MON.d, 720, LA); // 12:00 local
const PM_START = zonedTimeToEpoch(MON.y, MON.mo, MON.d, 720, LA); // 12:00 local
const PM_END = zonedTimeToEpoch(MON.y, MON.mo, MON.d, 1020, LA); // 17:00 local
const SERVICE_DATE = localServiceDate(AM_START, LA); // the occurrence key both am and pm share

const opsTok = (): Promise<string> => token({ sub: "u-appt-ops", tenant: TENANT, role: "ops" });

// Seed a per-test facility that clones TEST_FACILITY's capacity model under a fresh id (fresh unique-key space).
async function seedFac(id: string): Promise<void> {
  await seedFacility(env.TENANT_A_DB, { ...TEST_FACILITY, id });
}

// A valid appointment.set EventInput (client-suppliable subset). Fresh uuid per call.
function apptInput(shipmentId: string, facilityId: string, over: Record<string, unknown> = {}, payloadOver: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    shipment_id: shipmentId,
    ts: 1_720_000_000_000,
    actor: { party: "party-shipper" },
    party_refs: [],
    evidence: [],
    source: "native",
    confidence: 10_000,
    kind: "appointment.set",
    payload: { leg_kind: "pickup", facility_id: facilityId, slot_key: AM, window_start_ts: AM_START, window_end_ts: AM_END, ...payloadOver },
    ...over,
  };
}

// The DO stub surface (hand-written; the union RPC mapper explodes — mirrors sequencer.test).
type SeqStub = DurableObjectStub & { append(req: { tenant: string; streamId: string; input: unknown }): Promise<AppendedEvent> };
function stubFor(streamId: string): SeqStub {
  return env.SHIPMENT_SEQ.get(env.SHIPMENT_SEQ.idFromName(`${TENANT}|${streamId}`)) as unknown as SeqStub;
}

async function eventsFor(streamId: string): Promise<LedgerEvent[]> {
  const res = await env.TENANT_A_DB.prepare("SELECT * FROM events WHERE stream_id = ? ORDER BY seq").bind(streamId).all();
  return (res.results as Record<string, string | number | null>[]).map((r) => rowToEvent(r));
}

async function slotClaimCount(facilityId: string, slot: string, serviceDate = SERVICE_DATE): Promise<number> {
  const row = await env.TENANT_A_DB.prepare(
    "SELECT COUNT(*) AS n FROM legs WHERE facility_id = ? AND appt_slot_key = ? AND appt_service_date = ?",
  )
    .bind(facilityId, slot, serviceDate)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function legSlot(shipmentId: string, kind = "pickup"): Promise<string | null> {
  const row = await env.TENANT_A_DB.prepare("SELECT appt_slot_key FROM legs WHERE shipment_id = ? AND kind = ?")
    .bind(shipmentId, kind)
    .first<{ appt_slot_key: string | null }>();
  return row?.appt_slot_key ?? null;
}

beforeAll(async () => {
  await ensureSchema(env);
});

// ─── (A) THE atomic double-book proof: simultaneous, direct DO stubs ──────────────────────────────────
describe("(A) double-book is atomically impossible under simultaneous claims (REQ-028/052)", () => {
  it("two streams racing the same slot → exactly ONE commits; the leg is claimed exactly ONCE", async () => {
    const fac = "fac-appt-race";
    await seedFac(fac);
    const a = "appt-race-a";
    const b = "appt-race-b";
    await seedShipment(a);
    await seedShipment(b);
    await seedLeg(a, 0, "pickup", null); // the skeleton leg each appointment.set claims (appt_* NULL)
    await seedLeg(b, 0, "pickup", null);

    const sa = `s:${a}`;
    const sb = `s:${b}`;
    const results = await Promise.allSettled([
      stubFor(sa).append({ tenant: TENANT, streamId: sa, input: apptInput(a, fac) }),
      stubFor(sb).append({ tenant: TENANT, streamId: sb, input: apptInput(b, fac) }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1); // exactly one winner
    expect(rejected).toHaveLength(1); // exactly one loser
    const reason = String((rejected[0] as PromiseRejectedResult).reason);
    expect(reason).toMatch(/VALIDATION_FAILED/);
    expect(reason).toMatch(/slot_taken/);

    // THE literal "double-book impossible" assertion: the (facility, slot, service_date) is claimed once.
    expect(await slotClaimCount(fac, AM)).toBe(1);

    // The loser's stream is untouched (a refusal never half-writes); the winner's chain verifies.
    const winnerIsA = results[0]?.status === "fulfilled";
    const winner = winnerIsA ? a : b;
    const loser = winnerIsA ? b : a;
    expect(await countEvents(loser)).toBe(0);
    expect(await countEvents(winner)).toBe(1);
    expect((await verifyChain(await eventsFor(`s:${winner}`))).ok).toBe(true);
  });
});

// ─── (B) the negative gate over the REAL route: each reason → 400 + ZERO append ───────────────────────
describe("(B) the capacity gate refuses over the API path (REQ-030), never half-writes", () => {
  it("A claims the slot (201); a SECOND shipment claiming the same slot/date → 400 slot_taken, zero append", async () => {
    const fac = "fac-appt-gate";
    await seedFac(fac);
    const a = "appt-gate-a";
    const b = "appt-gate-b";
    await seedShipment(a);
    await seedShipment(b);
    await seedLeg(a, 0, "pickup", null);
    await seedLeg(b, 0, "pickup", null);
    const ops = await opsTok();

    expect((await post(a, apptInput(a, fac), ops)).status).toBe(201);
    const before = await countEvents(b);
    const blocked = await post(b, apptInput(b, fac), ops);
    expect(blocked.status).toBe(400);
    expect(blocked.json?.code).toBe("VALIDATION_FAILED");
    expect(await countEvents(b)).toBe(before); // a refusal appends nothing
    expect(await slotClaimCount(fac, AM)).toBe(1); // still claimed exactly once
  });

  it("slot_not_in_capacity → 400 + zero append", async () => {
    const fac = "fac-appt-negs";
    await seedFac(fac);
    const s = "appt-bad-slot";
    await seedShipment(s);
    await seedLeg(s, 0, "pickup", null);
    const r = await post(s, apptInput(s, fac, {}, { slot_key: "no-such-slot" }), await opsTok());
    expect(r.status).toBe(400);
    expect(await countEvents(s)).toBe(0);
  });

  it("window_mismatch (start not on the slot's minute-of-day) → 400 + zero append", async () => {
    const fac = "fac-appt-negs";
    await seedFac(fac);
    const s = "appt-bad-window";
    await seedShipment(s);
    await seedLeg(s, 0, "pickup", null);
    // AM_START + 1h = 09:00 local (minute 540 != the slot's 480).
    const r = await post(s, apptInput(s, fac, {}, { window_start_ts: AM_START + 3_600_000, window_end_ts: AM_END }), await opsTok());
    expect(r.status).toBe(400);
    expect(await countEvents(s)).toBe(0);
  });

  it("outside_hours (slot on a day the facility is closed) → 400 + zero append", async () => {
    // A facility whose only defined hours are Monday, but which offers a Wednesday slot: the slot exists and
    // the window aligns, yet the day is closed → outside_hours (reason 4), not window_mismatch.
    await seedFacility(env.TENANT_A_DB, {
      id: "fac-closed-wed",
      kind: "dock",
      hours: { tz: LA, weekly: { "1": [{ open_min: 480, close_min: 1020 }] } },
      capacity_slots: [{ slot_key: "wed-am", window_start_min: 480, window_end_min: 720, dow: 3 }],
      appointment_rules: {},
    });
    const wed = nextLocalDow(3, 3);
    const wStart = zonedTimeToEpoch(wed.y, wed.mo, wed.d, 480, LA);
    const wEnd = zonedTimeToEpoch(wed.y, wed.mo, wed.d, 720, LA);
    const s = "appt-closed-day";
    await seedShipment(s);
    await seedLeg(s, 0, "pickup", null);
    const r = await post(s, apptInput(s, "fac-closed-wed", {}, { facility_id: "fac-closed-wed", slot_key: "wed-am", window_start_ts: wStart, window_end_ts: wEnd }), await opsTok());
    expect(r.status).toBe(400);
    expect(await countEvents(s)).toBe(0);
  });

  it("rule_violation (beyond the booking horizon) → 400 + zero append", async () => {
    const fac = "fac-appt-negs";
    await seedFac(fac);
    // A Monday >= now + 15 days is past TEST_FACILITY's 14-day horizon (every other rule passes).
    const farMon = nextLocalDow(1, 15);
    const fStart = zonedTimeToEpoch(farMon.y, farMon.mo, farMon.d, 480, LA);
    const fEnd = zonedTimeToEpoch(farMon.y, farMon.mo, farMon.d, 720, LA);
    const s = "appt-horizon";
    await seedShipment(s);
    await seedLeg(s, 0, "pickup", null);
    const r = await post(s, apptInput(s, fac, {}, { window_start_ts: fStart, window_end_ts: fEnd }), await opsTok());
    expect(r.status).toBe(400);
    expect(await countEvents(s)).toBe(0);
  });

  it("leg_not_materialized (no matching leg) → 400 + zero append — fail-closed, not a silent no-op", async () => {
    const fac = "fac-appt-noleg";
    await seedFac(fac);
    const s = "appt-no-leg";
    await seedShipment(s); // deliberately NO pickup leg
    const r = await post(s, apptInput(s, fac), await opsTok());
    expect(r.status).toBe(400);
    expect(await countEvents(s)).toBe(0);
  });
});

// ─── (C) reschedule frees the old slot; a bad ref is rejected; both events are retained (append-only) ──
describe("(C) reschedule is a new event that atomically moves the claim (REQ-028/052, I3/I7)", () => {
  it("A: mon-am → mon-pm frees mon-am for another stream; a bogus ref is 400; both A events are kept", async () => {
    const fac = "fac-appt-resched";
    await seedFac(fac);
    const a = "appt-resched-a";
    await seedShipment(a);
    await seedLeg(a, 0, "pickup", null);
    const ops = await opsTok();

    const first = await post(a, apptInput(a, fac), ops); // claim mon-am
    expect(first.status).toBe(201);
    const e1 = String(first.json?.id);
    expect(await legSlot(a)).toBe(AM);

    // reschedule to mon-pm, referencing E1 — a NEW event (append-only), overwriting the occurrence columns.
    const resched = await post(
      a,
      apptInput(a, fac, {}, { slot_key: PM, window_start_ts: PM_START, window_end_ts: PM_END, reschedule_of: e1 }),
      ops,
    );
    expect(resched.status).toBe(201);
    expect(await legSlot(a)).toBe(PM); // the leg now holds mon-pm
    expect(await slotClaimCount(fac, AM)).toBe(0); // mon-am is freed
    expect(await slotClaimCount(fac, PM)).toBe(1);

    // PROOF the vacated slot is claimable: a NEW shipment takes mon-am on the same date.
    const c = "appt-resched-c";
    await seedShipment(c);
    await seedLeg(c, 0, "pickup", null);
    expect((await post(c, apptInput(c, fac), ops)).status).toBe(201);
    expect(await slotClaimCount(fac, AM)).toBe(1);

    // a reschedule referencing a non-existent prior appointment → 400 bad_reschedule_ref, nothing appended.
    const beforeBad = await countEvents(a);
    const bad = await post(
      a,
      apptInput(a, fac, {}, { slot_key: PM, window_start_ts: PM_START, window_end_ts: PM_END, reschedule_of: crypto.randomUUID() }),
      ops,
    );
    expect(bad.status).toBe(400);
    expect(await countEvents(a)).toBe(beforeBad);

    // append-only: both of A's appointment.set events (the claim + the reschedule) are retained.
    expect(await countEvents(a)).toBe(2);
  });
});

// ─── (D) the PRODUCTION leg-materialization path booking.created → two skeleton legs (T5→T4 coupling) ──
describe("(D) booking.created materializes the pickup + delivery skeleton legs the claim UPDATEs", () => {
  it("a fresh booking.created creates exactly two legs (pickup seq 0, delivery seq 1), appt_* NULL", async () => {
    const id = "bk-legs-1";
    const booking = {
      id: crypto.randomUUID(),
      shipment_id: id,
      ts: 1_720_000_000_000,
      actor: { party: "party-shipper" },
      party_refs: [],
      evidence: [],
      source: "native",
      confidence: 10_000,
      kind: "booking.created",
      payload: {
        quote_event_id: "evt-quote-1",
        shipper_party_id: "party-shipper",
        consignee_party_id: "party-consignee",
        bill_to_party_id: "party-bill-to",
        division: "main",
      },
    };
    expect((await post(id, booking, await opsTok())).status).toBe(201);

    const legs = await env.TENANT_A_DB.prepare(
      "SELECT id, seq, kind, executor_party_id, appt_slot_key FROM legs WHERE shipment_id = ? ORDER BY seq",
    )
      .bind(id)
      .all<{ id: string; seq: number; kind: string; executor_party_id: string; appt_slot_key: string | null }>();
    expect(legs.results).toEqual([
      { id: `${id}:pickup`, seq: 0, kind: "pickup", executor_party_id: "party-bill-to", appt_slot_key: null },
      { id: `${id}:delivery`, seq: 1, kind: "delivery", executor_party_id: "party-bill-to", appt_slot_key: null },
    ]);
  });
});
