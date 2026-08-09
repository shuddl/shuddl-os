// REQ-028/052 (WP-08 T5) — PURE unit tests for the appointment.set (dock-slot) gate. Like the other
// transition gates, assertAppointment is a pure decision over (prior events, incoming event, a
// server-sourced context): no D1, no Date. The DO (Task 5) computes the tz-local context and calls this
// before it appends. Here we prove each block reason IN ORDER, that a valid claim passes, and that a REQ-049
// override waives ONLY soft policy (hours / lead-time / horizon / same-day) — never facility/slot existence,
// window alignment, leg existence, the reschedule ref, or occupancy (the DB index is the real double-book arbiter).
import { describe, expect, it } from "vitest";
import { eventFixture, type LedgerEvent } from "@shuddl/contracts";
import {
  assertAppointment,
  GateValidationError,
  type AppointmentCtx,
  type AppointmentFacility,
  type Override,
} from "../src/gates/transition-gates.js";

const DAY = 86_400_000;
const OK_OVERRIDE: Override = { by: "dispatcher-42", reason: "receiver waiting; booked over hours by phone" };

// A facility: Monday 08:00–17:00, ONE capacity-1 Monday-AM slot (min 480..720, dow 1). Rules: 120-min lead,
// 14-day horizon, no same-day.
const FAC: AppointmentFacility = {
  capacity_slots: [{ slot_key: "s1", window_start_min: 480, window_end_min: 720, dow: 1 }],
  hours: { tz: "America/Los_Angeles", weekly: { "1": [{ open_min: 480, close_min: 1020 }] } },
  appointment_rules: { lead_time_min: 120, max_horizon_days: 14, allow_same_day: false },
};

// window_start_ts is 3 days out; now = 0 → lead (3d ≫ 120min) + horizon (3d ≤ 14d) + not-same-day all hold.
const WINDOW_START = 3 * DAY;
function apptEvent(payloadOver: Record<string, unknown> = {}): LedgerEvent {
  return eventFixture("appointment.set", {
    payload: { leg_kind: "pickup", facility_id: "fac", slot_key: "s1", window_start_ts: WINDOW_START, window_end_ts: WINDOW_START + 4 * 3_600_000, ...payloadOver },
  });
}

// A valid context: everything aligned so the gate passes; each test perturbs ONE field to trigger one reason.
function ctx(over: Partial<AppointmentCtx> = {}): AppointmentCtx {
  return {
    facility: FAC,
    serviceDate: "2026-08-10", // != nowServiceDate → not same-day
    localMinuteOfDay: 480, // == slot.window_start_min
    localWindowEndMinute: 720, // == slot.window_end_min
    localDow: 1, // == slot.dow (Monday)
    now: 0,
    nowServiceDate: "2026-08-03",
    legExists: true,
    occupied: false,
    ...over,
  };
}

describe("assertAppointment — a fully-aligned claim passes", () => {
  it("does not throw when facility/slot/window/leg all line up and the slot is free", () => {
    expect(() => assertAppointment([], apptEvent(), ctx())).not.toThrow();
  });
});

