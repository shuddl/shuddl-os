import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { LedgerEvent, PodSignedPayload, AuthorityFlippedPayload } from "@shuddl/contracts";
import { applyMigrations } from "../src/migrate.js";
import { projectPassport } from "../src/projection/passports.js";
import {
  projectStatusCache,
  surfaceCreditProjectionGapIfMissed,
  CREDIT_PROJECTION_GAP_RULE,
} from "../src/projection/status-cache.js";
import { projectAgentRuns } from "../src/projection/agent-runs.js";
import { projectAuthority } from "../src/projection/authority.js";
import { projectApprovals } from "../src/projection/approvals.js";
import { eventInsertStmt, mkEvent, resetEventCounter } from "./helpers.js";
import ledgerCore from "../../../db/tenant/migrations/0001_ledger_core.sql?raw";
import domain from "../../../db/tenant/migrations/0002_domain.sql?raw";
import insertGuards from "../../../db/tenant/migrations/0003_insert_guards.sql?raw";

// NOTE: vitest-pool-workers isolates storage PER TEST — each `it`'s writes are rolled back at its
// end (only beforeAll writes persist as the base). So every test here seeds its own shipment/party.

const DB = env.TENANT_A_DB;

async function seedParty(id: string): Promise<void> {
  await DB.prepare("INSERT OR IGNORE INTO parties (id, kind, names) VALUES (?, 'carrier', '[]')").bind(id).run();
}
async function appendStatus(e: LedgerEvent): Promise<void> {
  await DB.batch([eventInsertStmt(DB, e), ...projectStatusCache(DB, e)]);
}
async function appendPassport(e: LedgerEvent): Promise<void> {
  await DB.batch([eventInsertStmt(DB, e), ...projectPassport(DB, e)]);
}
async function appendAgentRun(e: LedgerEvent): Promise<void> {
  await DB.batch([eventInsertStmt(DB, e), ...projectAgentRuns(DB, e)]);
}
async function appendAuthority(e: LedgerEvent): Promise<void> {
  await DB.batch([eventInsertStmt(DB, e), ...projectAuthority(DB, e)]);
}
interface AuthorityRow {
  module: string;
  authority: string;
  gates_status: string;
  flipped_events: string;
}
async function authorityMap(module: string): Promise<AuthorityRow | null> {
  return DB.prepare("SELECT module, authority, gates_status, flipped_events FROM authority_map WHERE module = ?")
    .bind(module)
    .first<AuthorityRow>();
}
interface AgentRunRow {
  id: string;
  agent: string;
  trigger_event_id: string | null;
  actions: string;
  basis: string;
  confidence: number | null;
  cost: string;
  latency_ms: number | null;
  outcome: string | null;
}
async function agentRun(id: string): Promise<AgentRunRow | null> {
  return DB.prepare(
    "SELECT id, agent, trigger_event_id, actions, basis, confidence, cost, latency_ms, outcome FROM agent_runs WHERE id = ?",
  )
    .bind(id)
    .first<AgentRunRow>();
}
async function statusCache(shipmentId: string): Promise<Record<string, unknown> | null> {
  const r = await DB.prepare("SELECT status_cache AS s FROM shipments WHERE id = ?").bind(shipmentId).first<{ s: string }>();
  return r === null ? null : (JSON.parse(r.s) as Record<string, unknown>);
}
async function scores(partyId: string): Promise<Record<string, number> | null> {
  const r = await DB.prepare("SELECT scores AS s FROM passports WHERE party_id = ?").bind(partyId).first<{ s: string }>();
  return r === null ? null : (JSON.parse(r.s) as Record<string, number>);
}
async function creditStatus(partyId: string): Promise<string | null> {
  const r = await DB.prepare("SELECT credit_status AS c FROM parties WHERE id = ?").bind(partyId).first<{ c: string | null }>();
  return r === null ? null : r.c;
}
async function partyExists(id: string): Promise<boolean> {
  return (await DB.prepare("SELECT 1 AS x FROM parties WHERE id = ?").bind(id).first<{ x: number }>()) !== null;
}
async function anomaly(
  id: string,
): Promise<{ rule: string; object_id: string | null; severity: string; detail: string } | null> {
  return DB.prepare("SELECT rule, object_id, severity, detail FROM anomalies WHERE id = ?")
    .bind(id)
    .first<{ rule: string; object_id: string | null; severity: string; detail: string }>();
}
// Mirror the sequencer's credit path: run the event + credit UPDATE in one batch, read rows-affected off
// the batch result (results[1] = the CREDIT_SQL statement), then surface a gap if it was a silent no-op.
async function appendCreditAndSurface(e: LedgerEvent): Promise<number> {
  const results = await DB.batch([eventInsertStmt(DB, e), ...projectStatusCache(DB, e)]);
  const changes = results[1]?.meta.changes ?? 0;
  await surfaceCreditProjectionGapIfMissed(DB, e, changes);
  return changes;
}
function booking(shipmentId: string, division = "north"): LedgerEvent {
  return mkEvent("booking.created", {
    stream_id: `s:${shipmentId}`,
    shipment_id: shipmentId,
    payload: { quote_event_id: "evt-quote-1", division, shipper_party_id: "p-ship", consignee_party_id: "p-cons", bill_to_party_id: "p-bill" },
  });
}

