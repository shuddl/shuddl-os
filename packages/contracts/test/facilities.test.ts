import { describe, expect, it } from "vitest";
import {
  FacilityKind,
  FacilityHours,
  FacilityCapacitySlots,
  FacilityAppointmentRules,
} from "../src/facilities.js";

// WP-08 Scheduler/Booking Task 2 (REQ-052 / REQ-028): the facilities table's three empty-defaulted JSON
// columns (hours '{}', capacity_slots '[]', appointment_rules '{}') get PINNED shapes. This is the capacity
// model T5's double-book prevention + T6/T7's gates consume, so a bad STORED config is load-bearing: every
// invariant (0..1440 minute bounds, end>=start, 0..6 dow, UNIQUE slot_keys) is refined at the boundary and
// must REJECT. Integer-only canonical law (SafeInt): minutes/days are integers, never floats. All .strict().

// ─── FacilityHours: { tz, weekly: Record<"0".."6", [{open_min, close_min}]> } ──────────────────────────────
const hours = {
  tz: "America/Los_Angeles",
  weekly: {
    "1": [{ open_min: 480, close_min: 1020 }], // Mon 08:00–17:00
    "2": [
      { open_min: 480, close_min: 720 }, // Tue split shift 08:00–12:00 …
      { open_min: 780, close_min: 1020 }, // … and 13:00–17:00
    ],
    "0": [], // Sunday closed — a day may have 0 intervals
  },
};

describe("FacilityHours", () => {
  it("round-trips a valid weekly-hours config", () => {
    const p = FacilityHours.parse(hours);
    expect(p.tz).toBe("America/Los_Angeles");
    expect(p.weekly["1"]?.[0]?.open_min).toBe(480);
    expect(p.weekly["2"]).toHaveLength(2);
    expect(p.weekly["0"]).toHaveLength(0); // a closed day is a legal empty array
  });
  it("rejects an unknown top-level key (.strict)", () => {
    expect(() => FacilityHours.parse({ ...hours, holiday: true })).toThrow();
  });
  it("rejects an empty tz (min 1)", () => {
    expect(() => FacilityHours.parse({ ...hours, tz: "" })).toThrow();
  });
  it("rejects a weekly key outside 0..6 (day-of-week)", () => {
    expect(() => FacilityHours.parse({ ...hours, weekly: { "7": [{ open_min: 0, close_min: 60 }] } })).toThrow();
    expect(() => FacilityHours.parse({ ...hours, weekly: { mon: [{ open_min: 0, close_min: 60 }] } })).toThrow();
  });
  it("rejects a minute > 1440 (0..1440 from midnight)", () => {
    expect(() => FacilityHours.parse({ ...hours, weekly: { "1": [{ open_min: 480, close_min: 1441 }] } })).toThrow();
  });
  it("rejects a negative minute (0..1440 bound)", () => {
    expect(() => FacilityHours.parse({ ...hours, weekly: { "1": [{ open_min: -1, close_min: 60 }] } })).toThrow();
  });
  it("rejects a float minute (integer canonical law)", () => {
    expect(() => FacilityHours.parse({ ...hours, weekly: { "1": [{ open_min: 480.5, close_min: 1020 }] } })).toThrow();
  });
  it("rejects an inverted interval (close_min < open_min)", () => {
    expect(() => FacilityHours.parse({ ...hours, weekly: { "1": [{ open_min: 1020, close_min: 480 }] } })).toThrow();
  });
  it("accepts a zero-length interval (close_min === open_min)", () => {
    const p = FacilityHours.parse({ ...hours, weekly: { "1": [{ open_min: 600, close_min: 600 }] } });
    expect(p.weekly["1"]?.[0]?.close_min).toBe(600);
  });
  it("rejects an unknown key inside an interval (.strict)", () => {
    expect(() => FacilityHours.parse({ ...hours, weekly: { "1": [{ open_min: 480, close_min: 1020, dock: "D3" }] } })).toThrow();
  });
});

// ─── FacilityCapacitySlots: [{ slot_key, window_start_min, window_end_min, dow? }] ─────────────────────────
const slots = [
  { slot_key: "mon-am-dock-1", window_start_min: 480, window_end_min: 720, dow: 1 },
  { slot_key: "mon-pm-dock-1", window_start_min: 720, window_end_min: 1020, dow: 1 },
  { slot_key: "any-day-dock-2", window_start_min: 480, window_end_min: 1020 }, // dow optional
];

