import { SELF, env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyChain } from "@shuddl/ledger/chain";
import { rowToEvent } from "@shuddl/ledger/lens";
import type { LedgerEvent } from "@shuddl/contracts";
import { DISPATCH_REQUIRED_DOC_KIND } from "@shuddl/ledger/gates/transition-gates";
import { handleQuoteAccepted, QuoteAcceptedTrigger, bookingEventIdFor } from "../../agents/src/booking.js";
import type { BookingDeps } from "../../agents/src/booking.js";
import type { SeqStubLike } from "../../agents/src/biller.js";
import { localWall } from "../src/appointment-window.js";
import type { Env } from "../src/index.js";
import {
  TENANT_SLUG,
  TEST_FACILITY,
  TEST_RATE_CONFIG,
  ensureSchema,
  post,
  requiredEvidence,
  seedFacility,
  seedRateConfig,
  token,
  type Res,
} from "./helpers.js";

// ─── WP-10 T13 — THE COMMAND ACCEPTANCE HEARTBEAT (the L6 "10-minute CSR acceptance", as a code-provable spine) ──
//
// The WP-10 DoD: "10-minute CSR acceptance (L6) passes with a non-freight tester; every KPI clicks through to its
// ledger events." The HUMAN 10-minute test is not automatable — but its SPINE is: drive the full CSR command-surface
// flow through the REAL server seams end to end (mirroring the WP-08 booking-heartbeat / WP-06 heartbeat style),
// nothing mocked. Every write lands through the real sequencer DO (real Gatekeeper gates + projections); the party/
// shipment are the REAL Task-6 CSR intake seams; the quote is a real POST /v1/rate; the accept is the real
// portal-action seam; the booking is the real WP-08 Booking agent (T8) fed the EXACT queue trigger the DO enqueued.
// Only the tenant configs (rate/facility) and the REQ-184-deferred ratecon doc + the map position are seeded —
// everything causal is real, and every assertion checks a REAL outcome (ONE booking, the KPI deep-link resolving to
// a real event, the copilot citing a real event, the board carrying the real exception status). No fabrication.
//
//   ① CSR NET-NEW INTAKE → BOOK (REQ-150/195/028/042): a CSR keys three brand-new parties (POST /v1/parties),
//      materializes a quote-stage shipment (POST /v1/shipments), prices it (POST /v1/rate → quote.priced), accepts
//      the quote (POST /v1/shipments/:id/accept-quote → quote.accepted), and the DO enqueues the Booking trigger.
//      The real Booking agent, fed that captured trigger, books THROUGH the gated DO → EXACTLY ONE booking.created,
//      the shipment projects to `booked`.
//   ② SCHEDULE (REQ-052): appointment.set on the booked shipment claims a seeded dock slot → the pickup leg holds it.
//   ③ DISPATCH GATED, THEN ALLOWED (REQ-043): dispatch.assigned with NO ratecon → 403 GATE_BLOCKED ['docs'] (the
//      appointment is present, only the carrier paperwork is missing); seed the ratecon → dispatch.assigned → 201,
//      the shipment `dispatched` with its assigned driver.
//   ④ A KPI CLICKS THROUGH TO ITS LEDGER EVENTS (the DoD's explicit clause): GET /v1/kpis → take a tile's
//      backing.kinds → GET /v1/events?kind=<kinds> returns the tenant's real backing events, INCLUDING this
//      shipment's own quote.priced — the deep-link resolves to actual ledger events, never a placeholder.
//   ⑤ THE COPILOT ANSWERS WITH A CITATION (REQ-038): POST /v1/copilot/ask about the shipment → the AnswerResult
//      cites a REAL event id ON this shipment's stream (read-only — the stream is unchanged; it never fabricates).
//   ⑥ DEMO #5 — THE EXCEPTION PULSE: append exception.raised on the shipment → GET /v1/board returns it with
//      status:"exception" (the fleet mark the map renders as the pulse / world-dim trigger), on REAL ledger state.
//
// The whole chain stays ONE unbroken, hash-linked record (verifyChain.ok). isolatedStorage is OFF (shared D1):
// every id here is heartbeat-unique so nothing collides with sibling files.