beforeAll(async () => {
  resetEventCounter();
  await applyMigrations(DB, [
    { path: "0001_ledger_core.sql", sql: ledgerCore },
    { path: "0002_domain.sql", sql: domain },
    { path: "0003_insert_guards.sql", sql: insertGuards },
  ]);
});

describe("REQ-015 / audit#11 — status_cache is the projection the driver lens + OFD depend on", () => {
  it("booking.created UPSERTS the shipments row itself (id/division/parties) then sets state=booked", async () => {
    await appendStatus(booking("shp-1"));
    const row = await DB.prepare(
      "SELECT division, shipper_party_id, consignee_party_id, bill_to_party_id FROM shipments WHERE id = 'shp-1'",
    ).first<{ division: string; shipper_party_id: string; consignee_party_id: string; bill_to_party_id: string }>();
    expect(row).toEqual({ division: "north", shipper_party_id: "p-ship", consignee_party_id: "p-cons", bill_to_party_id: "p-bill" });
    expect((await statusCache("shp-1"))?.state).toBe("booked");
  });

  it("booking.created CORRECTS consignee/bill_to on an EXISTING (Concierge quote-stage) row — not just state (REQ-181)", async () => {
    // WP-07 leaves a quote-stage shipment whose THREE party FKs all self-reference the requester (resolve.ts
    // createShipment). Pre-create that row directly, then book with DIFFERENT real consignee + bill_to.
    await DB.prepare(
      "INSERT INTO shipments (id, division, shipper_party_id, consignee_party_id, bill_to_party_id, status_cache, created_ts) VALUES ('cx-1','main','p-req','p-req','p-req','{}',0)",
    ).run();
    // The booking payload deliberately names a shipper (p-other-shipper) DIFFERENT from the row's existing
    // shipper (p-req): the ON CONFLICT SET clause must NOT touch shipper_party_id, so the stored value must
    // stay p-req. This fails if the SET clause is ever WIDENED to `shipper_party_id = excluded.shipper...`.
    await appendStatus(
      mkEvent("booking.created", {
        stream_id: "s:cx-1",
        shipment_id: "cx-1",
        payload: { quote_event_id: "evt-q", division: "main", shipper_party_id: "p-other-shipper", consignee_party_id: "p-real-cons", bill_to_party_id: "p-real-bill" },
      }),
    );
    const row = await DB.prepare(
      "SELECT shipper_party_id, consignee_party_id, bill_to_party_id FROM shipments WHERE id = 'cx-1'",
    ).first<{ shipper_party_id: string; consignee_party_id: string; bill_to_party_id: string }>();
    // consignee + bill_to become the booking's REAL parties; shipper STAYS the requester (p-req) even though
    // the payload named a different shipper — booking never re-parents the shipper. state also flips to booked.
    expect(row).toEqual({ shipper_party_id: "p-req", consignee_party_id: "p-real-cons", bill_to_party_id: "p-real-bill" });
    expect((await statusCache("cx-1"))?.state).toBe("booked");
  });

  it("a later status event (dispatch.assigned) does NOT clobber the corrected party FKs — correction is booking.created-only", async () => {
    await DB.prepare(
      "INSERT INTO shipments (id, division, shipper_party_id, consignee_party_id, bill_to_party_id, status_cache, created_ts) VALUES ('cx-2','main','p-req','p-req','p-req','{}',0)",
    ).run();
    await appendStatus(
      mkEvent("booking.created", {
        stream_id: "s:cx-2",
        shipment_id: "cx-2",
        payload: { quote_event_id: "evt-q", division: "main", shipper_party_id: "p-req", consignee_party_id: "p-real-cons", bill_to_party_id: "p-real-bill" },
      }),
    );
    await appendStatus(mkEvent("dispatch.assigned", { stream_id: "s:cx-2", shipment_id: "cx-2", seq: 1, actor: { party: "p-ops", user: "driver-9" } }));
    const row = await DB.prepare(
      "SELECT consignee_party_id, bill_to_party_id FROM shipments WHERE id = 'cx-2'",
    ).first<{ consignee_party_id: string; bill_to_party_id: string }>();
    expect(row).toEqual({ consignee_party_id: "p-real-cons", bill_to_party_id: "p-real-bill" });
    const sc = await statusCache("cx-2");
    expect(sc?.state).toBe("dispatched");
    expect(sc?.assigned_driver).toBe("driver-9");
  });

  it("full lifecycle: dispatched(+assigned_driver) -> in_transit -> OFD -> delivered", async () => {
    await appendStatus(booking("shp-1")); // seq 0

    await appendStatus(mkEvent("dispatch.assigned", { stream_id: "s:shp-1", shipment_id: "shp-1", seq: 1, actor: { party: "p-ops", user: "driver-1" } }));
    let sc = await statusCache("shp-1");
    expect(sc?.state).toBe("dispatched");
    expect(sc?.assigned_driver).toBe("driver-1");
    // The driver lens finds the shipment ONLY because the projection wrote assigned_driver.
    const found = await DB.prepare("SELECT id FROM shipments WHERE json_extract(status_cache,'$.assigned_driver') = 'driver-1'").first<{ id: string }>();
    expect(found?.id).toBe("shp-1");

    await appendStatus(mkEvent("custody.transferred", { stream_id: "s:shp-1", shipment_id: "shp-1", seq: 2 }));
    expect((await statusCache("shp-1"))?.state).toBe("in_transit");

    await appendStatus(mkEvent("stop.departed", { stream_id: "s:shp-1", shipment_id: "shp-1", seq: 3, payload: { geo: { lat_e6: 37_421_000, lon_e6: -122_084_000 }, auto: false, out_for_delivery: true } }));
    // The lens predicate is json_extract(...)=1; prove it directly.
    const ofd = await DB.prepare("SELECT id FROM shipments WHERE id='shp-1' AND json_extract(status_cache,'$.out_for_delivery') = 1").first<{ id: string }>();
    expect(ofd?.id).toBe("shp-1");

    await appendStatus(mkEvent("pod.signed", { stream_id: "s:shp-1", shipment_id: "shp-1", seq: 4 }));
    sc = await statusCache("shp-1");
    expect(sc?.state).toBe("delivered");
    expect(sc?.assigned_driver).toBe("driver-1"); // earlier projection fields survive later json_set
  });

  it("a plain stop.departed (no flag) does NOT flip out_for_delivery (v1 rule)", async () => {
    await appendStatus(booking("shp-3"));
    await appendStatus(mkEvent("stop.departed", { stream_id: "s:shp-3", shipment_id: "shp-3", seq: 1, payload: { geo: { lat_e6: 37_421_000, lon_e6: -122_084_000 }, auto: false } }));
    expect((await statusCache("shp-3"))?.out_for_delivery).toBeUndefined();
  });

  it("exception.raised -> state=exception (the pulse the map dims on)", async () => {
    await appendStatus(booking("shp-2", "south"));
    await appendStatus(mkEvent("exception.raised", { stream_id: "s:shp-2", shipment_id: "shp-2", seq: 1 }));
    expect((await statusCache("shp-2"))?.state).toBe("exception");
  });

  it("non-projecting kinds leave status_cache untouched", async () => {
    await appendStatus(booking("shp-4"));
    const before = await statusCache("shp-4");
    await appendStatus(mkEvent("message.sent", { stream_id: "s:shp-4", shipment_id: "shp-4", seq: 1 }));
    expect(await statusCache("shp-4")).toEqual(before);
  });
});