describe("assertAppointment — block reasons, in order", () => {
  it("1 unknown_facility when the facility did not resolve", () => {
    expect(() => assertAppointment([], apptEvent(), ctx({ facility: null }))).toThrow(/unknown_facility/);
  });
  it("2 slot_not_in_capacity when slot_key is not a capacity slot", () => {
    expect(() => assertAppointment([], apptEvent({ slot_key: "nope" }), ctx())).toThrow(/slot_not_in_capacity/);
  });
  it("3 window_mismatch when the local minute-of-day differs from the slot template", () => {
    expect(() => assertAppointment([], apptEvent(), ctx({ localMinuteOfDay: 500 }))).toThrow(/window_mismatch/);
  });
  it("3 window_mismatch when the local day-of-week differs from a dow-pinned slot", () => {
    expect(() => assertAppointment([], apptEvent(), ctx({ localDow: 2 }))).toThrow(/window_mismatch/);
  });
  it("3 window_mismatch when the window END minute-of-day differs from the slot (an aligned start alone is not enough)", () => {
    expect(() => assertAppointment([], apptEvent(), ctx({ localWindowEndMinute: 700 }))).toThrow(/window_mismatch/);
  });
  it("4 outside_hours when no open interval contains the slot window", () => {
    const closedMon: AppointmentFacility = { ...FAC, hours: { tz: FAC.hours.tz, weekly: { "1": [{ open_min: 600, close_min: 1020 }] } } };
    expect(() => assertAppointment([], apptEvent(), ctx({ facility: closedMon }))).toThrow(/outside_hours/);
  });
  // Audit §144 — THE CLOSE BOUNDARY. Rule 4 is `iv.open_min <= start && iv.close_min >= end`, and the
  // default fixture already sits exactly ON the open boundary (open_min 480 === window_start_min 480), so a
  // `<=` -> `<` mutation there fails nine tests. Nothing sat on the CLOSE boundary — close_min 1020 is far
  // above window_end_min 720 — so `>=` -> `>` passed the whole 610-test suite. A facility that closes at
  // exactly the moment the window ends IS open for that slot; without this, that inclusivity was unpinned.
  it("4 a facility closing EXACTLY when the window ends is still open for that slot (>= boundary)", () => {
    const closesAtWindowEnd: AppointmentFacility = {
      ...FAC,
      hours: { tz: FAC.hours.tz, weekly: { "1": [{ open_min: 480, close_min: 720 }] } },
    };
    expect(() => assertAppointment([], apptEvent(), ctx({ facility: closesAtWindowEnd }))).not.toThrow();
  });

  it("5 rule_violation when inside the lead-time window", () => {
    // now only 60 min before the window (< the 120-min lead).
    expect(() => assertAppointment([], apptEvent(), ctx({ now: WINDOW_START - 60 * 60_000 }))).toThrow(/rule_violation/);
  });
  it("5 rule_violation beyond the booking horizon", () => {
    const far: AppointmentFacility = { ...FAC, appointment_rules: { max_horizon_days: 1 } };
    expect(() => assertAppointment([], apptEvent(), ctx({ facility: far }))).toThrow(/rule_violation/); // 3d > 1d horizon
  });
  it("5 rule_violation for a same-day booking without allow_same_day", () => {
    expect(() => assertAppointment([], apptEvent(), ctx({ nowServiceDate: "2026-08-10" }))).toThrow(/rule_violation/);
  });
  it("6 leg_not_materialized when no leg matches (shipment_id, leg_kind) — FAIL-CLOSED", () => {
    expect(() => assertAppointment([], apptEvent(), ctx({ legExists: false }))).toThrow(/leg_not_materialized/);
  });
  it("8 slot_taken when another stream already holds the slot", () => {
    expect(() => assertAppointment([], apptEvent(), ctx({ occupied: true }))).toThrow(/slot_taken/);
  });
  it("every reason is a VALIDATION_FAILED envelope (a conflict, not a GATE_BLOCKED evidence miss)", () => {
    try {
      assertAppointment([], apptEvent(), ctx({ occupied: true }));
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(GateValidationError);
      expect((e as Error).message).toContain("VALIDATION_FAILED");
      expect((e as Error).message).not.toContain("GATE_BLOCKED");
    }
  });
});

describe("assertAppointment — reschedule reference (reason 7)", () => {
  const RESCHEDULE_ID = "00000000-0000-4000-8000-0000000000e1";
  const priorApptPickup = (): LedgerEvent => eventFixture("appointment.set", { id: RESCHEDULE_ID, payload: { leg_kind: "pickup", facility_id: "fac", slot_key: "s0", window_start_ts: 10, window_end_ts: 20 } });

  it("passes when reschedule_of names a real prior appointment.set for the SAME leg_kind", () => {
    expect(() => assertAppointment([priorApptPickup()], apptEvent({ reschedule_of: RESCHEDULE_ID }), ctx())).not.toThrow();
  });
  it("bad_reschedule_ref when reschedule_of names no prior appointment.set", () => {
    expect(() => assertAppointment([], apptEvent({ reschedule_of: RESCHEDULE_ID }), ctx())).toThrow(/bad_reschedule_ref/);
  });
  it("bad_reschedule_ref when the referenced appointment is for a DIFFERENT leg_kind", () => {
    const priorDelivery = eventFixture("appointment.set", { id: RESCHEDULE_ID, payload: { leg_kind: "delivery", facility_id: "fac", slot_key: "s0", window_start_ts: 10, window_end_ts: 20 } });
    expect(() => assertAppointment([priorDelivery], apptEvent({ reschedule_of: RESCHEDULE_ID }), ctx())).toThrow(/bad_reschedule_ref/);
  });
});

