// §868 (REQ-082/194) — PURE unit tests for the approvals read-model projection.
//
// Six projections ship; four had unit tests in `projections.test.ts` (passport, status-cache, agent-runs,
// authority). `projectApprovals` and `projectAppointment` did not — measured §868. They are reached only
// through `workers/api/test/approvals.test.ts`, which drives the HAPPY PATH end to end, so the three
// TOLERANCE branches below were unreachable from any test in the repo.
//
// Those branches are load-bearing and the source says why: a malformed or differently-shaped
// `approval.requested` must project NOTHING rather than throw, because "a throw here would couple every
// approval.requested append to this exact payload shape and break the append for any other shape." The
// ledger event is truth; the read-model is best-effort. Turning one of these `return []`s into a throw is a
// one-character-class refactor that no integration test would notice — and it would fail APPENDS, not reads.
//
// A RECORDING FAKE `db`, deliberately, not a real D1. Two of this file's assertions are about the SQL TEXT —
// `INSERT OR IGNORE` and never `REPLACE`, `UPDATE` and never `ON CONFLICT` — and the source states those as
// hard laws with a stated consequence ("REPLACE would DELETE the row through the PK ... and drop a decided
// row's decided_event_id"). A real-D1 test proves the row lands; only the statement itself proves HOW.
import { describe, expect, it } from "vitest";
import { eventFixture, type LedgerEvent } from "@shuddl/contracts";
import { projectApprovals } from "../src/projection/approvals.js";

interface Stmt {
  sql: string;
  binds: unknown[];
}

/** A D1 stand-in that records `prepare(sql).bind(...)` instead of executing it. */
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

const REQUESTED = { rule: "below_target_or", required_role: "ops" };

function requested(over: Partial<LedgerEvent> = {}): LedgerEvent {
  return eventFixture("approval.requested", {
    shipment_id: "SHP-1",
    payload: REQUESTED,
    ...over,
  } as Partial<LedgerEvent>);
}

describe("§868: projectApprovals opens and resolves the queue row (REQ-082/194)", () => {
  it("approval.requested opens ONE row, keyed to the shipment, with the event as its id", () => {
    const { db, stmts } = recorder();
    const e = requested();
    const out = projectApprovals(db, e);

    expect(out).toHaveLength(1);
    expect(stmts[0]?.binds, "id, object_id, rule, required_role, requested_event_id").toEqual([
      e.id,
      "SHP-1",
      "below_target_or",
      "ops",
      e.id,
    ]);
  });

  it("the open INSERT is OR IGNORE and never REPLACE — a REPLACE would delete the row through its PK", () => {
    // The source states the consequence: REPLACE drops a decided row's `decided_event_id`, losing the link
    // to the append-only event that recorded WHO decided. `OR IGNORE` is also what makes a redelivered
    // event idempotent under the sequencer's replay-by-event-id.
    const { db, stmts } = recorder();
    projectApprovals(db, requested());

    expect(stmts[0]?.sql).toMatch(/INSERT OR IGNORE INTO approvals\b/);
    expect(stmts[0]?.sql, "REPLACE on approvals is forbidden").not.toMatch(/REPLACE/i);
    expect(stmts[0]?.sql, "and it must not smuggle an upsert in either").not.toMatch(/ON CONFLICT/i);
  });

  it("approval.decided flips the row by requested_event_id and pins the deciding event", () => {
    const { db, stmts } = recorder();
    const e = eventFixture("approval.decided", {
      shipment_id: "SHP-1",
      payload: { requested_event_id: "evt-open-1", decision: "approved" },
    } as Partial<LedgerEvent>);

    expect(projectApprovals(db, e)).toHaveLength(1);
    expect(stmts[0]?.sql).toMatch(/UPDATE approvals SET status = 'decided'/);
    expect(stmts[0]?.binds).toEqual([e.id, "evt-open-1"]);
  });

  it("the decided UPDATE carries no decider/decision column — that truth lives on the EVENT", () => {
    // The schema deliberately has no decider column: who decided and what they decided are append-only
    // payload, and the projection links to it via decided_event_id. A projection that started storing the
    // decider would make a MUTABLE row the answer to an audit question.
    const { db, stmts } = recorder();
    projectApprovals(
      db,
      eventFixture("approval.decided", {
        payload: { requested_event_id: "evt-open-1", decision: "denied", decider: "u-1" },
      } as Partial<LedgerEvent>),
    );
    expect(stmts[0]?.sql).not.toMatch(/decider|decision/i);
    expect(stmts[0]?.binds).not.toContain("u-1");
  });

  describe("TOLERANCE — a malformed gate event projects nothing and NEVER throws", () => {
    // Each of these is unreachable from the API integration test, and each protects APPEND availability
    // rather than read correctness. A throw in any branch breaks `approval.requested` appends repo-wide.
    it.each([
      ["no shipment_id (nothing to key the row to)", () => requested({ shipment_id: undefined })],
      ["no rule", () => requested({ payload: { required_role: "ops" } } as Partial<LedgerEvent>)],
      ["no required_role", () => requested({ payload: { rule: "below_target_or" } } as Partial<LedgerEvent>)],
      ["a non-string rule", () => requested({ payload: { rule: 7, required_role: "ops" } } as Partial<LedgerEvent>)],
      ["an empty payload (a future non-gate use)", () => requested({ payload: {} } as Partial<LedgerEvent>)],
    ])("approval.requested with %s → [] ", (_label, mk) => {
      const { db, stmts } = recorder();
      expect(() => projectApprovals(db, mk())).not.toThrow();
      expect(projectApprovals(db, mk())).toEqual([]);
      expect(stmts, "nothing may be prepared for an unprojectable event").toHaveLength(0);
    });

    it("approval.decided without a requested_event_id → [] (no open row it could resolve)", () => {
      const { db, stmts } = recorder();
      const e = eventFixture("approval.decided", { payload: { decision: "approved" } } as Partial<LedgerEvent>);
      expect(projectApprovals(db, e)).toEqual([]);
      expect(stmts).toHaveLength(0);
    });
  });

  it("every OTHER kind projects nothing (the read-model handles two kinds, not all 35)", () => {
    const { db, stmts } = recorder();
    for (const kind of ["pod.signed", "stop.arrived", "invoice.issued", "booking.created"] as const) {
      expect(projectApprovals(db, eventFixture(kind, { shipment_id: "SHP-1" } as Partial<LedgerEvent>))).toEqual([]);
    }
    expect(stmts).toHaveLength(0);
  });

  it("is PURE — the same event yields identical statements every time (REQ-024: no clock, no I/O)", () => {
    // Idempotence under the sequencer's replay-by-event-id is the property that makes a redelivery safe.
    const a = recorder();
    const b = recorder();
    const e = requested();
    projectApprovals(a.db, e);
    projectApprovals(b.db, e);
    expect(a.stmts).toEqual(b.stmts);
  });
});