describe("REQ-042 — credit.checked projects parties.credit_status (the T6 credit-hold gate's read-model)", () => {
  it("credit.checked{hold} sets credit_status='hold'; a later {clear} sets 'clear' (idempotent, party-scoped, NO shipment_id)", async () => {
    await seedParty("party-credit"); // the UPDATE lands only on an EXISTING party row
    expect(await creditStatus("party-credit")).toBeNull(); // 0002 default: credit_status is NULL until decided
    // shipment_id is EXPLICITLY undefined (overriding the fixture default) so the credit decision carries no
    // shipment — the party-scoped path that must project BEFORE the `if (shipmentId === undefined) return []`
    // guard. If credit.checked were handled AFTER that guard, this would be silently dropped and stay NULL.
    await appendStatus(mkEvent("credit.checked", { shipment_id: undefined, payload: { party_id: "party-credit", status: "hold" } }));
    expect(await creditStatus("party-credit")).toBe("hold");
    await appendStatus(mkEvent("credit.checked", { shipment_id: undefined, seq: 1, payload: { party_id: "party-credit", status: "clear" } }));
    expect(await creditStatus("party-credit")).toBe("clear");
  });

  it("credit.checked leaves an UNRELATED party's credit_status untouched", async () => {
    await seedParty("party-credit-a");
    await seedParty("party-credit-b");
    await appendStatus(mkEvent("credit.checked", { payload: { party_id: "party-credit-a", status: "review" } }));
    expect(await creditStatus("party-credit-a")).toBe("review");
    expect(await creditStatus("party-credit-b")).toBeNull();
  });
});

