import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { eventFixture, type EventKind, type LedgerEvent, type Visibility } from "@shuddl/contracts";
import { eventToRow, readEvents } from "../src/lens.js";
import { resolveVisibility } from "../src/visibility.js";
import { applyMigrations } from "../src/migrate.js";
import ledgerCore from "../../../db/tenant/migrations/0001_ledger_core.sql?raw";
import domain from "../../../db/tenant/migrations/0002_domain.sql?raw";
import insertGuards from "../../../db/tenant/migrations/0003_insert_guards.sql?raw";
import partyRefsGuard from "../../../db/tenant/migrations/0004_party_refs_guard.sql?raw";
import eventsOverride from "../../../db/tenant/migrations/0005_events_override.sql?raw";
import booking from "../../../db/tenant/migrations/0006_booking.sql?raw";

// WP-07 Task 7 — TIMELINE VISIBILITY + "no comms outside the ledger" (REQ-094/099/100).
//
// This locks the Concierge's comms/quote lane onto the SAME visibility lens every other event rides
// (I6): a shipment's timeline is `readEvents(db, lens)` — the exact fn the /v1 timeline route calls
// (workers/api/src/routes/events.ts) — and the lens is the SOLE gate. The Concierge appends
// message.received / message.sent / quote.requested / quote.priced carrying party_refs=[counterparty];
// an INTERNAL note is the SAME message.received kind narrowed to `internal` (channel "note"), and a
// call.transcribed is internal by default. The proofs below assert what each lens sees.
//
// LOAD-BEARING BY CONSTRUCTION: the internal note + the call.transcribed carry the SAME party_refs
// ([PARTY]) as the visible events, so the ONLY thing keeping them out of the counterparty/driver lens
// is `visibility <> 'internal'`. Flip the note back to counterparty (i.e. break redaction) and the
// party-lens / driver-lens assertions go red — that is the REQ-094 regression these tests exist to catch.
//
// Visibility is stamped through the REAL resolver (resolveVisibility), never a hand-typed literal, so
// proof 2 ("message.* defaults to counterparty") is coupled to production resolution, not a guess.

const DB = env.TENANT_A_DB;

const SHIP = "shpTL"; // a Task-7-only shipment id (scoped reads — never asserts a global table count)
const STREAM = `s:${SHIP}`;
const PARTY = "party-tl"; // the resolved counterparty on this shipment
const DRIVER = "drv-tl"; // the assigned driver (driver lens)

const vis = (kind: EventKind, requested?: Visibility): Visibility =>
  resolveVisibility(kind, undefined, requested);

let seqCounter = 0;
let hashCounter = 0;
const nextHash = (): string => (++hashCounter).toString(16).padStart(64, "0");

