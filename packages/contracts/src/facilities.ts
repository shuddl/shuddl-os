import { z } from "zod";
import { SafeInt } from "./json.js";

// WP-08 Scheduler/Booking Task 2 (REQ-052 / REQ-028): the SHAPES of the facilities table's three
// empty-defaulted JSON columns (doc 10 §1: facilities(hours '{}', capacity_slots '[]', appointment_rules
// '{}')). Until now those columns were UNREAD by any code — greenfield. This module pins them so T5's
// double-book prevention and T6/T7's booking gates read a TYPED capacity model. A malformed STORED config
// is load-bearing (the gate consumes it), so every real invariant is refined AT THE BOUNDARY and must
// REJECT here — never silently degrade downstream. Integer-only canonical law (SafeInt): minutes and days
// are integers, never floats. Every object is .strict() (mirrors rating.ts's ZoneTariff). ZERO tenant data.

// A minute-of-day is an integer 0..1440 from local midnight (1440 = end-of-day boundary). Reused by both
// the weekly-hours intervals and the capacity-slot windows so the bound is defined once.
const MinuteOfDay = SafeInt.min(0).max(1440);

// A day-of-week key "0".."6" (0 = Sunday, ISO-agnostic — the tz lives on FacilityHours.tz). z.record with a
// regex key does NOT require every day present, so an absent day is a closed day (mirrors rating.ts's
// zip_to_zone regex key). A key like "7" or "mon" is rejected.
const DayOfWeekKey = z.string().regex(/^[0-6]$/);

// One open→close interval within a day. close_min >= open_min — an inverted interval is a nonsensical window
// that would sit in the stored config and mislead the scheduler, so it is rejected here (mirrors the T1
// AppointmentSetPayload window refine). A zero-length interval (close === open) is a legal degenerate case.
const HoursInterval = z
  .object({ open_min: MinuteOfDay, close_min: MinuteOfDay })
  .strict()
  .refine((i) => i.close_min >= i.open_min, "close_min must be >= open_min");

// FacilityHours — a facility's weekly operating hours. `tz` is the IANA zone the minute-of-day values are
// interpreted in (the windows are LOCAL, so the tz is required to resolve them to instants). `weekly` maps a
// day-of-week to 0..N open/close intervals (0 = closed that day; N > 1 = split shifts).
export const FacilityHours = z
  .object({
    tz: z.string().min(1),
    weekly: z.record(DayOfWeekKey, z.array(HoursInterval)),
  })
  .strict();
export type FacilityHours = z.infer<typeof FacilityHours>;

// One capacity-1 unit: a single door × time-window. A physical window with N parallel docks is expressed as
// N slots (one per door). `slot_key` is the STABLE, opaque claim key T5's UNIQUE index dedupes appointments
// on — it is the join between an appointment.set event and the facility's finite capacity, so it must be
// non-empty and (across the array) unique. `dow` optionally pins the slot to a day-of-week; absent = the
// window recurs every day. `window_end_min >= window_start_min` (mirrors the T1 AppointmentSetPayload refine).
const CapacitySlot = z
  .object({
    slot_key: z.string().min(1),
    window_start_min: MinuteOfDay,
    window_end_min: MinuteOfDay,
    dow: SafeInt.min(0).max(6).optional(),
  })
  .strict()
  .refine((s) => s.window_end_min >= s.window_start_min, "window_end_min must be >= window_start_min");

// FacilityCapacitySlots — the facility's finite bookable capacity as a flat array of capacity-1 slots.
// slot_keys are UNIQUE within the array: T5 claims a slot by inserting a UNIQUE(facility_id, slot_key) row,
// so two slots sharing a key would make one physically un-claimable (or corrupt the double-book guard). A
// duplicate is a config error caught HERE, not at claim time. An empty array is legal (no defined capacity).
export const FacilityCapacitySlots = z
  .array(CapacitySlot)
  .refine((all) => new Set(all.map((s) => s.slot_key)).size === all.length, "slot_key must be unique within capacity_slots");
export type FacilityCapacitySlots = z.infer<typeof FacilityCapacitySlots>;

// FacilityAppointmentRules — the booking policy the scheduler enforces. `lead_time_min` = minimum minutes
// between now and a bookable window; `max_horizon_days` = how far ahead booking opens; `allow_same_day`
// toggles same-day booking. All optional (the '{}' default is a facility with no extra policy). Non-negative
// integers — a negative lead time / horizon is meaningless.
export const FacilityAppointmentRules = z
  .object({
    lead_time_min: SafeInt.min(0).optional(),
    max_horizon_days: SafeInt.min(0).optional(),
    allow_same_day: z.boolean().optional(),
  })
  .strict();
export type FacilityAppointmentRules = z.infer<typeof FacilityAppointmentRules>;

// The facility kind, mirroring the 0002_domain.sql CHECK (terminal|dock|yard). Used by the loader to narrow
// the raw `kind` TEXT column into a typed union.
export const FacilityKind = z.enum(["terminal", "dock", "yard"]);
export type FacilityKind = z.infer<typeof FacilityKind>;