describe("REQ-183 — the credit.checked projection must not SILENTLY no-op (loud gap, no fabricated party)", () => {
  it("credit.checked for an EXISTING party updates credit_status and surfaces NO gap (unchanged behavior)", async () => {
    await seedParty("party-183-present");
    const e = mkEvent("credit.checked", { shipment_id: undefined, payload: { party_id: "party-183-present", status: "hold" } });
    const changes = await appendCreditAndSurface(e);
    expect(changes).toBe(1); // the UPDATE landed on the existing row
    expect(await creditStatus("party-183-present")).toBe("hold");
    expect(await anomaly(`credit-projection-gap:${e.id}`)).toBeNull(); // no gap surfaced on a hit
  });

  it("credit.checked for a party that does NOT exist surfaces a LOUD anomalies gap and fabricates NO party row", async () => {
    const missing = "party-183-absent";
    expect(await partyExists(missing)).toBe(false);
    const e = mkEvent("credit.checked", { shipment_id: undefined, payload: { party_id: missing, status: "hold" } });
    const changes = await appendCreditAndSurface(e);
    expect(changes).toBe(0); // the UPDATE matched nothing — the silent no-op REQ-183 targets

    // the party row is NOT fabricated (append-only / no-invented-data law — a party the ledger never created)
    expect(await partyExists(missing)).toBe(false);
    expect(await creditStatus(missing)).toBeNull();

    // the gap is surfaced LOUDLY on the durable, mutable anomalies table (rule + party + critical severity)
    const a = await anomaly(`credit-projection-gap:${e.id}`);
    expect(a).not.toBeNull();
    expect(a!.rule).toBe(CREDIT_PROJECTION_GAP_RULE);
    expect(a!.object_id).toBe(missing);
    expect(a!.severity).toBe("critical");
    const detail = JSON.parse(a!.detail) as { party_id: string; status: string; reason: string; event_id: string };
    expect(detail).toMatchObject({ party_id: missing, status: "hold", reason: "party_row_absent", event_id: e.id });

    // the credit.checked EVENT itself stands on the ledger (truth), even though the projection could not apply
    expect(await DB.prepare("SELECT id FROM events WHERE id = ?").bind(e.id).first()).not.toBeNull();
  });

  // §1541 (REQ-183/035/030) — A RESOLVED CREDIT GAP MUST REOPEN WHILE THE PARTY IS STILL ABSENT.
  //
  // The third instance of §1539's class and the only `critical` one. The other two were `INSERT OR IGNORE`, so a
  // sweep bucketing writers by conflict FORM caught them; this site already upserted, and what was wrong was the
  // SET list — it refreshed `severity` and `detail` and never touched `status`. The id is keyed on the EVENT id,
  // so no re-projection will ever mint a different row: once an operator marked it resolved, a re-projection
  // that STILL cannot find the party silently left a defeated credit gate — the mis-bill risk this rule exists
  // to announce — sitting behind a 'resolved' status that every ops read filters out.
  it("a RESOLVED credit-projection gap REOPENS when a re-projection still cannot find the party", async () => {
    const missing = "party-1541-absent";
    const e = mkEvent("credit.checked", { shipment_id: undefined, payload: { party_id: missing, status: "hold" } });
    await surfaceCreditProjectionGapIfMissed(DB, e, 0);
    expect(await anomaly(`credit-projection-gap:${e.id}`), "no gap was raised — this case cannot test a reopen").not.toBeNull();

    // An operator clears it — byte-identical to watchtower's clearAlarm, the only clear this table has.
    await DB.prepare("UPDATE anomalies SET status = 'resolved' WHERE id = ?").bind(`credit-projection-gap:${e.id}`).run();

    // Re-project the SAME event. Nothing was fixed: the party still does not exist, so the gate is still defeated.
    expect(await partyExists(missing), "the party must still be absent, or the re-projection proves nothing").toBe(false);
    await surfaceCreditProjectionGapIfMissed(DB, e, 0);

    const rows = await DB.prepare("SELECT COUNT(*) AS n FROM anomalies WHERE id = ?").bind(`credit-projection-gap:${e.id}`).first<{ n: number }>();
    expect(rows?.n, "the event-keyed id stopped collapsing — a re-projection forked a second row").toBe(1);
    const after = await DB.prepare("SELECT status FROM anomalies WHERE id = ?").bind(`credit-projection-gap:${e.id}`).first<{ status: string }>();
    expect(
      after?.status,
      "the credit gate is still defeated and the anomaly still reads 'resolved' — every ops read of this table " +
        "filters status = 'open', so the mis-bill risk is invisible exactly where it is looked for",
    ).toBe("open");
  });

  it("a HIT does not surface a gap even when called directly (changes>0 short-circuits, no anomalies row)", async () => {
    const e = mkEvent("credit.checked", { shipment_id: undefined, payload: { party_id: "party-183-hit", status: "clear" } });
    await surfaceCreditProjectionGapIfMissed(DB, e, 1);
    expect(await anomaly(`credit-projection-gap:${e.id}`)).toBeNull();
  });

  // §1499 (REQ-183/118) — the KIND guard is this exported function's OWN contract, not the caller's.
  //
  // `surfaceCreditProjectionGapIfMissed` opens with `if (e.kind !== "credit.checked") return;`, and deleting
  // that line left the ledger suite 732/732 green: every existing case feeds it a credit.checked. In the
  // shipped path the guard IS redundant — `sequencer.ts` already narrows on `full.kind === "credit.checked"`
  // — but redundancy that lives in the CALLER is not a property of an EXPORTED function. Anything else that
  // ever calls this (the recon path names it) would otherwise raise a `credit_projection_gap` anomaly, on the
  // credit rule, against a party read off an unrelated event's payload — a loud, durable, wrong ops signal.
  //
  // A zero rows-affected is ordinary for most kinds, which is exactly why the kind must decide, not the count.
  it("a NON-credit.checked event surfaces nothing even on a 0-row projection (the kind guard is the contract)", async () => {
    const e = booking("s-183-wrong-kind");
    await surfaceCreditProjectionGapIfMissed(DB, e, 0);
    expect(await anomaly(`credit-projection-gap:${e.id}`)).toBeNull();
    // Without the kind guard this raises a `credit_projection_gap` on party `unknown` — the payload has no
    // party_id, so the wrong ops signal would also carry a fabricated-looking subject.
    const anyGap = await DB.prepare("SELECT COUNT(*) AS n FROM anomalies WHERE rule = ? AND detail LIKE ?")
      .bind(CREDIT_PROJECTION_GAP_RULE, `%${e.id}%`)
      .first<{ n: number }>();
    expect(anyGap!.n).toBe(0);
  });

  it("surfacing is idempotent per event id — a redelivered miss collapses to ONE anomalies row (no fabrication)", async () => {
    const missing = "party-183-redeliver";
    const e = mkEvent("credit.checked", { shipment_id: undefined, payload: { party_id: missing, status: "review" } });
    await surfaceCreditProjectionGapIfMissed(DB, e, 0);
    await surfaceCreditProjectionGapIfMissed(DB, e, 0);
    const n = await DB.prepare("SELECT COUNT(*) AS n FROM anomalies WHERE id = ?")
      .bind(`credit-projection-gap:${e.id}`)
      .first<{ n: number }>();
    expect(n!.n).toBe(1);
    expect(await partyExists(missing)).toBe(false);
  });
});