const TENANT = TENANT_SLUG;
const HEX64 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const LANE = { origin_zip: "97201", dest_zip: "80012" }; // dest 80012 → "800" → Z5 → rg-far (TEST_RATE_CONFIG); prices PRICED, no below-floor approval
const FAC = "cmd-hb-fac";
const BILL_TO_EMAIL = "billing@cmd-hb.test"; // the CSR-captured deliverable contact — satisfies the REQ-182 booking evidence-recipient gate

// ── dock-slot instants (mirrors booking-heartbeat's DST-safe construction; a Monday ≥ now+3d, within horizon) ──
const LA = "America/Los_Angeles"; // TEST_FACILITY.hours.tz
const AM = "mon-am-dock-1"; // Monday 08:00–12:00 (min 480..720, dow 1)
const DAY = 86_400_000;

// The inverse of localWall (two-pass, tz-offset-correcting; Mondays never straddle a US DST switch, so it converges).
function zonedTimeToEpoch(y: number, mo: number, d: number, minuteOfDay: number, tz: string): number {
  const hh = Math.floor(minuteOfDay / 60);
  const mm = minuteOfDay % 60;
  const guess = Date.UTC(y, mo - 1, d, hh, mm);
  const w = localWall(guess, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  return guess - (asUtc - guess);
}
function nextLocalDow(targetDow: number, minDaysOut: number, base = Date.now()): { y: number; mo: number; d: number } {
  let probe = base + minDaysOut * DAY;
  for (let i = 0; i < 21; i++) {
    const w = localWall(probe, LA);
    if (w.dow === targetDow) return { y: w.year, mo: w.month, d: w.day };
    probe += DAY;
  }
  throw new Error(`no local dow ${targetDow} found`);
}
const MON = nextLocalDow(1, 3);
const AM_START = zonedTimeToEpoch(MON.y, MON.mo, MON.d, 480, LA);
const AM_END = zonedTimeToEpoch(MON.y, MON.mo, MON.d, 720, LA);

let clock = 1_733_100_000_000; // this file's own monotonic actor-ts base for the client-suppliable events (own streams anyway)

// ── the Booking agent's consumer deps against the REAL DO + D1 (mirrors booking-heartbeat) ──────────────
const seqStub: SeqStubLike = {
  append: (req) =>
    (env.SHIPMENT_SEQ.get(env.SHIPMENT_SEQ.idFromName(`${req.tenant}|${req.streamId}`)) as unknown as SeqStubLike).append(req),
};
const bookingDeps: BookingDeps = { db: env.TENANT_A_DB, seq: seqStub };

let opsTok: string;

// ── authed HTTP against the REAL worker. A mutation (body present) carries content-type + a fresh Idempotency-Key
// (the WP-01 idempotency middleware requires it); a GET carries neither. Tenant is the JWT claim ONLY (REQ-025). ──
async function authed(method: string, path: string, body?: unknown): Promise<Res> {
  const headers: Record<string, string> = { Authorization: `Bearer ${opsTok}` };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    headers["Idempotency-Key"] = crypto.randomUUID();
    init.body = JSON.stringify(body);
  }
  const res = await SELF.fetch(`https://api.local${path}`, init);
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

// A valid appointment.set EventInput claiming the pickup leg's dock slot (mirrors booking-heartbeat).
function apptInput(shipmentId: string): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    shipment_id: shipmentId,
    ts: clock++,
    actor: { party: "party-shipper" },
    party_refs: [],
    evidence: [],
    source: "native",
    confidence: 10_000,
    kind: "appointment.set",
    payload: { leg_kind: "pickup", facility_id: FAC, slot_key: AM, window_start_ts: AM_START, window_end_ts: AM_END },
  };
}