describe("FacilityCapacitySlots", () => {
  it("round-trips a valid slot array (each slot is one capacity-1 door×window)", () => {
    const p = FacilityCapacitySlots.parse(slots);
    expect(p).toHaveLength(3);
    expect(p[0]?.slot_key).toBe("mon-am-dock-1");
    expect(p[2]?.dow).toBeUndefined();
  });
  it("accepts an empty slot array (a facility with no defined slots)", () => {
    expect(FacilityCapacitySlots.parse([])).toHaveLength(0);
  });
  it("rejects an empty slot_key (min 1 — it is T5's stable claim key)", () => {
    expect(() => FacilityCapacitySlots.parse([{ slot_key: "", window_start_min: 0, window_end_min: 60 }])).toThrow();
  });
  it("rejects an unknown key inside a slot (.strict)", () => {
    expect(() => FacilityCapacitySlots.parse([{ slot_key: "s1", window_start_min: 0, window_end_min: 60, dock: "D3" }])).toThrow();
  });
  it("rejects window_end_min < window_start_min (inverted window)", () => {
    expect(() => FacilityCapacitySlots.parse([{ slot_key: "s1", window_start_min: 720, window_end_min: 480 }])).toThrow();
  });
  it("accepts a zero-length window (window_end_min === window_start_min)", () => {
    expect(FacilityCapacitySlots.parse([{ slot_key: "s1", window_start_min: 600, window_end_min: 600 }])).toHaveLength(1);
  });
  it("rejects a minute > 1440 (0..1440 bound)", () => {
    expect(() => FacilityCapacitySlots.parse([{ slot_key: "s1", window_start_min: 0, window_end_min: 1441 }])).toThrow();
  });
  it("rejects a negative minute (0..1440 bound)", () => {
    expect(() => FacilityCapacitySlots.parse([{ slot_key: "s1", window_start_min: -1, window_end_min: 60 }])).toThrow();
  });
  it("rejects a float minute (integer canonical law)", () => {
    expect(() => FacilityCapacitySlots.parse([{ slot_key: "s1", window_start_min: 0.5, window_end_min: 60 }])).toThrow();
  });
  it("rejects a dow outside 0..6", () => {
    expect(() => FacilityCapacitySlots.parse([{ slot_key: "s1", window_start_min: 0, window_end_min: 60, dow: 7 }])).toThrow();
    expect(() => FacilityCapacitySlots.parse([{ slot_key: "s1", window_start_min: 0, window_end_min: 60, dow: -1 }])).toThrow();
  });
  it("rejects DUPLICATE slot_keys within the array (T5's UNIQUE claim index must never see a dup)", () => {
    expect(() =>
      FacilityCapacitySlots.parse([
        { slot_key: "dup", window_start_min: 0, window_end_min: 60 },
        { slot_key: "dup", window_start_min: 60, window_end_min: 120 },
      ]),
    ).toThrow();
  });
});

// ─── FacilityAppointmentRules: { lead_time_min?, max_horizon_days?, allow_same_day? } ──────────────────────
describe("FacilityAppointmentRules", () => {
  it("round-trips a full rules object", () => {
    const p = FacilityAppointmentRules.parse({ lead_time_min: 120, max_horizon_days: 14, allow_same_day: false });
    expect(p.lead_time_min).toBe(120);
    expect(p.max_horizon_days).toBe(14);
    expect(p.allow_same_day).toBe(false);
  });
  it("accepts an empty rules object (the '{}' default)", () => {
    expect(FacilityAppointmentRules.parse({})).toEqual({});
  });
  it("rejects an unknown key (.strict)", () => {
    expect(() => FacilityAppointmentRules.parse({ buffer_min: 15 })).toThrow();
  });
  it("rejects a negative lead_time_min (>= 0)", () => {
    expect(() => FacilityAppointmentRules.parse({ lead_time_min: -1 })).toThrow();
  });
  it("rejects a negative max_horizon_days (>= 0)", () => {
    expect(() => FacilityAppointmentRules.parse({ max_horizon_days: -1 })).toThrow();
  });
  it("rejects a float lead_time_min (integer canonical law)", () => {
    expect(() => FacilityAppointmentRules.parse({ lead_time_min: 12.5 })).toThrow();
  });
});

describe("FacilityKind", () => {
  it("accepts the three DDL kinds", () => {
    expect(FacilityKind.parse("terminal")).toBe("terminal");
    expect(FacilityKind.parse("dock")).toBe("dock");
    expect(FacilityKind.parse("yard")).toBe("yard");
  });
  it("rejects a kind outside the enum (mirrors the DDL CHECK)", () => {
    expect(() => FacilityKind.parse("garage")).toThrow();
  });
});