describe("REQ-009 — passports accrue from events (mutable projection; truth stays in the events)", () => {
  beforeAll(async () => {
    await seedParty("party-carrier");
    await seedParty("party-osd");
  });

  it("pod.signed accrues scores.deliveries; a party with no passport row gets one (upsert, accrue not overwrite)", async () => {
    expect(await scores("party-carrier")).toBeNull(); // no passport yet (rows created here roll back after)
    await appendPassport(mkEvent("pod.signed", { stream_id: "s:shp-p1", shipment_id: "shp-p1" }));
    expect((await scores("party-carrier"))?.deliveries).toBe(1);
    await appendPassport(mkEvent("pod.signed", { stream_id: "s:shp-p2", shipment_id: "shp-p2" }));
    expect((await scores("party-carrier"))?.deliveries).toBe(2);
  });

  it("exception.raised/osd.captured/custody.transferred accrue their counters and coexist on one party", async () => {
    await appendPassport(mkEvent("exception.raised", { stream_id: "s:shp-p3", shipment_id: "shp-p3", actor: { party: "party-carrier" } }));
    await appendPassport(mkEvent("custody.transferred", { stream_id: "s:shp-p5", shipment_id: "shp-p5" })); // fixture actor = party-carrier
    await appendPassport(mkEvent("osd.captured", { stream_id: "s:shp-p4", shipment_id: "shp-p4", actor: { party: "party-osd" } }));
    const carrier = await scores("party-carrier");
    expect(carrier?.exceptions).toBe(1);
    expect(carrier?.custody_events).toBe(1); // multiple counters merge in one scores object
    expect((await scores("party-osd"))?.claims_opened).toBe(1);
  });

  // GUARD (type-level): OTD accrual was deliberately removed (deferred to WP-08 — the appointment
  // window that defines on-time is the Scheduler's, and PodSignedPayload has no schema-valid on_time
  // field). This asserts that ABSENCE at the type level: if a future change adds `on_time` to the
  // contract, `HasOnTime` flips to `true`, `const _guard: HasOnTime = false` stops compiling, and the
  // build fails HERE — forcing whoever adds the field to also restore the accrual in passports.ts.
  type HasOnTime = "on_time" extends keyof PodSignedPayload ? true : false;
  it("PodSignedPayload has NO on_time field, so pod.signed accrues ONLY deliveries (OTD deferred to WP-08)", () => {
    const _guard: HasOnTime = false; // ← breaks the build if on_time is ever added to the contract
    expect(_guard).toBe(false);
    // And the runtime projection posts exactly one accrual (deliveries), never an on_time counter.
    const e = mkEvent("pod.signed", { stream_id: "s:shp-p6", shipment_id: "shp-p6" });
    expect(projectPassport(DB, e)).toHaveLength(1);
  });

  it("REQ-009 FK: accruing for an UNSEEDED party aborts the whole append (party must exist first)", async () => {
    const e = mkEvent("pod.signed", { stream_id: "s:shp-p7", shipment_id: "shp-p7", actor: { party: "party-GHOST", user: "u", device: "d" } });
    await expect(DB.batch([eventInsertStmt(DB, e), ...projectPassport(DB, e)])).rejects.toThrow();
    // The batch is atomic: neither the passport NOR the event survived the FK abort.
    expect(await scores("party-GHOST")).toBeNull();
    const evt = await DB.prepare("SELECT COUNT(*) AS c FROM events WHERE id = ?").bind(e.id).first<{ c: number }>();
    expect(evt?.c).toBe(0);
  });
});