// A valid dispatch.assigned EventInput. actor.user is the assigned driver the status_cache projection reads (③).
function dispatchInput(shipmentId: string): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    shipment_id: shipmentId,
    ts: clock++,
    actor: { party: "party-carrier", user: "u-driver" },
    party_refs: [],
    evidence: [],
    source: "native",
    confidence: 10_000,
    kind: "dispatch.assigned",
    payload: { driver_user_id: "u-driver" },
  };
}

// An exception.raised EventInput (the durable exceptions signal — REQ-082 — that projects status_cache → 'exception').
function exceptionInput(shipmentId: string): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    shipment_id: shipmentId,
    ts: clock++,
    actor: { party: "party-carrier" },
    party_refs: [],
    evidence: [],
    source: "native",
    confidence: 10_000,
    kind: "exception.raised",
    payload: { photo_hash: HEX64, reason_code: "damage" },
  };
}

// ── producer-side observation: swap a recording AGENT_QUEUE onto the live DO instance so the message the DO hands
// Cloudflare Queues for a committed quote.accepted is captured verbatim (the honest spy booking-heartbeat uses),
// then fed — REAL wire payload — to the real consumer. ────────────────────────────────────────────────────────
async function patchAgentQueue(shipmentId: string, send: (m: unknown) => Promise<void>): Promise<void> {
  const stub = env.SHIPMENT_SEQ.get(env.SHIPMENT_SEQ.idFromName(`${TENANT}|s:${shipmentId}`));
  await runInDurableObject(stub, (instance) => {
    const inst = instance as unknown as { env: Env };
    inst.env = { ...inst.env, AGENT_QUEUE: { send } as unknown as Env["AGENT_QUEUE"] };
  });
}
// The enqueue rides ctx.waitUntil (off the response path), so give it a beat to settle.
async function settle(cond: () => boolean, ms = 1_000): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 10));
}

// ── seeders (the ONLY seeded shortcuts: tenant configs + the REQ-184-deferred ratecon doc + the map position) ──
async function seedRatecon(shipmentId: string): Promise<void> {
  await env.TENANT_A_DB.prepare("INSERT OR IGNORE INTO documents (id, shipment_id, kind, r2_key, hash) VALUES (?,?,?,?,?)")
    .bind(`doc-${shipmentId}-ratecon`, shipmentId, DISPATCH_REQUIRED_DOC_KIND, `r2/${shipmentId}/ratecon`, HEX64)
    .run();
}
// The physical GPS partition IS the mark's location (the board's truthful-map source, seeded exactly as board.test
// does — a position is not a client event on this surface). Without a position row the JOIN drops the shipment.
async function seedPosition(shipmentId: string, ts: number, latE6: number, lonE6: number): Promise<void> {
  await env.TENANT_A_DB.prepare(
    "INSERT OR IGNORE INTO positions (shipment_id, device_id, ts, recorded_at, lat_e6, lon_e6, accuracy_m, speed_cms, hash) VALUES (?,?,?,?,?,?,?,?,?)",
  )
    .bind(shipmentId, "device-1", ts, Date.now(), latE6, lonE6, null, null, `h-${shipmentId}-${ts}`)
    .run();
}

