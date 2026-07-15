import { describe, expect, it } from "vitest";
import {
  CreditCheckedPayload,
  BookingCreatedPayload,
  AppointmentSetPayload,
  PickupScheduledPayload,
  DispatchAssignedPayload,
  EVENT_KINDS,
  LedgerEvent,
  EventInput,
  eventFixture,
} from "../src/index.js";

// WP-08 Scheduler/Booking (REQ-028/042/043/047/052/057): the five booking/scheduler kinds carry PROPER
// typed payloads so the Scheduler + Booking agents can move credit / party-corrections / windows / dispatch
// through the append-only ledger. This TYPES five EXISTING kinds — no kind is added (a test below re-pins
// .length === 35). Mirrors WP-07's typing of the comms kinds (comms.test.ts).

// A minimal valid EventInput envelope (the client-suppliable subset); source "native" is the internal leg.
const INPUT_BASE = {
  id: "00000000-0000-4000-8000-0000000000bb",
  ts: 1_720_000_000_000,
  actor: { party: "party-broker" },
  party_refs: [] as string[],
  evidence: [] as never[],
  source: "native" as const,
  confidence: 10_000,
};

// The five kinds this task types.
const TYPED_BOOKING_KINDS = [
  "credit.checked",
  "booking.created",
  "appointment.set",
  "pickup.scheduled",
  "dispatch.assigned",
] as const;

describe("REQ-028/042: typing the booking/scheduler kinds adds NO kind (the 35-catalog holds)", () => {
  it("EVENT_KINDS.length is still exactly 35", () => expect(EVENT_KINDS.length).toBe(35));
});

describe("REQ-042: CreditCheckedPayload (party credit decision → status + optional limit)", () => {
  const valid = { party_id: "party-bill-to", status: "clear" };
  it("accepts a minimal credit check", () => {
    expect(CreditCheckedPayload.parse(valid).status).toBe("clear");
  });
  it("accepts the optional limit_cents + decided_by + ref", () => {
    const p = CreditCheckedPayload.parse({ ...valid, status: "hold", limit_cents: 500_000, decided_by: "ops-lead", ref: "cr-1" });
    expect(p.limit_cents).toBe(500_000);
    expect(p.decided_by).toBe("ops-lead");
  });
  it("rejects a missing party_id (required)", () => {
    const { party_id: _drop, ...rest } = valid;
    expect(() => CreditCheckedPayload.parse(rest)).toThrow();
  });
  it("rejects an empty party_id (min 1)", () => {
    expect(() => CreditCheckedPayload.parse({ ...valid, party_id: "" })).toThrow();
  });
  it("rejects a status outside the enum", () => {
    expect(() => CreditCheckedPayload.parse({ ...valid, status: "denied" })).toThrow();
  });
  it("rejects a FLOAT limit_cents (integer canonical law)", () => {
    expect(() => CreditCheckedPayload.parse({ ...valid, limit_cents: 12.5 })).toThrow();
  });
  it("rejects a NEGATIVE limit_cents (a credit limit is a non-negative ceiling; kills a Cents→unbounded mutation)", () => {
    expect(() => CreditCheckedPayload.parse({ ...valid, limit_cents: -1 })).toThrow();
  });
  it("accepts limit_cents === 0 (a zero ceiling is a real hold-to-prepaid decision)", () => {
    expect(CreditCheckedPayload.parse({ ...valid, status: "hold", limit_cents: 0 }).limit_cents).toBe(0);
  });
  it("rejects an empty-string decided_by / ref (present ⇒ non-empty)", () => {
    expect(() => CreditCheckedPayload.parse({ ...valid, decided_by: "" })).toThrow();
    expect(() => CreditCheckedPayload.parse({ ...valid, ref: "" })).toThrow();
  });
  it("rejects an unknown extra key (.strict)", () => {
    expect(() => CreditCheckedPayload.parse({ ...valid, score: 720 })).toThrow();
  });
});