describe("REQ-113 — agent_runs meters per-run cost/latency from agent.acted (the LIVE table, not dead)", () => {
  it("agent.acted populates agent_runs (agent, cost {cents}, latency, confidence, trigger, basis) keyed by event id", async () => {
    const e = mkEvent("agent.acted", {
      stream_id: "s:shp-ar1",
      shipment_id: "shp-ar1",
      payload: {
        agent: "rater",
        action: "priced",
        basis: [
          { kind: "event", id: "evt-priced-1" },
          { kind: "config", id: "rc-tariff-v3" },
        ],
        confidence_bps: 10_000,
        cost_cents: 0, // a deterministic engine: an HONEST 0
        latency_ms: 42, // a REAL measured value
      },
    });
    await appendAgentRun(e);
    const row = await agentRun(e.id);
    expect(row).not.toBeNull();
    expect(row!.agent).toBe("rater");
    expect(row!.latency_ms).toBe(42);
    expect(JSON.parse(row!.cost)).toEqual({ cents: 0 }); // recorded exactly as reported — not fabricated
    expect(row!.confidence).toBe(10_000);
    // trigger_event_id = the first cited EVENT-kind basis link (the provenance event), config links skipped.
    expect(row!.trigger_event_id).toBe("evt-priced-1");
    expect(JSON.parse(row!.basis)).toEqual([
      { kind: "event", id: "evt-priced-1" },
      { kind: "config", id: "rc-tariff-v3" },
    ]);
    expect(JSON.parse(row!.actions)).toEqual(["priced"]);
    expect(row!.outcome).toBe("priced");
  });

  it("IDEMPOTENT — re-projecting the SAME agent.acted event is a no-op (INSERT OR IGNORE on the event id)", async () => {
    const e = mkEvent("agent.acted", {
      stream_id: "s:shp-ar2",
      shipment_id: "shp-ar2",
      payload: { agent: "biller", action: "issue_invoice", basis: [{ kind: "event", id: "evt-y" }], confidence_bps: 9_000, cost_cents: 3, latency_ms: 100 },
    });
    await appendAgentRun(e);
    await DB.batch(projectAgentRuns(DB, e)); // re-run the projection alone (a redelivered event)
    const n = await DB.prepare("SELECT COUNT(*) AS c FROM agent_runs WHERE id = ?").bind(e.id).first<{ c: number }>();
    expect(n!.c).toBe(1); // exactly one row
    expect(JSON.parse((await agentRun(e.id))!.cost)).toEqual({ cents: 3 });
  });

  it("a non-agent.acted event projects NO agent_runs row", async () => {
    const e = mkEvent("pod.signed", { stream_id: "s:shp-ar3", shipment_id: "shp-ar3" });
    expect(projectAgentRuns(DB, e)).toHaveLength(0);
  });

  it("an agent.acted WITHOUT cost/latency records cost '{}' + latency NULL (unknown, NEVER a fabricated 0)", async () => {
    const e = mkEvent("agent.acted", {
      stream_id: "s:shp-ar4",
      shipment_id: "shp-ar4",
      payload: { agent: "concierge", action: "replied", basis: [{ kind: "doc", id: "d-1" }], confidence_bps: 8_000 },
    });
    await appendAgentRun(e);
    const row = await agentRun(e.id);
    expect(JSON.parse(row!.cost)).toEqual({}); // no cost reported → unknown, not fabricated as 0
    expect(row!.latency_ms).toBeNull(); // no latency reported → NULL, not invented
    expect(row!.trigger_event_id).toBeNull(); // no event-kind basis link
  });
});