// ── DB probes ────────────────────────────────────────────────────────────────────────────────────────
async function streamEvents(shipmentId: string): Promise<LedgerEvent[]> {
  const res = await env.TENANT_A_DB.prepare("SELECT * FROM events WHERE stream_id = ? ORDER BY seq").bind(`s:${shipmentId}`).all();
  return (res.results as Record<string, string | number | null>[]).map((r) => rowToEvent(r));
}
async function eventKinds(shipmentId: string, kind: string): Promise<LedgerEvent[]> {
  return (await streamEvents(shipmentId)).filter((e) => e.kind === kind);
}
async function shipmentState(id: string): Promise<string | undefined> {
  const row = await env.TENANT_A_DB.prepare("SELECT json_extract(status_cache, '$.state') AS state FROM shipments WHERE id = ?").bind(id).first<{ state: string | null }>();
  return row?.state ?? undefined;
}
async function assignedDriver(id: string): Promise<string | undefined> {
  const row = await env.TENANT_A_DB.prepare("SELECT json_extract(status_cache, '$.assigned_driver') AS d FROM shipments WHERE id = ?").bind(id).first<{ d: string | null }>();
  return row?.d ?? undefined;
}
async function legSlot(shipmentId: string): Promise<string | null> {
  const row = await env.TENANT_A_DB.prepare("SELECT appt_slot_key FROM legs WHERE shipment_id = ? AND kind = 'pickup'").bind(shipmentId).first<{ appt_slot_key: string | null }>();
  return row?.appt_slot_key ?? null;
}

beforeAll(async () => {
  await ensureSchema(env);
  opsTok = await token({ sub: "cmd-hb-ops", tenant: TENANT, role: "ops" });
});

