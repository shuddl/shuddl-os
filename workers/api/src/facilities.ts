import { FacilityKind, FacilityHours, FacilityCapacitySlots, FacilityAppointmentRules } from "@shuddl/contracts";

// WP-08 Scheduler/Booking Task 2 (REQ-052 / REQ-028) — load a facility's capacity model from the SESSION
// tenant's OWN D1 facilities row (doc 10 §1). Tenant isolation is upstream and structural: `db` is already
// the session tenant's handle (tenantDb, REQ-025) — this module never sees a tenant id and cannot cross
// tenants (mirrors rate-config.ts). The three JSON columns (hours/capacity_slots/appointment_rules) are
// Zod-parsed with the Task-2 @shuddl/contracts schemas, so a malformed STORED config fails LOUDLY here (a
// 500-class throw — either JSON.parse's SyntaxError on non-JSON, or a ZodError on an invariant violation),
// never as a silently mis-scheduled booking. A gate in the sequencer DO calls loadFacility to read the
// finite capacity it enforces against; an absent facility → null (the caller decides how to answer).
//
// The PURE parse (parseFacilityRow: raw row → typed) is kept separable from the D1 read so it is
// unit-testable without a DB — exactly the raw-row/DB-read split rate-config.ts uses.

// The typed facility a gate consumes. `party_id`/`lat_e6`/`lon_e6` are nullable in the DDL, so they surface
// as `| null` (SQL NULL, faithfully). `kind` is narrowed to the DDL CHECK union; the three JSON columns are
// their parsed shapes.
export type Facility = {
  id: string;
  party_id: string | null;
  kind: FacilityKind;
  lat_e6: number | null;
  lon_e6: number | null;
  hours: FacilityHours;
  capacity_slots: FacilityCapacitySlots;
  appointment_rules: FacilityAppointmentRules;
};

// A raw facilities row exactly as D1 returns it: scalar columns typed, the three JSON columns still strings.
export type FacilityRow = {
  id: string;
  party_id: string | null;
  kind: string;
  lat_e6: number | null;
  lon_e6: number | null;
  hours: string;
  capacity_slots: string;
  appointment_rules: string;
};

// PURE: raw row → typed Facility. Throws LOUDLY on any malformed stored config — JSON.parse throws on
// non-JSON, and each schema's .parse throws a ZodError on a shape/invariant violation. No silent degrade.
export function parseFacilityRow(row: FacilityRow): Facility {
  const hours: unknown = JSON.parse(row.hours);
  const capacity_slots: unknown = JSON.parse(row.capacity_slots);
  const appointment_rules: unknown = JSON.parse(row.appointment_rules);
  return {
    id: row.id,
    party_id: row.party_id,
    kind: FacilityKind.parse(row.kind),
    lat_e6: row.lat_e6,
    lon_e6: row.lon_e6,
    hours: FacilityHours.parse(hours),
    capacity_slots: FacilityCapacitySlots.parse(capacity_slots),
    appointment_rules: FacilityAppointmentRules.parse(appointment_rules),
  };
}

const SELECT_FACILITY =
  "SELECT id, party_id, kind, lat_e6, lon_e6, hours, capacity_slots, appointment_rules FROM facilities WHERE id = ?1";

// D1 read → parse. Returns null when the row is absent; throws (via parseFacilityRow) when it is malformed.
export async function loadFacility(db: D1Database, facility_id: string): Promise<Facility | null> {
  const row = await db.prepare(SELECT_FACILITY).bind(facility_id).first<FacilityRow>();
  if (!row) return null;
  return parseFacilityRow(row);
}