// ─── WP-15 Task 1 (REQ-008/023, Ten Laws L8) — authority_map is the PROJECTION of the append-only, co-signed
// authority.flipped EVENT. The event is truth; the projection APPLIES `to` (never re-derives from prior state,
// never enforces a gate — that is the server-side Gatekeeper's job in a later task). The table ships UNSEEDED,
// so a first-ever flip of a module must UPSERT. e.id is recorded in flipped_events idempotently. ─────────────
describe("REQ-008/023 — authority_map projects authority.flipped (the module-by-module overlay, L8)", () => {
  // An authority flip is a TENANT-LEVEL control event that rides the t:root stream (WP-15 Task 3 makes t:root its
  // ONLY valid stream — the DO structurally rejects one off t:root) and carries no shipment_id. The projection
  // itself is stream-agnostic (it applies `to` for any authority.flipped; the stream is the DO's gate, not the
  // read-model's), but the fixture uses t:root to match the real single-stream invariant.
  function flip(payload: AuthorityFlippedPayload, seq = 0): LedgerEvent {
    return mkEvent("authority.flipped", { stream_id: "t:root", shipment_id: undefined, seq, actor: { party: "party-ops" }, payload });
  }

  it("a promote flip sets authority='native', records e.id in flipped_events, and writes gate_snapshot to gates_status", async () => {
    const e = flip({ module: "rating", from: "legacy", to: "native", reason: "promote", gate_snapshot: { open_gates: 0, ok: true } });
    await appendAuthority(e);
    const row = await authorityMap("rating");
    expect(row).not.toBeNull();
    expect(row!.authority).toBe("native");
    expect(JSON.parse(row!.flipped_events)).toEqual([e.id]);
    expect(JSON.parse(row!.gates_status)).toEqual({ open_gates: 0, ok: true });
  });

  it("works when the module row is ABSENT beforehand (UPSERT — the table ships unseeded)", async () => {
    expect(await authorityMap("comms")).toBeNull(); // no seed row (writes here roll back after the test)
    const e = flip({ module: "comms", from: "legacy", to: "native", reason: "promote" });
    await appendAuthority(e);
    const row = await authorityMap("comms");
    expect(row!.authority).toBe("native");
    expect(JSON.parse(row!.flipped_events)).toEqual([e.id]);
    // no gate_snapshot supplied → gates_status keeps the '{}' default (never fabricated)
    expect(JSON.parse(row!.gates_status)).toEqual({});
  });

  it("IDEMPOTENT — re-applying the SAME authority.flipped lands identical state (e.id appears exactly once)", async () => {
    const e = flip({ module: "dispatch", from: "legacy", to: "native", reason: "promote" });
    await appendAuthority(e);
    await DB.batch(projectAuthority(DB, e)); // redelivered event: re-run the projection alone
    const row = await authorityMap("dispatch");
    expect(row!.authority).toBe("native"); // unchanged
    expect(JSON.parse(row!.flipped_events)).toEqual([e.id]); // recorded ONCE, not twice
  });

  it("a drift fallback sets authority back to 'legacy' and APPENDS its event id (history accrues, not replaces)", async () => {
    const promote = flip({ module: "settlement", from: "legacy", to: "native", reason: "promote" });
    await appendAuthority(promote);
    const drift = flip({ module: "settlement", from: "native", to: "legacy", reason: "drift", drift_ref: "anom-x" }, 1);
    await appendAuthority(drift);
    const row = await authorityMap("settlement");
    expect(row!.authority).toBe("legacy"); // the auto-fallback applied
    expect(JSON.parse(row!.flipped_events)).toEqual([promote.id, drift.id]); // both flips recorded, in order
  });

  it("a flip WITHOUT gate_snapshot does NOT clobber a previously recorded gates_status", async () => {
    const withSnap = flip({ module: "invoicing", from: "legacy", to: "native", reason: "promote", gate_snapshot: { open_gates: 0 } });
    await appendAuthority(withSnap);
    const noSnap = flip({ module: "invoicing", from: "native", to: "legacy", reason: "drift", drift_ref: "anom-y" }, 1);
    await appendAuthority(noSnap);
    const row = await authorityMap("invoicing");
    expect(row!.authority).toBe("legacy");
    expect(JSON.parse(row!.gates_status)).toEqual({ open_gates: 0 }); // the earlier snapshot survives
  });

  it("a non-authority.flipped event projects NO authority_map statement", () => {
    const e = mkEvent("pod.signed", { stream_id: "s:shp-au9", shipment_id: "shp-au9" });
    expect(projectAuthority(DB, e)).toHaveLength(0);
  });

  it("FULL-STREAM replay-equivalence — re-projecting the SAME flip stream onto a WIPED map lands byte-identical state (L8: the read-model is a pure function of the event stream)", async () => {
    // A multi-flip stream for ONE module: promote → drift → promote-again. Build the events ONCE (fixed ids
    // via mkEvent's counter) so BOTH applications replay the IDENTICAL stream — the id set, order, and
    // payloads are pinned. gates_status carries a DIFFERENT snapshot on each promote so "last snapshot wins"
    // is exercised (and the middle drift, carrying none, must NOT clobber it — the COALESCE-keep path).
    const s1 = flip({ module: "rating", from: "legacy", to: "native", reason: "promote", gate_snapshot: { open_gates: 0 } }, 0);
    const s2 = flip({ module: "rating", from: "native", to: "legacy", reason: "drift", drift_ref: "anom-z" }, 1);
    const s3 = flip({ module: "rating", from: "legacy", to: "native", reason: "promote", gate_snapshot: { open_gates: 1 } }, 2);
    const stream = [s1, s2, s3];

    // Run 1: apply the stream (event insert + projection) in order; capture the FULL end state.
    for (const e of stream) await appendAuthority(e);
    const first = await authorityMap("rating");
    expect(first).not.toBeNull();

    // WIPE the read-model — authority_map is UNGUARDED (no append-only DELETE trigger; only events/positions/
    // money_lines carry them), so a projection rebuild is legal. Then RE-PROJECT the SAME events (already on
    // the ledger) from scratch — projection-only, no re-insert (the events append-only, so they are NOT
    // re-appended). A byte-identical end state PROVES the projection is a pure deterministic function of the
    // event stream — the L8 audit-trail guarantee: authority_map is fully reconstructible from the ledger.
    await DB.prepare("DELETE FROM authority_map WHERE module = 'rating'").run();
    expect(await authorityMap("rating")).toBeNull(); // proven wiped — the rebuild starts from an absent row
    for (const e of stream) await DB.batch(projectAuthority(DB, e));
    const second = await authorityMap("rating");

    // Byte-identical: same authority, same flipped_events IN THE SAME ORDER, same gates_status (one deep-equal
    // over the whole row covers all three), then spelled out for a legible failure.
    expect(second).toEqual(first);
    expect(second!.authority).toBe("native"); // s3.to
    expect(JSON.parse(second!.flipped_events)).toEqual([s1.id, s2.id, s3.id]); // full history, replay order preserved
    expect(JSON.parse(second!.gates_status)).toEqual({ open_gates: 1 }); // last promote's snapshot; the drift did not clobber it
  });
});

