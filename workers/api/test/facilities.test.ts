import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { loadFacility, parseFacilityRow, type FacilityRow } from "../src/facilities.js";
import { ensureSchema, seedFacility, TEST_FACILITY } from "./helpers.js";

// WP-08 Scheduler/Booking Task 2 (REQ-052) — loadFacility reads a facilities row from the SESSION tenant's
// D1 and Zod-parses its three JSON columns into a typed capacity model a sequencer-DO gate can consume.
// Mirrors rate-config.ts: a malformed STORED config fails LOUDLY (a 500-class throw), never a silent skip;
// an absent row → null. The PURE parse (raw-row → typed) is separable from the D1 read, so it is unit-tested
// here without a DB. Scopes to its OWN facility ids; never assumes an empty table (isolatedStorage is off).

beforeAll(async () => {
  await ensureSchema(env);
});

// A well-formed raw row exactly as D1 hands it back (JSON columns are strings, nullable columns can be null).
function rawRow(over: Partial<FacilityRow> = {}): FacilityRow {
  return {
    id: "fac-pure-1",
    party_id: "party-consignee",
    kind: "dock",
    lat_e6: 37_421_000,
    lon_e6: -122_084_000,
    hours: JSON.stringify({ tz: "America/Los_Angeles", weekly: { "1": [{ open_min: 480, close_min: 1020 }] } }),
    capacity_slots: JSON.stringify([{ slot_key: "s1", window_start_min: 480, window_end_min: 720, dow: 1 }]),
    appointment_rules: JSON.stringify({ lead_time_min: 120 }),
    ...over,
  };
}

describe("parseFacilityRow (pure — no DB)", () => {
  it("maps a raw row to the typed facility shape", () => {
    const f = parseFacilityRow(rawRow());
    expect(f.id).toBe("fac-pure-1");
    expect(f.party_id).toBe("party-consignee");
    expect(f.kind).toBe("dock");
    expect(f.lat_e6).toBe(37_421_000);
    expect(f.hours.tz).toBe("America/Los_Angeles");
    expect(f.hours.weekly["1"]?.[0]?.close_min).toBe(1020);
    expect(f.capacity_slots[0]?.slot_key).toBe("s1");
    expect(f.appointment_rules.lead_time_min).toBe(120);
  });
  it("carries a NULL party_id / lat_e6 / lon_e6 through as null", () => {
    const f = parseFacilityRow(rawRow({ party_id: null, lat_e6: null, lon_e6: null }));
    expect(f.party_id).toBeNull();
    expect(f.lat_e6).toBeNull();
    expect(f.lon_e6).toBeNull();
  });
  it("throws loudly on capacity_slots that is not valid JSON (never silently degrades)", () => {
    expect(() => parseFacilityRow(rawRow({ capacity_slots: "[{" }))).toThrow();
  });
  it("throws loudly on a stored config that is valid JSON but violates an invariant (duplicate slot_keys)", () => {
    const dup = JSON.stringify([
      { slot_key: "dup", window_start_min: 0, window_end_min: 60 },
      { slot_key: "dup", window_start_min: 60, window_end_min: 120 },
    ]);
    expect(() => parseFacilityRow(rawRow({ capacity_slots: dup }))).toThrow();
  });
  it("throws loudly on a kind outside the enum", () => {
    expect(() => parseFacilityRow(rawRow({ kind: "garage" }))).toThrow();
  });
});

describe("loadFacility (D1)", () => {
  it("parses a seeded facility and returns the typed shape", async () => {
    await seedFacility(env.TENANT_A_DB, TEST_FACILITY);
    const f = await loadFacility(env.TENANT_A_DB, TEST_FACILITY.id);
    expect(f).not.toBeNull();
    if (!f) throw new Error("expected the seeded facility");
    expect(f.kind).toBe("dock");
    expect(f.party_id).toBe("party-consignee");
    expect(f.lat_e6).toBe(37_421_000);
    expect(f.hours.tz).toBe("America/Los_Angeles");
    expect(f.capacity_slots).toHaveLength(2);
    expect(f.capacity_slots.map((s) => s.slot_key)).toEqual(["mon-am-dock-1", "mon-pm-dock-1"]);
    expect(f.appointment_rules.lead_time_min).toBe(120);
    expect(f.appointment_rules.allow_same_day).toBe(false);
  });

  it("returns null for an absent facility", async () => {
    expect(await loadFacility(env.TENANT_A_DB, "fac-does-not-exist")).toBeNull();
  });

  it("throws LOUDLY on a malformed STORED capacity_slots (a 500-class throw, not a silent skip)", async () => {
    // Insert broken JSON directly (bypassing seedFacility's JSON.stringify) to simulate a corrupt stored row.
    await env.TENANT_A_DB.prepare(
      "INSERT OR IGNORE INTO facilities (id, kind, hours, capacity_slots, appointment_rules) VALUES (?,?,?,?,?)",
    )
      .bind("fac-malformed", "dock", "{}", "[{", "{}")
      .run();
    await expect(loadFacility(env.TENANT_A_DB, "fac-malformed")).rejects.toThrow();
  });
});