describe("REQ-057: BookingCreatedPayload (the party-correction source — REAL consignee/bill_to + quote anchor)", () => {
  const valid = {
    quote_event_id: "evt-quote-1",
    shipper_party_id: "party-shipper",
    consignee_party_id: "party-consignee",
    bill_to_party_id: "party-bill-to",
    division: "main",
  };
  it("accepts a minimal booking", () => {
    expect(BookingCreatedPayload.parse(valid).consignee_party_id).toBe("party-consignee");
  });
  it("accepts the optional mode + service + bill_terms", () => {
    const p = BookingCreatedPayload.parse({ ...valid, mode: "LTL", service: "standard", bill_terms: "prepaid" });
    expect(p.mode).toBe("LTL");
    expect(p.bill_terms).toBe("prepaid");
  });
  it("rejects a booking missing a required party FK (consignee_party_id)", () => {
    const { consignee_party_id: _drop, ...rest } = valid;
    expect(() => BookingCreatedPayload.parse(rest)).toThrow();
  });
  it("rejects a booking missing bill_to_party_id (required FK)", () => {
    const { bill_to_party_id: _drop, ...rest } = valid;
    expect(() => BookingCreatedPayload.parse(rest)).toThrow();
  });
  it("rejects a missing quote_event_id (the accepted-quote anchor is required)", () => {
    const { quote_event_id: _drop, ...rest } = valid;
    expect(() => BookingCreatedPayload.parse(rest)).toThrow();
  });
  it("rejects an empty-string division / party FK (min 1)", () => {
    expect(() => BookingCreatedPayload.parse({ ...valid, division: "" })).toThrow();
    expect(() => BookingCreatedPayload.parse({ ...valid, shipper_party_id: "" })).toThrow();
  });
  it("rejects a mode / bill_terms outside the enum", () => {
    expect(() => BookingCreatedPayload.parse({ ...valid, mode: "air" })).toThrow();
    expect(() => BookingCreatedPayload.parse({ ...valid, bill_terms: "cod" })).toThrow();
  });
  it("rejects an unknown extra key (.strict — e.g. the legacy created_ts)", () => {
    expect(() => BookingCreatedPayload.parse({ ...valid, created_ts: 1_720_000_000_000 })).toThrow();
  });
});

describe("REQ-028/052: AppointmentSetPayload (a facility slot window; a reschedule is a NEW event)", () => {
  const valid = {
    leg_kind: "pickup",
    facility_id: "fac-1",
    slot_key: "2024-07-03T14:00Z",
    window_start_ts: 1_720_000_000_000,
    window_end_ts: 1_720_003_600_000,
  };
  it("accepts a minimal appointment", () => {
    expect(AppointmentSetPayload.parse(valid).leg_kind).toBe("pickup");
  });
  it("accepts the optional reschedule_of (names the prior appointment.set event)", () => {
    expect(AppointmentSetPayload.parse({ ...valid, reschedule_of: "evt-appt-1" }).reschedule_of).toBe("evt-appt-1");
  });
  it("rejects a leg_kind outside the enum", () => {
    expect(() => AppointmentSetPayload.parse({ ...valid, leg_kind: "return" })).toThrow();
  });
  it("rejects a missing facility_id / slot_key (required)", () => {
    const { facility_id: _drop, ...rest } = valid;
    expect(() => AppointmentSetPayload.parse(rest)).toThrow();
  });
  it("rejects an empty-string reschedule_of (present ⇒ non-empty)", () => {
    expect(() => AppointmentSetPayload.parse({ ...valid, reschedule_of: "" })).toThrow();
  });
  it("rejects a FLOAT window_start_ts (integer canonical law on a ts field)", () => {
    expect(() => AppointmentSetPayload.parse({ ...valid, window_start_ts: 1_720_000_000_000.5 })).toThrow();
  });
  it("rejects a FLOAT window_end_ts (integer canonical law)", () => {
    expect(() => AppointmentSetPayload.parse({ ...valid, window_end_ts: 1.5 })).toThrow();
  });
  it("rejects an INVERTED window (window_end_ts < window_start_ts)", () => {
    expect(() => AppointmentSetPayload.parse({ ...valid, window_start_ts: 1_720_003_600_000, window_end_ts: 1_720_000_000_000 })).toThrow();
  });
  it("accepts a zero-length window (window_end_ts === window_start_ts)", () => {
    expect(AppointmentSetPayload.parse({ ...valid, window_start_ts: 1_720_000_000_000, window_end_ts: 1_720_000_000_000 }).window_end_ts).toBe(1_720_000_000_000);
  });
  it("rejects an unknown extra key (.strict)", () => {
    expect(() => AppointmentSetPayload.parse({ ...valid, dock: "D3" })).toThrow();
  });
});

describe("REQ-028: PickupScheduledPayload (facility + window)", () => {
  const valid = { facility_id: "fac-1", window_start_ts: 1_720_000_000_000, window_end_ts: 1_720_003_600_000 };
  it("accepts a minimal pickup schedule", () => {
    expect(PickupScheduledPayload.parse(valid).facility_id).toBe("fac-1");
  });
  it("rejects a missing facility_id", () => {
    const { facility_id: _drop, ...rest } = valid;
    expect(() => PickupScheduledPayload.parse(rest)).toThrow();
  });
  it("rejects an empty facility_id (min 1)", () => {
    expect(() => PickupScheduledPayload.parse({ ...valid, facility_id: "" })).toThrow();
  });
  it("rejects a FLOAT window_start_ts (integer canonical law on a ts field)", () => {
    expect(() => PickupScheduledPayload.parse({ ...valid, window_start_ts: 12.5 })).toThrow();
  });
  it("rejects an INVERTED window (window_end_ts < window_start_ts)", () => {
    expect(() => PickupScheduledPayload.parse({ ...valid, window_start_ts: 1_720_003_600_000, window_end_ts: 1_720_000_000_000 })).toThrow();
  });
  it("rejects an unknown extra key (.strict)", () => {
    expect(() => PickupScheduledPayload.parse({ ...valid, notify: true })).toThrow();
  });
});