// ─── §922 — `INSERT OR IGNORE` IS ONLY IDEMPOTENT BECAUSE OF A PRIMARY KEY, AND NOTHING PROVED IT ───────
//
// Two projections dedupe a redelivered event by writing `INSERT OR IGNORE` against a DETERMINISTIC row id
// — `projectApprovals` (id = the approval.requested event id) and the `booking.created` leg skeleton
// (id = `<shipment>:pickup` / `<shipment>:delivery`). Both source files state the dedupe as the mechanism.
//
// It rests entirely on the PRIMARY KEY: dropping `PRIMARY KEY` from `legs.id` or `approvals.id` left the
// whole ledger AND api suites green, because no test drives the same event twice. `OR IGNORE` without a
// key to conflict on is just `INSERT` — a redelivery would then append a SECOND open approval, or a THIRD
// leg the appointment claim can bind a slot to.
//
// Queue redelivery is not hypothetical here: these projections run off queue-triggered appends, and
// at-least-once is the delivery contract. The projection's own header calls OR IGNORE "clean" for exactly
// that case; this is the assertion that makes it so.
describe("§922: a REDELIVERED event projects exactly one read-model row (OR IGNORE + PK)", () => {
  it("approval.requested projected twice opens exactly ONE approvals row", async () => {
    const e = mkEvent("approval.requested", {
      shipment_id: "shp-appr-dedupe",
      payload: { rule: "below_floor", required_role: "ops" },
    });
    // The control is the first insert: it must actually land, or "one row" would be satisfied by zero.
    await DB.batch(projectApprovals(DB, e));
    const first = await DB.prepare("SELECT COUNT(*) AS n FROM approvals WHERE id = ?").bind(e.id).first<{ n: number }>();
    expect(first?.n, "the first projection wrote nothing — this test would then pass over an empty table").toBe(1);

    await DB.batch(projectApprovals(DB, e)); // the redelivery
    const after = await DB.prepare("SELECT COUNT(*) AS n FROM approvals WHERE id = ?").bind(e.id).first<{ n: number }>();
    expect(after?.n, "a redelivered approval.requested opened a SECOND queue row — OR IGNORE found no key to conflict on").toBe(1);
  });

  it("booking.created projected twice leaves exactly ONE leg per kind", async () => {
    const shipmentId = "shp-legs-dedupe";
    await seedParty("party-legs-dedupe");
    const e = mkEvent("booking.created", {
      shipment_id: shipmentId,
      payload: {
        quote_event_id: "evt-quote-legs-dedupe",
        division: "main",
        shipper_party_id: "party-legs-dedupe",
        consignee_party_id: "party-legs-dedupe",
        bill_to_party_id: "party-legs-dedupe",
      },
    });
    await DB.batch(projectStatusCache(DB, e));
    const legCount = async (): Promise<number> =>
      (await DB.prepare("SELECT COUNT(*) AS n FROM legs WHERE shipment_id = ?").bind(shipmentId).first<{ n: number }>())?.n ?? 0;
    expect(await legCount(), "the first projection wrote no legs — 'exactly two' would then pass over nothing").toBe(2);

    await DB.batch(projectStatusCache(DB, e)); // the redelivery
    expect(await legCount(), "a redelivered booking.created created DUPLICATE skeleton legs — the appointment claim can then bind a slot to a leg the biller never reads").toBe(2);
  });
});