async function seed(kind: EventKind, over: Partial<LedgerEvent>): Promise<LedgerEvent> {
  const e = eventFixture(kind, {
    id: crypto.randomUUID(),
    stream_id: STREAM,
    shipment_id: SHIP,
    seq: seqCounter++,
    ...over,
  });
  const row = eventToRow(e);
  row.hash = nextHash();
  const cols = Object.keys(row);
  await DB.prepare(`INSERT INTO events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .bind(...cols.map((c) => row[c]))
    .run();
  return e;
}

const channelOf = (e: LedgerEvent): unknown => (e.payload as Record<string, unknown>).channel;

beforeAll(async () => {
  await applyMigrations(DB, [
    { path: "0001_ledger_core.sql", sql: ledgerCore },
    { path: "0002_domain.sql", sql: domain },
    { path: "0003_insert_guards.sql", sql: insertGuards },
    { path: "0004_party_refs_guard.sql", sql: partyRefsGuard },
    { path: "0005_events_override.sql", sql: eventsOverride },
    { path: "0006_booking.sql", sql: booking },
  ]);
  // The shipment must be assigned to DRIVER for the driver lens' shipment-assignment subquery to match.
  await DB.prepare(
    "INSERT INTO shipments (id, shipper_party_id, consignee_party_id, bill_to_party_id, created_ts, status_cache) VALUES (?,?,?,?,0,?)",
  )
    .bind(SHIP, PARTY, PARTY, PARTY, JSON.stringify({ assigned_driver: DRIVER, out_for_delivery: false }))
    .run();

  // The Concierge comms/quote lane on ONE shipment, in order, all referencing the counterparty PARTY:
  // 1) inbound quote email       (message.received, counterparty)
  // 2) the request               (quote.requested,  counterparty)
  // 3) the price                 (quote.priced,     counterparty — carries floors/basis/versions)
  // 4) the auto-reply            (message.sent,     counterparty)
  // 5) an INTERNAL note          (message.received, channel "note", NARROWED to internal)
  // 6) a call transcript         (call.transcribed, internal by default)
  await seed("message.received", {
    visibility: vis("message.received"),
    party_refs: [PARTY],
    payload: { channel: "email", from_ref: "cust@example.com", body_ref: "r2://tl/inbound", thread: "th-tl" },
  });
  await seed("quote.requested", {
    visibility: vis("quote.requested"),
    party_refs: [PARTY],
    payload: { request: { origin_zip: "97201", dest_zip: "80012" }, source_message_event_id: "evt-tl-inbound" },
  });
  await seed("quote.priced", { visibility: vis("quote.priced"), party_refs: [PARTY] }); // fixture payload has floors/basis/versions
  await seed("message.sent", {
    visibility: vis("message.sent"),
    party_refs: [PARTY],
    payload: { channel: "email", to_ref: "cust@example.com", body_ref: "r2://tl/reply", drafted_by_agent: "concierge", thread: "th-tl" },
  });
  await seed("message.received", {
    visibility: vis("message.received", "internal"), // the internal-note narrow (REQ-094)
    party_refs: [PARTY], // SAME party as the visible events — only visibility redacts it (load-bearing)
    payload: { channel: "note", from_ref: "ops@internal", body_ref: "r2://tl/note" },
  });
  await seed("call.transcribed", {
    visibility: vis("call.transcribed"),
    party_refs: [PARTY], // SAME party — only visibility redacts it
    payload: { transcript_ref: "r2://tl/call" },
  });
});

describe("REQ-094/099/100 — Concierge timeline visibility across lenses (readEvents)", () => {
  it("proof 1+2: message.received / message.sent / quote.requested / quote.priced surface on the counterparty (party) lens; they land 'counterparty' via the real resolver, and reach the lens BECAUSE they carry the party ref", async () => {
    const res = await readEvents(DB, { scope: "party", partyId: PARTY }, { shipment_id: SHIP });
    // exactly the four counterparty events (the two internal ones are redacted — see proof 3)
    expect(res.map((e) => e.kind).sort()).toEqual(["message.received", "message.sent", "quote.priced", "quote.requested"]);
    // proof 2: each landed as 'counterparty' through resolveVisibility (message.* is NOT internal by default)
    expect(res.every((e) => e.visibility === "counterparty")).toBe(true);
    // …and reaches the lens BECAUSE party_refs carries the counterparty (that IS the party-lens predicate)
    expect(res.every((e) => e.party_refs.includes(PARTY))).toBe(true);
    // the single visible message.received is the customer email, not the internal note
    const received = res.filter((e) => e.kind === "message.received");
    expect(received).toHaveLength(1);
    expect(channelOf(received[0]!)).toBe("email");
  });

  it("proof 3: the INTERNAL note (message.received{channel:note}) AND call.transcribed are REDACTED from the counterparty lens — load-bearing (same party_refs, only visibility differs)", async () => {
    const res = await readEvents(DB, { scope: "party", partyId: PARTY }, { shipment_id: SHIP });
    // neither the note nor the transcript reaches the counterparty
    expect(res.some((e) => e.kind === "call.transcribed")).toBe(false);
    expect(res.some((e) => e.kind === "message.received" && channelOf(e) === "note")).toBe(false);

    // …and prove it is ONLY visibility keeping them out: the tenant lens shows both DO carry [PARTY]
    // (so the party-lens membership predicate is satisfied) and are stamped 'internal'. If REQ-094
    // redaction broke (note -> counterparty), the proof-1 assertion above would surface a 5th event.
    const all = await readEvents(DB, { scope: "tenant" }, { shipment_id: SHIP });
    const note = all.find((e) => e.kind === "message.received" && channelOf(e) === "note")!;
    const call = all.find((e) => e.kind === "call.transcribed")!;
    expect(note.visibility).toBe("internal");
    expect(note.party_refs).toContain(PARTY);
    expect(call.visibility).toBe("internal");
    expect(call.party_refs).toContain(PARTY);
  });

  it("proof 4: the DRIVER lens sees message.* per DRIVER_KINDS but NOT internal notes, NOT quote.*, NOT call.transcribed", async () => {
    const res = await readEvents(DB, { scope: "driver", userId: DRIVER }, { shipment_id: SHIP });
    // message.received (email) + message.sent are DRIVER_KINDS AND counterparty → visible
    expect(res.map((e) => e.kind).sort()).toEqual(["message.received", "message.sent"]);
    // the internal note IS a DRIVER_KIND (message.received) but internal → excluded by visibility FIRST (I6)
    const received = res.filter((e) => e.kind === "message.received");
    expect(received).toHaveLength(1);
    expect(channelOf(received[0]!)).toBe("email");
    // quote.* are not DRIVER_KINDS; call.transcribed is not a DRIVER_KIND
    expect(res.some((e) => e.kind.startsWith("quote."))).toBe(false);
    expect(res.some((e) => e.kind === "call.transcribed")).toBe(false);
  });

  it("proof 5 (ledger shape): the internal note lives IN the events ledger as message.received{channel:note, visibility:internal} — not a bespoke side table; the tenant lens sees the whole unredacted lane", async () => {
    const all = await readEvents(DB, { scope: "tenant" }, { shipment_id: SHIP });
    // the tenant sees all six events, unredacted (quote.priced keeps its internal floors)
    expect(all).toHaveLength(6);
    const priced = all.find((e) => e.kind === "quote.priced")!;
    expect((priced.payload as Record<string, unknown>).floors).toBeDefined();
    // the note is a first-class ledger event (a message.received), NOT a side record
    const note = all.find((e) => e.kind === "message.received" && channelOf(e) === "note")!;
    expect(note).toBeDefined();
    expect(note.visibility).toBe("internal");
  });
});