describe("assertAppointment — a REQ-049 override waives soft policy ONLY", () => {
  it("waives outside_hours", () => {
    const closedMon: AppointmentFacility = { ...FAC, hours: { tz: FAC.hours.tz, weekly: { "1": [{ open_min: 600, close_min: 1020 }] } } };
    expect(() => assertAppointment([], apptEvent(), ctx({ facility: closedMon, override: OK_OVERRIDE }))).not.toThrow();
  });
  it("waives rule_violation (lead-time)", () => {
    expect(() => assertAppointment([], apptEvent(), ctx({ now: WINDOW_START - 60 * 60_000, override: OK_OVERRIDE }))).not.toThrow();
  });
  it("does NOT waive slot_taken — the slot is physically claimed", () => {
    expect(() => assertAppointment([], apptEvent(), ctx({ occupied: true, override: OK_OVERRIDE }))).toThrow(/slot_taken/);
  });
  it("does NOT waive leg_not_materialized — there is nothing to claim", () => {
    expect(() => assertAppointment([], apptEvent(), ctx({ legExists: false, override: OK_OVERRIDE }))).toThrow(/leg_not_materialized/);
  });
  it("does NOT waive unknown_facility / slot_not_in_capacity / window_mismatch", () => {
    expect(() => assertAppointment([], apptEvent(), ctx({ facility: null, override: OK_OVERRIDE }))).toThrow(/unknown_facility/);
    expect(() => assertAppointment([], apptEvent({ slot_key: "nope" }), ctx({ override: OK_OVERRIDE }))).toThrow(/slot_not_in_capacity/);
    expect(() => assertAppointment([], apptEvent(), ctx({ localMinuteOfDay: 500, override: OK_OVERRIDE }))).toThrow(/window_mismatch/);
  });
  it("a blank/unaccountable override is itself a VALIDATION_FAILED (never a silent pass)", () => {
    expect(() => assertAppointment([], apptEvent(), ctx({ override: { by: "  ", reason: "" } }))).toThrow(/VALIDATION_FAILED/);
  });
});

// REQ-030 §739 — THE ABSENT-DAY DEFAULT, PINNED. `assertAppointment` reads the day's intervals as
// `ctx.facility.hours.weekly[String(ctx.localDow)] ?? []`, and the `?? []` IS the guarantee: a facility with no
// entry for that weekday is CLOSED, not unconstrained. The code says so ("absent day = closed") and the
// behaviour was correct — but MUTATION-MEASURED as unpinned: replacing the default with an all-day interval
// (absent day ⇒ 00:00–24:00 open) left this suite at 23/23 GREEN. Correct-but-unpinned is one edit from
// correct-no-longer, and this is the server-side booking gate (REQ-030: any flow reachable by API enforces it).
//
// Every other test here perturbs a field that fails EARLIER (a mismatched localDow throws window_mismatch), so
// the absent-day branch was never reached. That is why the corpus missed it, and why the fixture below keeps
// slot.dow and localDow ALIGNED while emptying the weekly map.
describe("REQ-030 §739: a facility with no hours for the slot's weekday is CLOSED, not unconstrained", () => {
  it("empty weekly map ⇒ outside_hours (the `?? []` default is a floor, not a formality)", () => {
    const noHours: AppointmentFacility = { ...FAC, hours: { ...FAC.hours, weekly: {} } };
    expect(() => assertAppointment([], apptEvent(), ctx({ facility: noHours }))).toThrow(/outside_hours/);
  });

  it("weekly map present but MISSING this weekday ⇒ outside_hours", () => {
    // Tuesday-only hours, Monday slot: the lookup misses and must close, not fall through to "no constraint".
    const tueOnly: AppointmentFacility = { ...FAC, hours: { ...FAC.hours, weekly: { "2": [{ open_min: 0, close_min: 1440 }] } } };
    expect(() => assertAppointment([], apptEvent(), ctx({ facility: tueOnly }))).toThrow(/outside_hours/);
  });

  it("and the SAME absent-day facility still passes under a named override (soft policy, REQ-049)", () => {
    // Non-vacuity for the two above: they must fail because the day is CLOSED, not because an empty `weekly`
    // map breaks the fixture in some way that would throw regardless. Hours are SOFT policy (REQ-049), so a
    // named override waives them — and the override travels on the CTX, not the payload.
    //
    // Distinct from the existing "waives outside_hours" case above, which uses a facility whose Monday hours
    // are PRESENT but too narrow: that exercises the interval comparison, never the `?? []` default.
    const noHours: AppointmentFacility = { ...FAC, hours: { ...FAC.hours, weekly: {} } };
    expect(() => assertAppointment([], apptEvent(), ctx({ facility: noHours, override: OK_OVERRIDE }))).not.toThrow();
  });
});

