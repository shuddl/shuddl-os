// §868 (REQ-028/052) — PURE unit tests for the appointment.set leg-claim projection.
//
// The sibling of `approvals-projection.test.ts`, and the second of the two projections that shipped without
// one. `appointment-gate.test.ts` covers the GATE (may this claim be made?); nothing covered the PROJECTION
// (what statement does the claim become?), and the two answer different questions.
//
// WHY THE STATEMENT SHAPE IS THE SUBJECT. `legs` is an UNGUARDED, mutable table — no append-only trigger
// watches it. The source states the consequence in terms: a `REPLACE` "would DELETE the pre-existing row
// THROUGH ux_legs_slot before re-inserting = silent slot theft with no guard to catch it." So on this table
// the difference between `UPDATE` and `REPLACE` is the difference between claiming a free dock slot and
// silently taking someone else's, and NOTHING AT RUNTIME WOULD OBJECT. There is a tools/checks lint for the
// REPLACE family; this pins the same law at the projection that emits the statement.
//
// A recording fake `db` for the same reason as the approvals file: the laws here are about the SQL text.
import { describe, expect, it } from "vitest";
import { eventFixture, type LedgerEvent } from "@shuddl/contracts";
import { projectAppointment } from "../src/projection/appointment.js";

interface Stmt {
  sql: string;
  binds: unknown[];
}

function recorder(): { db: D1Database; stmts: Stmt[] } {
  const stmts: Stmt[] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...binds: unknown[]) => {
        const s: Stmt = { sql, binds };
        stmts.push(s);
        return s;
      },
    }),
  } as unknown as D1Database;
  return { db, stmts };
}

const PAYLOAD = {
  facility_id: "FAC-1",
  slot_key: "DOCK-3@0800",
  window_start_ts: 1_700_000_000_000,
  window_end_ts: 1_700_003_600_000,
  leg_kind: "pickup",
};

const SERVICE_DATE = "2026-08-10";

function apptSet(over: Partial<LedgerEvent> = {}): LedgerEvent {
  return eventFixture("appointment.set", {
    shipment_id: "SHP-1",
    payload: PAYLOAD,
    ...over,
  } as Partial<LedgerEvent>);
}

describe("§868: projectAppointment claims the dock slot on the leg row (REQ-028/052)", () => {
  it("a valid appointment.set becomes ONE statement carrying every occurrence column", () => {
    const { db, stmts } = recorder();
    const out = projectAppointment(db, apptSet(), SERVICE_DATE);

    expect(out).toHaveLength(1);
    expect(stmts[0]?.binds, "facility, slot, service_date, window start/end, then the WHERE pair").toEqual([
      "FAC-1",
      "DOCK-3@0800",
      SERVICE_DATE,
      1_700_000_000_000,
      1_700_003_600_000,
      "SHP-1",
      "pickup",
    ]);
  });

  it("it is a PLAIN UPDATE — never REPLACE, never an upsert (that would be silent slot theft)", () => {
    // `legs` is unguarded: no trigger would catch a REPLACE deleting another stream's row through
    // ux_legs_slot. This is the one assertion in the file that protects a slot belonging to someone else.
    const { db, stmts } = recorder();
    projectAppointment(db, apptSet(), SERVICE_DATE);

    expect(stmts[0]?.sql).toMatch(/^UPDATE legs SET\b/);
    expect(stmts[0]?.sql, "REPLACE INTO legs is forbidden").not.toMatch(/REPLACE/i);
    expect(stmts[0]?.sql, "and so is an ON CONFLICT upsert — same delete-through-the-index").not.toMatch(/ON CONFLICT/i);
    expect(stmts[0]?.sql).not.toMatch(/INSERT/i);
  });

  it("targets (shipment_id, kind) — NOT a synthesized leg id, which only one caller's ids would match", () => {
    // booking.created materializes `${id}:pickup` while the test harness seeds `leg-${id}-${seq}`; a WHERE on
    // a synthesized id would silently match ONE of them and claim nothing for the other.
    const { db, stmts } = recorder();
    projectAppointment(db, apptSet(), SERVICE_DATE);

    expect(stmts[0]?.sql).toMatch(/WHERE shipment_id=\? AND kind=\?$/);
    expect(stmts[0]?.sql, "no id-shaped predicate").not.toMatch(/\bWHERE id\b|leg_id/);
  });

  it("a RESCHEDULE is the same single UPDATE — the old slot is freed in the same write", () => {
    // One statement overwrites the occurrence columns atomically, so the vacated
    // (facility, slot, service_date) is immediately claimable. A delete-then-insert pair would open a window
    // where the shipment holds neither slot.
    const { db, stmts } = recorder();
    projectAppointment(
      db,
      apptSet({ payload: { ...PAYLOAD, slot_key: "DOCK-9@1400" } } as Partial<LedgerEvent>),
      "2026-08-11",
    );

    expect(stmts).toHaveLength(1);
    expect(stmts[0]?.binds[1]).toBe("DOCK-9@1400");
    expect(stmts[0]?.binds[2]).toBe("2026-08-11");
  });

  describe("projects nothing when there is nothing to claim", () => {
    it("no serviceDate — the caller could not compute the occurrence key (impure tz math lives there)", () => {
      const { db, stmts } = recorder();
      expect(projectAppointment(db, apptSet(), undefined)).toEqual([]);
      expect(stmts).toHaveLength(0);
    });

    it("no shipment_id — an appointment.set on a non-shipment stream keys to no leg", () => {
      const { db, stmts } = recorder();
      expect(projectAppointment(db, apptSet({ shipment_id: undefined }), SERVICE_DATE)).toEqual([]);
      expect(stmts).toHaveLength(0);
    });

    it("every other kind", () => {
      const { db, stmts } = recorder();
      for (const kind of ["stop.arrived", "pod.signed", "booking.created"] as const) {
        const e = eventFixture(kind, { shipment_id: "SHP-1" } as Partial<LedgerEvent>);
        expect(projectAppointment(db, e, SERVICE_DATE)).toEqual([]);
      }
      expect(stmts).toHaveLength(0);
    });
  });

  it("is PURE — no clock inside; the service_date arrives as an argument (REQ-024)", () => {
    const a = recorder();
    const b = recorder();
    const e = apptSet();
    projectAppointment(a.db, e, SERVICE_DATE);
    projectAppointment(b.db, e, SERVICE_DATE);
    expect(a.stmts).toEqual(b.stmts);
  });
});