describe("COMMAND HEARTBEAT — CSR intake → book → schedule → dispatch → KPI click-through → copilot citation → exception pulse (REQ-028/043/052/082/083/038/150)", () => {
  it("the L6 10-minute CSR acceptance spine, one unbroken causal chain, through every real command seam", async () => {
    // ═══ ① CSR NET-NEW INTAKE → GATED BOOKING ═════════════════════════════════════════════════════════
    await seedRateConfig(env.TENANT_A_DB, TEST_RATE_CONFIG);

    // A CSR keys three brand-new parties (the real Task-6 intake seam). The bill_to carries the ONE deliverable
    // contact — the party the Biller emails, so the party the REQ-182 booking evidence gate checks.
    const shipperRes = await authed("POST", "/v1/parties", { kind: "shipper", name: "CMD HB Shipper Co" });
    expect([200, 201]).toContain(shipperRes.status);
    const consigneeRes = await authed("POST", "/v1/parties", { kind: "consignee", name: "CMD HB Consignee Co" });
    expect([200, 201]).toContain(consigneeRes.status);
    const billToRes = await authed("POST", "/v1/parties", { kind: "broker", name: "CMD HB Broker Co", email: BILL_TO_EMAIL });
    expect([200, 201]).toContain(billToRes.status);
    const shipperId = shipperRes.json!.id as string;
    const consigneeId = consigneeRes.json!.id as string;
    const billToId = billToRes.json!.id as string;

    // The CSR materializes a QUOTE-STAGE shipment (NO booking.created — the first real booking is still first on
    // the stream, so the WP-09 one-booking gate stays green).
    const shipmentRes = await authed("POST", "/v1/shipments", {
      shipper_party_id: shipperId,
      consignee_party_id: consigneeId,
      bill_to_party_id: billToId,
    });
    expect(shipmentRes.status, JSON.stringify(shipmentRes.json)).toBe(201);
    const MAIN = shipmentRes.json!.shipment_id as string;

    // A REAL POST /v1/rate prices the lane and records quote.priced (+ agent.acted) on the shipment stream.
    const rateRes = await authed("POST", "/v1/rate", { shipment_id: MAIN, ...LANE, weight_lb: 1000, dims: { l_in: 48, w_in: 40, h_in: 48, pieces: 2 } });
    expect(rateRes.status).toBe(200);
    expect(rateRes.json!.status).toBe("PRICED");

    // The quote.priced landed on the stream (the accept references it by its REAL id — never a hand-built one).
    const quoteRow = await env.TENANT_A_DB.prepare("SELECT id FROM events WHERE stream_id = ? AND kind = 'quote.priced'").bind(`s:${MAIN}`).first<{ id: string }>();
    expect(quoteRow).not.toBeNull();
    const quotePricedId = quoteRow!.id;

    // Arm the producer spy BEFORE the accept commits, so ITS enqueue is the one captured.
    const enqueued: unknown[] = [];
    await patchAgentQueue(MAIN, async (m) => { enqueued.push(m); });

    // The CSR accepts the priced quote through the REAL portal-action seam → committed quote.accepted → the DO
    // enqueues the Booking trigger. The CSR never emits booking.created — that is the agent's job, behind the gates.
    const acceptRes = await authed("POST", `/v1/shipments/${MAIN}/accept-quote`, { quote_event_id: quotePricedId });
    expect(acceptRes.status, JSON.stringify(acceptRes.json)).toBe(201);
    const acceptId = acceptRes.json!.id as string;

    // The queue seam: EXACTLY the consumer's trigger was enqueued for the committed accept (its own Zod boundary accepts it).
    await settle(() => enqueued.length > 0);
    await new Promise((r) => setTimeout(r, 25)); // drain beat — a buggy duplicate a few macrotasks later would fail the length assert
    expect(enqueued).toHaveLength(1);
    const trigger = QuoteAcceptedTrigger.parse(enqueued[0]);
    expect(trigger).toEqual({ kind: "quote.accepted", tenant: TENANT, shipment_id: MAIN, event_id: acceptId });

    // Drive the REAL Booking agent with the CAPTURED trigger: it appends booking.created THROUGH the gated DO.
    const outcome = await handleQuoteAccepted(trigger, bookingDeps);
    expect(outcome.status, JSON.stringify(outcome)).toBe("booked");
    const bookings = await eventKinds(MAIN, "booking.created");
    expect(bookings).toHaveLength(1); // EXACTLY ONE gated booking
    expect(bookings[0]!.id).toBe(await bookingEventIdFor(acceptId)); // deterministic id — derived from the accept, never minted
    expect(await shipmentState(MAIN)).toBe("booked"); // the T4 projection ran in the SAME booking batch

    // ═══ ② SCHEDULE — appointment.set CLAIMS A DOCK SLOT (REQ-052) ══════════════════════════════════════
    await seedFacility(env.TENANT_A_DB, { ...TEST_FACILITY, id: FAC });
    const claim = await post(MAIN, apptInput(MAIN), opsTok);
    expect(claim.status, JSON.stringify(claim.json)).toBe(201);
    expect(await legSlot(MAIN)).toBe(AM); // the pickup leg (materialized by the booking) now holds the claimed slot

    // ═══ ③ DISPATCH GATED, THEN ALLOWED (REQ-043) ══════════════════════════════════════════════════════
    // Booked + scheduled but NO ratecon → the real dispatch gate blocks on ['docs'] only (appointment present), ZERO append.
    const blocked = await post(MAIN, dispatchInput(MAIN), opsTok);
    expect(blocked.status).toBe(403);
    expect(blocked.json?.code).toBe("GATE_BLOCKED");
    expect(requiredEvidence(blocked)).toEqual(["docs"]);

    // Seed the rate-con (REQ-184 generation deferred — seeded as the dispatch-gate tests do); now dispatch passes.
    await seedRatecon(MAIN);
    const dispatched = await post(MAIN, dispatchInput(MAIN), opsTok);
    expect(dispatched.status, JSON.stringify(dispatched.json)).toBe(201);
    expect(await shipmentState(MAIN)).toBe("dispatched");
    expect(await assignedDriver(MAIN)).toBe("u-driver");

    // ═══ ④ A KPI CLICKS THROUGH TO ITS LEDGER EVENTS (the DoD's explicit clause, REQ-083) ═══════════════
    // GET /v1/kpis → pick a tile whose backing kinds include this shipment's own signal (quote.priced) → feed
    // backing.kinds to GET /v1/events?kind= (the Task-1 firehose deep-link) → it resolves to the REAL backing
    // events, INCLUDING MAIN's quote.priced. Every returned event is one of the tile's kinds — never a placeholder.
    const kpisRes = await authed("GET", "/v1/kpis");
    expect(kpisRes.status).toBe(200);
    const kpis = kpisRes.json!.kpis as Array<{ key: string; backing: { kinds: string[] } }>;
    const tile = kpis.find((t) => t.backing.kinds.includes("quote.priced"));
    expect(tile, "a KPI tile must back on quote.priced for the click-through").toBeDefined();
    const kinds = tile!.backing.kinds;
    const eventsRes = await authed("GET", `/v1/events?kind=${kinds.join(",")}&limit=1000`);
    expect(eventsRes.status).toBe(200);
    const backing = eventsRes.json!.events as Array<{ id: string; kind: string }>;
    expect(backing.every((e) => kinds.includes(e.kind))).toBe(true); // the deep-link honors the tile's kinds
    expect(backing.some((e) => e.id === quotePricedId)).toBe(true); // …and resolves to MAIN's REAL backing event

    // ═══ ⑤ THE COPILOT ANSWERS WITH A CITATION (REQ-038) ═══════════════════════════════════════════════
    // A read-only question about the shipment → an answer that CITES a REAL event id on MAIN's stream (or honestly
    // abstains). Here the shipment has a rich stream, so it answers with citations — every one a real MAIN event.
    const mainIds = new Set((await streamEvents(MAIN)).map((e) => e.id));
    const ask = await authed("POST", "/v1/copilot/ask", { question: `what's the status of shipment ${MAIN}?` });
    expect(ask.status).toBe(200);
    const answer = ask.json as unknown as { text: string; citations: Array<{ event_id: string; shipment_id?: string }>; abstained: boolean };
    expect(answer.abstained).toBe(false);
    expect(answer.citations.length).toBeGreaterThanOrEqual(1);
    expect(answer.citations.every((cit) => mainIds.has(cit.event_id))).toBe(true); // every citation is a REAL event on MAIN's stream
    expect(answer.citations.every((cit) => cit.shipment_id === MAIN)).toBe(true);
    expect(answer.text).toContain(MAIN);

    // ═══ ⑥ DEMO #5 — THE EXCEPTION PULSE (REQ-082/073/080) ═════════════════════════════════════════════
    // A REAL exception.raised → the status_cache projection sets state='exception'. With a position on the map,
    // GET /v1/board returns MAIN carrying status:"exception" — the fleet mark the map dims the world around. On
    // REAL ledger state (the exception event + its projection), never synthetic demoFleet.
    const exc = await post(MAIN, exceptionInput(MAIN), opsTok);
    expect(exc.status, JSON.stringify(exc.json)).toBe(201);
    expect(await shipmentState(MAIN)).toBe("exception");
    await seedPosition(MAIN, 9_999_999_999, 40_000_000, -75_000_000); // place the mark (the physical GPS partition)
    const boardRes = await authed("GET", "/v1/board");
    expect(boardRes.status).toBe(200);
    const board = boardRes.json!.board as Array<{ shipment_id: string; status: string }>;
    const mark = board.find((b) => b.shipment_id === MAIN);
    expect(mark, "the exception shipment must surface on the live board").toBeDefined();
    expect(mark!.status).toBe("exception"); // the pulse / world-dim trigger, on real data

    // ═══ THE WHOLE CHAIN IS ONE UNBROKEN, HASH-LINKED RECORD ═══════════════════════════════════════════
    // quote.priced → agent.acted → quote.accepted → booking.created → appointment.set → dispatch.assigned →
    // exception.raised: every prev_hash → hash link holds across the entire command heartbeat.
    const chain = await streamEvents(MAIN);
    expect(chain.map((e) => e.kind)).toEqual([
      "quote.priced", "agent.acted", "quote.accepted", "booking.created", "appointment.set", "dispatch.assigned", "exception.raised",
    ]);
    expect((await verifyChain(chain)).ok).toBe(true);
  });
});
