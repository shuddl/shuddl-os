// WP-08 T5 (REQ-028/052) — local wall-clock derivation for a facility's timezone. IMPURE by design (it
// reads an instant through Intl/Date), so it lives HERE in the sequencer caller, NOT in the pure ledger gate
// (which must stay Date-free, REQ-024). It is nonetheless DETERMINISTIC — a pure function of (ts, tz), no
// Date.now — so it is unit-testable and reused by the double-book tests to construct valid slot instants.
//
// Why the DO needs this: appointment.set's occurrence key is the LOCAL service date in the facility tz (a slot
// recurs once PER DATE), and the gate compares the window's local minute-of-day + day-of-week against the
// facility's capacity_slots / hours templates (all expressed in local minutes). The client supplies an epoch
// instant; the SERVER derives the jurisdiction-local wall clock — a driver/caller cannot smuggle a second
// instant for the same slot/day because the derived (service_date, minute-of-day, dow) is server-computed.

// day-of-week 0..6 with 0 = Sunday — matches FacilityHours.weekly keys "0".."6" and CapacitySlot.dow
// (facilities.ts), which is the JS Date.getUTCDay() convention.
export interface LocalWall {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
  hour: number; // 0..23
  minute: number; // 0..59
  minuteOfDay: number; // hour*60 + minute, 0..1439
  dow: number; // 0..6, 0 = Sunday
  serviceDate: string; // canonical YYYY-MM-DD in tz — the OCCURRENCE key
}

/**
 * The local wall-clock components of `ts` (epoch ms) in IANA `tz`. Uses Intl.DateTimeFormat with hourCycle
 * "h23" (00..23, so midnight is 00, never 24). `dow` is derived by rebuilding the local Y/M/D as a UTC date
 * and reading getUTCDay() — avoiding weekday-string parsing/locale drift. Throws if `tz` is not a valid IANA
 * zone (Intl.DateTimeFormat throws a RangeError) — a malformed facility tz fails LOUD in the caller, never a
 * silently mis-derived booking.
 */
export function localWall(ts: number, tz: string): LocalWall {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = dtf.formatToParts(new Date(ts));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  const hour = Number(get("hour")) % 24; // h23 yields 00..23; the %24 defends against a stray "24" on old ICU
  const minute = Number(get("minute"));
  const minuteOfDay = hour * 60 + minute;
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const serviceDate = `${get("year")}-${get("month")}-${get("day")}`;
  return { year, month, day, hour, minute, minuteOfDay, dow, serviceDate };
}

/** The canonical local service date (YYYY-MM-DD) of `ts` in `tz` — the appointment occurrence key. */
export function localServiceDate(ts: number, tz: string): string {
  return localWall(ts, tz).serviceDate;
}