describe("REQ-043: DispatchAssignedPayload (driver + optional asset + legs)", () => {
  const valid = { driver_user_id: "user-driver" };
  it("accepts a minimal dispatch", () => {
    expect(DispatchAssignedPayload.parse(valid).driver_user_id).toBe("user-driver");
  });
  it("accepts the optional asset_id + legs", () => {
    const p = DispatchAssignedPayload.parse({ ...valid, asset_id: "trk-7", legs: ["leg-1", "leg-2"] });
    expect(p.asset_id).toBe("trk-7");
    expect(p.legs).toEqual(["leg-1", "leg-2"]);
  });
  it("rejects a missing driver_user_id (required)", () => {
    expect(() => DispatchAssignedPayload.parse({})).toThrow();
  });
  it("rejects an empty driver_user_id (min 1)", () => {
    expect(() => DispatchAssignedPayload.parse({ ...valid, driver_user_id: "" })).toThrow();
  });
  it("rejects an empty-string leg entry (each leg is a non-empty ref)", () => {
    expect(() => DispatchAssignedPayload.parse({ ...valid, legs: ["leg-1", ""] })).toThrow();
  });
  it("rejects an empty-string asset_id (present ⇒ non-empty)", () => {
    expect(() => DispatchAssignedPayload.parse({ ...valid, asset_id: "" })).toThrow();
  });
  it("rejects an unknown extra key (.strict)", () => {
    expect(() => DispatchAssignedPayload.parse({ ...valid, trailer: "trl-1" })).toThrow();
  });
});

// ─── Union wiring — kind narrows payload in BOTH LedgerEvent and EventInput, and a full event survives a
// JSON round-trip through LedgerEvent.parse with field integrity intact (the frozen-byte hash pin lives in
// packages/ledger roundtrip.test.ts.snap). ────────────────────────────────────────────────────────────────
describe("union wiring: the five booking kinds narrow to their typed payload", () => {
  it("LedgerEvent.parse round-trips each typed booking kind and preserves every field across a JSON trip", () => {
    for (const kind of TYPED_BOOKING_KINDS) {
      const f = eventFixture(kind);
      const parsed = LedgerEvent.parse(JSON.parse(JSON.stringify(f)) as unknown);
      expect(parsed.kind).toBe(kind);
      expect(parsed).toEqual(f);
    }
  });
  it("LedgerEvent REJECTS a typed booking kind carrying the old loose {} payload", () => {
    for (const kind of TYPED_BOOKING_KINDS) {
      expect(() => LedgerEvent.parse({ ...eventFixture(kind), payload: {} })).toThrow();
    }
  });
  it("EventInput.parse accepts each typed booking kind's payload", () => {
    const payloads: Record<(typeof TYPED_BOOKING_KINDS)[number], Record<string, unknown>> = {
      "credit.checked": { party_id: "party-bill-to", status: "clear" },
      "booking.created": {
        quote_event_id: "evt-q-1",
        shipper_party_id: "party-shipper",
        consignee_party_id: "party-consignee",
        bill_to_party_id: "party-bill-to",
        division: "main",
      },
      "appointment.set": {
        leg_kind: "pickup",
        facility_id: "fac-1",
        slot_key: "s-1",
        window_start_ts: 1_720_000_000_000,
        window_end_ts: 1_720_003_600_000,
      },
      "pickup.scheduled": { facility_id: "fac-1", window_start_ts: 1_720_000_000_000, window_end_ts: 1_720_003_600_000 },
      "dispatch.assigned": { driver_user_id: "user-driver" },
    };
    for (const kind of TYPED_BOOKING_KINDS) {
      expect(EventInput.parse({ ...INPUT_BASE, kind, payload: payloads[kind] }).kind).toBe(kind);
    }
  });
  it("EventInput REJECTS a typed booking kind carrying an empty payload", () => {
    for (const kind of TYPED_BOOKING_KINDS) {
      expect(() => EventInput.parse({ ...INPUT_BASE, kind, payload: {} })).toThrow();
    }
  });
});
