import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { EVENT_KINDS, type EventKind } from "@shuddl/contracts";
import { KIND_VISIBILITY_DEFAULTS } from "@shuddl/ledger/visibility";
import { DRIVER_KINDS } from "@shuddl/ledger/lens";
import { canonicalBytes, sha256Hex } from "@shuddl/ledger/canonical";
import { ensureSchema, token, TENANT_SLUG } from "./helpers.js";

// REQ-015 / I6 — THE ADVERSARIAL LENS SUITE (WP-02 DoD: "lens tests prove scoping").
//
// Every case seeds through the REAL append path (POST /v1/shipments/:id/events) — direct DB inserts
// would prove nothing about the routes — and then asserts on the RAW serialized response body a client
// would receive. The lens is derived from the JWT claim ONLY; a forged party_id/tenant on the wire is
// never consulted. Sibling to the WP-01 tenant-isolation suite (REQ-025), which case 10 extends here.

// The cast: one tenant, shipper P1, consignee P2, cartage P3, drivers D1/D2. Ids are prefixed `adv-`
// and are unique to this file — the harness shares ONE D1 across files (isolatedStorage:false), so we
// scope every stream/party/shipment id to ourselves and never assume an empty table.
const P1 = "adv-p1-shipper";
const P2 = "adv-p2-consignee";
const P3 = "adv-p3-cartage";
const D1 = "adv-d1";
const D2 = "adv-d2";

const SHP_A = "adv-shp-a"; // comprehensive: one event of every route-appendable kind; assigned D1
const SHP_B = "adv-shp-b"; // P2-only; assigned D2
const SHP_GEO = "adv-shp-geo"; // geo-privacy case; P1+P2; OFD flipped mid-test
const FIRE_1 = "adv-fire-1"; // firehose keyset streams
const FIRE_2 = "adv-fire-2";

const HEX64 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const GEO = { lat_e6: 37_421_000, lon_e6: -122_084_000, accuracy_m: 5 };

// ---- tokens (claim-only lens; never a header/param) --------------------------------------
const opsTok = (): Promise<string> => token({ sub: "adv-ops", tenant: TENANT_SLUG, role: "ops" });
const portalTok = (partyId: string): Promise<string> =>
  token({ sub: `${partyId}-user`, tenant: TENANT_SLUG, role: "portal", party_id: partyId });
const driverTok = (driver: string): Promise<string> => token({ sub: driver, tenant: TENANT_SLUG, role: "driver" });

// ---- per-kind minimal-valid payloads / actor overrides -----------------------------------
function payloadFor(kind: EventKind): Record<string, unknown> {
  switch (kind) {
    case "booking.created":
      return { division: "main", shipper_party_id: P1, consignee_party_id: P2, bill_to_party_id: P2, created_ts: 1_720_000_000_000 };
    case "quote.priced":
      return { sell: 120_000, floors: { contribution: 60_000, full: 90_000, target: 100_000 }, versions: { rate_config_ids: ["rc-1"] }, basis: {} };
    case "pod.signed":
      return { signature_hash: HEX64, geo: { ...GEO }, unwitnessed: true };
    case "custody.transferred":
      return { from_party: P1, to_party: P3, geo: { ...GEO }, unwitnessed: true };
    case "agent.acted":
      return { agent: "biller", action: "draft", basis: [{ kind: "event", id: "e-1" }], confidence_bps: 9_000 };
    case "invoice.issued":
      return { invoice_id: `inv-${SHP_A}`, party_id: P2, division: "main", lines: [{ line_no: 1, kind: "freight", amount_cents: 120_000, gl_map: "4000-REV" }] };
    case "split.computed":
      return { total_cents: 120_000, allocations: [{ party_id: P3, share_bps: 3_000 }, { party_id: P1, share_bps: 7_000 }] };
    case "stop.arrived":
    case "stop.departed":
      return { geo: { ...GEO }, auto: true };
    case "freight.counted":
      return { pieces: 12 };
    case "freight.photographed":
      return { photo_hash: HEX64, photo_kind: "freight" };
    case "dims.captured":
      return { l_in: 48, w_in: 40, h_in: 60, pieces: 4, method: "camera" };
    case "seal.applied":
      return { seal_id: "seal-1", photo_hash: HEX64 };
    case "osd.captured":
      return { photo_hash: HEX64, reason_code: "damage" };
    case "delivery.evidenced":
      return { placed_photo_hash: HEX64, geo: { ...GEO } };
    default:
      return {};
  }
}

// actor.party for pod/custody/osd/exception MUST be a real party (passport FK); dispatch.assigned's
// actor.user is the driver the status-cache projection binds the shipment to.
function actorFor(kind: EventKind): { party: string; user?: string; device?: string } {
  if (kind === "dispatch.assigned") return { party: P1, user: D1 };
  return { party: P1 };
}

function buildInput(shipmentId: string, kind: EventKind, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    shipment_id: shipmentId,
    ts: 1_720_000_000_000,
    actor: actorFor(kind),
    party_refs: [P1, P2, P3],
    evidence: [],
    source: "native",
    confidence: 10_000,
    kind,
    payload: payloadFor(kind),
    ...over,
  };
}

interface AppendResult {
  status: number;
  body: string;
  json: Record<string, unknown> | null;
}

async function append(shipmentId: string, input: Record<string, unknown>, tok: string): Promise<AppendResult> {
  const res = await SELF.fetch(`https://api.local/v1/shipments/${shipmentId}/events`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await res.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  return { status: res.status, body, json: parsed };
}

interface ListResult {
  status: number;
  body: string;
  events: Array<Record<string, unknown>>;
  next_cursor: string | null;
}

async function listShipment(shipmentId: string, tok: string, query = ""): Promise<ListResult> {
  const res = await SELF.fetch(`https://api.local/v1/shipments/${shipmentId}/events${query}`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  const body = await res.text();
  const parsed = res.status === 200 ? (JSON.parse(body) as { events: Array<Record<string, unknown>>; next_cursor: string | null }) : { events: [], next_cursor: null };
  return { status: res.status, body, events: parsed.events, next_cursor: parsed.next_cursor };
}

async function listFirehose(tok: string, query = ""): Promise<ListResult> {
  const res = await SELF.fetch(`https://api.local/v1/events${query}`, { headers: { Authorization: `Bearer ${tok}` } });
  const body = await res.text();
  const parsed = res.status === 200 ? (JSON.parse(body) as { events: Array<Record<string, unknown>>; next_cursor: string | null }) : { events: [], next_cursor: null };
  return { status: res.status, body, events: parsed.events, next_cursor: parsed.next_cursor };
}

const kindsOf = (events: Array<Record<string, unknown>>): Set<string> => new Set(events.map((e) => e.kind as string));

// The route-appendable kinds: every kind except position.updated (which bypasses the sequencer and lives
// in the `positions` partition — POST /v1/positions, not the events table; the DO rejects it here).
const APPENDABLE = EVENT_KINDS.filter((k) => k !== "position.updated");

// Seeded ids captured for cross-referencing (invoice.issued -> invoice.corrected -> netting).
let invoiceIssuedId = "";
let invoiceCorrectedId = "";

beforeAll(async () => {
  await ensureSchema(env);
  const ops = await opsTok();

  // P1/P2/P3 must exist as parties: they are actors on passport-accruing events (FK parties(id)).
  for (const [id, kind] of [[P1, "shipper"], [P2, "consignee"], [P3, "carrier"]] as const) {
    await env.TENANT_A_DB.prepare("INSERT OR IGNORE INTO parties (id, kind, names) VALUES (?,?,?)").bind(id, kind, "{}").run();
  }

  // ---- Shipment A: one of every route-appendable kind, in dependency order ----
  // booking.created first (creates the shipments row); dispatch.assigned binds D1; pod.signed before
  // invoice.issued (I2 gate); invoice.corrected references the issued event id.
  const ORDER: EventKind[] = [
    "booking.created", "dispatch.assigned",
    "quote.requested", "quote.priced", "quote.sent", "quote.accepted", "quote.expired",
    "credit.checked", "appointment.set", "pickup.scheduled",
    "stop.arrived", "freight.counted", "freight.photographed", "dims.captured",
    "custody.transferred", "seal.applied", "stop.departed",
    "exception.raised", "osd.captured", "pod.signed", "delivery.evidenced",
    "invoice.issued", "payment.received", "settlement.executed", "split.computed",
    "message.received", "message.sent", "call.transcribed",
    "document.attached", "approval.requested", "approval.decided", "agent.acted", "authority.flipped",
  ];
  for (const kind of ORDER) {
    const r = await append(SHP_A, buildInput(SHP_A, kind), ops);
    if (r.status !== 201) throw new Error(`seed ${SHP_A}/${kind} failed: ${r.status} ${r.body}`);
    if (kind === "invoice.issued") invoiceIssuedId = r.json!.id as string;
  }
  // invoice.corrected — a void (full reversal) so the money nets to zero (case 8).
  {
    const r = await append(
      SHP_A,
      buildInput(SHP_A, "invoice.corrected", {
        payload: { invoice_id: `inv-${SHP_A}`, corrects_event_id: invoiceIssuedId, reason: "reweigh correction", reissue_lines: [] },
      }),
      ops,
    );
    if (r.status !== 201) throw new Error(`seed ${SHP_A}/invoice.corrected failed: ${r.status} ${r.body}`);
    invoiceCorrectedId = r.json!.id as string;
  }
  // sanity: A appended every appendable kind
  expect(new Set(APPENDABLE).size).toBe(ORDER.length + 1); // +1 for invoice.corrected

  // ---- Shipment B: P2-only, assigned D2 ----
  await append(SHP_B, buildInput(SHP_B, "booking.created", { party_refs: [P2] }), ops).then((r) => {
    if (r.status !== 201) throw new Error(`seed ${SHP_B}/booking failed: ${r.body}`);
  });
  await append(SHP_B, buildInput(SHP_B, "dispatch.assigned", { party_refs: [P2], actor: { party: P2, user: D2 } }), ops);
  await append(SHP_B, buildInput(SHP_B, "stop.arrived", { party_refs: [P2] }), ops);
  await append(SHP_B, buildInput(SHP_B, "custody.transferred", { party_refs: [P2], actor: { party: P2 }, payload: { from_party: P2, to_party: P3, geo: { ...GEO }, unwitnessed: true } }), ops);

  // ---- Shipment GEO: P1+P2, geo-bearing kinds; OFD flipped mid-test in case 5 ----
  await append(SHP_GEO, buildInput(SHP_GEO, "booking.created", { party_refs: [P1, P2] }), ops);
  await append(SHP_GEO, buildInput(SHP_GEO, "custody.transferred", { party_refs: [P1, P2] }), ops);
  await append(SHP_GEO, buildInput(SHP_GEO, "pod.signed", { party_refs: [P1, P2] }), ops);

  // ---- Firehose keyset streams: two streams with overlapping seq ranges (0,1,2 each) ----
  for (const shp of [FIRE_1, FIRE_2]) {
    for (let i = 0; i < 3; i++) await append(shp, buildInput(shp, "quote.requested"), ops);
  }
});

// 1 — a portal party never sees internal-visibility kinds on a shipment it IS party to.
describe("case 1: portal P1 sees zero internal kinds", () => {
  it("no approval.*, agent.acted, split.computed, credit.checked, call.transcribed in the raw body", async () => {
    const res = await listShipment(SHP_A, await portalTok(P1));
    expect(res.status).toBe(200);
    for (const hidden of ["approval.requested", "approval.decided", "agent.acted", "split.computed", "credit.checked", "call.transcribed"]) {
      expect(res.body).not.toContain(hidden);
    }
    // positive control: P1 DOES see a counterparty kind on the same shipment
    expect(res.body).toContain("pod.signed");
  });
});

// 2 — quote internals are redacted for a party lens: sell stays, floors/basis/versions vanish.
describe("case 2: P1 reads quote.priced with margins stripped", () => {
  it("payload.sell present; 'floors' / 'basis' / 'versions' appear NOWHERE in the body", async () => {
    const res = await listShipment(SHP_A, await portalTok(P1));
    const priced = res.events.find((e) => e.kind === "quote.priced");
    expect(priced).toBeDefined();
    expect((priced!.payload as Record<string, unknown>).sell).toBe(120_000);
    for (const s of ["floors", "basis", "versions"]) expect(res.body).not.toContain(s);
  });
});

// 3 — a party lens can't cross to another party's shipment; a forged ?party_id is ignored (claim wins).
describe("case 3: P1 on a P2-only shipment is empty; forged party_id is ignored", () => {
  it("empty, and identical with a forged ?party_id=P2 on the query string", async () => {
    const tok = await portalTok(P1);
    const clean = await listShipment(SHP_B, tok);
    const forged = await listShipment(SHP_B, tok, `?party_id=${P2}`);
    expect(clean.status).toBe(200);
    expect(clean.events).toEqual([]);
    expect(forged.status).toBe(200);
    expect(forged.events).toEqual([]); // the claim wins — the query param never widens the lens
    expect(forged.body).toBe(clean.body);
  });
});

// 4 — driver lens: another driver's shipment is invisible; even on its OWN shipment a non-driver kind
// (invoice.issued) is excluded by the allowlist.
describe("case 4: driver D1 scoping", () => {
  it("D1 on D2's shipment is empty", async () => {
    const res = await listShipment(SHP_B, await driverTok(D1));
    expect(res.status).toBe(200);
    expect(res.events).toEqual([]);
  });
  it("D1 on its own shipment sees driver kinds but never invoice.issued", async () => {
    const res = await listShipment(SHP_A, await driverTok(D1));
    expect(res.status).toBe(200);
    expect(res.body).not.toContain("invoice.issued");
    expect(res.body).not.toContain("invoice.corrected");
    expect(kindsOf(res.events).has("pod.signed")).toBe(true); // a driver kind IS present
  });
});

// 5 — geo privacy is structural (not just position.updated): a consignee gets coarse coords with no
// accuracy pre-OFD, exact coords once out-for-delivery. Tested on custody.transferred AND pod.signed.
describe("case 5: consignee P2 geo coarsens pre-OFD, unlocks post-OFD", () => {
  it("coarse (lat_e6 % 100000 === 0, no accuracy_m) before OFD; exact after the flag flips", async () => {
    const p2 = await portalTok(P2);
    const pre = await listShipment(SHP_GEO, p2);
    const geoOf = (evs: Array<Record<string, unknown>>, kind: string): Record<string, unknown> =>
      (evs.find((e) => e.kind === kind)!.payload as { geo: Record<string, unknown> }).geo;

    for (const kind of ["custody.transferred", "pod.signed"]) {
      const g = geoOf(pre.events, kind);
      // `=== 0` (not toBe/Object.is): a negative multiple's modulo is -0, still a clean multiple.
      expect((g.lat_e6 as number) % 100_000 === 0).toBe(true);
      expect((g.lon_e6 as number) % 100_000 === 0).toBe(true);
      expect(g.lat_e6).not.toBe(GEO.lat_e6); // and it is actually coarsened, not the exact value
      expect(g.accuracy_m).toBeUndefined();
    }

    // Flip out-for-delivery (driver PWA gesture in prod; ops append here) and re-read.
    const flip = await append(SHP_GEO, buildInput(SHP_GEO, "stop.departed", { party_refs: [P1, P2], payload: { geo: { ...GEO }, auto: false, out_for_delivery: true } }), await opsTok());
    expect(flip.status).toBe(201);

    const post = await listShipment(SHP_GEO, p2);
    for (const kind of ["custody.transferred", "pod.signed"]) {
      const g = geoOf(post.events, kind);
      expect(g.lat_e6).toBe(GEO.lat_e6); // exact now
      expect(g.lon_e6).toBe(GEO.lon_e6);
      expect(g.accuracy_m).toBe(GEO.accuracy_m);
    }
  });
});

// 6 — requested_visibility can only NARROW: a widening request is dropped, the event stays internal.
describe("case 6: requested_visibility 'counterparty' on an internal kind is ignored", () => {
  it("approval.requested stays internal (the POST response body proves the stored visibility)", async () => {
    const r = await append(SHP_A, buildInput(SHP_A, "approval.requested", { requested_visibility: "counterparty" }), await opsTok());
    expect(r.status).toBe(201);
    expect(r.json!.visibility).toBe("internal"); // counterparty is WIDER than internal -> not applied
    // and it never surfaces to P1
    const p1 = await listShipment(SHP_A, await portalTok(P1));
    expect(p1.events.some((e) => e.id === r.json!.id)).toBe(false);
  });
});

// 7 — a custody.transferred naming two parties is seen once by each — no duplication, no leak.
describe("case 7: custody.transferred with P1 and P3 in party_refs", () => {
  it("P1 sees it exactly once; P3 sees it exactly once", async () => {
    for (const party of [P1, P3]) {
      const res = await listShipment(SHP_A, await portalTok(party));
      const custody = res.events.filter((e) => e.kind === "custody.transferred");
      expect(custody).toHaveLength(1);
    }
  });
});

// 8 — a correction pair is both visible under a party lens AND nets to zero (I7 inside a lens).
describe("case 8: correction pair visible to P1, money nets to zero", () => {
  it("both legs in P1's body; money_lines for the pair sum to zero", async () => {
    const res = await listShipment(SHP_A, await portalTok(P1));
    expect(res.events.some((e) => e.id === invoiceIssuedId)).toBe(true);
    expect(res.events.some((e) => e.id === invoiceCorrectedId)).toBe(true);
    const row = await env.TENANT_A_DB.prepare(
      "SELECT COALESCE(SUM(amount_cents),0) AS total FROM money_lines WHERE event_id IN (?, ?)",
    )
      .bind(invoiceIssuedId, invoiceCorrectedId)
      .first<{ total: number }>();
    expect(row!.total).toBe(0);
  });
});

// 9 — THE I6 SWEEP: every route-appendable kind × {tenant, party, driver} lens, asserted against the
// REAL exported maps (KIND_VISIBILITY_DEFAULTS + DRIVER_KINDS). Internal kinds never reach party/driver.
describe("case 9: table-driven I6 visibility sweep on shipment A", () => {
  it("each lens sees exactly the kinds its scope permits", async () => {
    const driverAllow = new Set<string>(DRIVER_KINDS);
    const tenant = kindsOf((await listShipment(SHP_A, await opsTok())).events);
    const party = kindsOf((await listShipment(SHP_A, await portalTok(P1))).events);
    const driver = kindsOf((await listShipment(SHP_A, await driverTok(D1))).events);

    for (const kind of APPENDABLE) {
      const isInternal = KIND_VISIBILITY_DEFAULTS[kind] === "internal";
      // tenant lens sees the unredacted truth — every appended kind is present.
      expect(tenant.has(kind), `tenant should see ${kind}`).toBe(true);
      // party lens sees a kind iff it is NOT internal.
      expect(party.has(kind), `party visibility wrong for ${kind}`).toBe(!isInternal);
      // driver lens sees a kind iff it is NOT internal AND on the driver allowlist.
      expect(driver.has(kind), `driver visibility wrong for ${kind}`).toBe(!isInternal && driverAllow.has(kind));
    }
    // explicit spot-checks so a map regression can't pass by making every kind vanish
    expect(party.has("credit.checked")).toBe(false);
    expect(driver.has("invoice.issued")).toBe(false);
    expect(driver.has("pod.signed")).toBe(true);
  });
});

// 9b — INDEPENDENT I6 guards. Case 9 above derives its expectation from the SAME maps the routes
// consume, so a map regression moves both sides in lockstep and the sweep still passes (it cannot go
// red on a real leak — proven: flipping authority.flipped to counterparty leaves case 9 green). These
// two guards do NOT import the map under test. A hardcoded internal-kind literal proves BEHAVIOR (no
// internal control event ever reaches a party/driver body); a frozen 35-pair snapshot proves the MAP
// itself, so any drift fails a dedicated, obviously-named test instead of moving the goalposts.
const INTERNAL_KINDS_FROZEN = [
  "credit.checked", "split.computed", "call.transcribed",
  "approval.requested", "approval.decided", "agent.acted", "authority.flipped",
] as const;

const FROZEN_DEFAULTS: Record<EventKind, "internal" | "counterparty" | "public"> = {
  "quote.requested": "counterparty", "quote.priced": "counterparty", "quote.sent": "counterparty",
  "quote.accepted": "counterparty", "quote.expired": "counterparty", "booking.created": "counterparty",
  "appointment.set": "counterparty", "pickup.scheduled": "counterparty", "dispatch.assigned": "counterparty",
  "stop.arrived": "counterparty", "freight.counted": "counterparty", "freight.photographed": "counterparty",
  "dims.captured": "counterparty", "custody.transferred": "counterparty", "seal.applied": "counterparty",
  "stop.departed": "counterparty", "position.updated": "counterparty", "exception.raised": "counterparty",
  "osd.captured": "counterparty", "pod.signed": "counterparty", "delivery.evidenced": "counterparty",
  "invoice.issued": "counterparty", "invoice.corrected": "counterparty", "payment.received": "counterparty",
  "settlement.executed": "counterparty", "message.received": "counterparty", "message.sent": "counterparty",
  "document.attached": "counterparty",
  "credit.checked": "internal", "split.computed": "internal", "call.transcribed": "internal",
  "approval.requested": "internal", "approval.decided": "internal", "agent.acted": "internal",
  "authority.flipped": "internal",
};

describe("case 9b: independent I6 guards (do NOT import the map under test)", () => {
  it("no internal control kind ever reaches a party or driver lens (hardcoded literal, not the map)", async () => {
    const party = await listShipment(SHP_A, await portalTok(P1));
    const driver = await listShipment(SHP_A, await driverTok(D1));
    // shipment A carries one event of every appendable kind (incl. all seven below), so a leak shows up.
    for (const kind of INTERNAL_KINDS_FROZEN) {
      expect(party.body, `party lens leaked internal kind ${kind}`).not.toContain(kind);
      expect(driver.body, `driver lens leaked internal kind ${kind}`).not.toContain(kind);
    }
  });

  it("KIND_VISIBILITY_DEFAULTS equals its frozen 35-pair snapshot (drift fails HERE, by name)", () => {
    expect(Object.keys(FROZEN_DEFAULTS)).toHaveLength(35);
    expect(KIND_VISIBILITY_DEFAULTS).toEqual(FROZEN_DEFAULTS);
  });
});

// The firehose: composite (stream_id, seq) keyset — tenant-lens roles only; portal/driver must scope
// by shipment. A cursor at a stream boundary must NOT drop the next stream's low-seq rows.
describe("firehose GET /v1/events", () => {
  it("is forbidden to portal and driver sessions (they must scope by shipment)", async () => {
    expect((await listFirehose(await portalTok(P1))).status).toBe(403);
    expect((await listFirehose(await driverTok(D1))).status).toBe(403);
  });

  it("composite cursor advances past a stream boundary without dropping low-seq rows", async () => {
    const ops = await opsTok();
    // cursor at the end of FIRE_1 (seq 2). FIRE_2's rows have seq 0,1,2 (<= 2): a seq-only filter would
    // wrongly drop them; the composite (stream_id,seq) keyset must return all three.
    const res = await listFirehose(ops, `?cursor=${encodeURIComponent(`s:${FIRE_1}:2`)}&limit=500`);
    expect(res.status).toBe(200);
    const fire2 = res.events.filter((e) => e.stream_id === `s:${FIRE_2}`).map((e) => e.seq as number).sort((a, b) => a - b);
    expect(fire2).toEqual([0, 1, 2]);
    // and the cursor excludes FIRE_1's already-seen rows
    expect(res.events.some((e) => e.stream_id === `s:${FIRE_1}` && (e.seq as number) <= 2)).toBe(false);
  });

  it("paginates with a keyset cursor across the whole tenant with no dropped or duplicated rows", async () => {
    const ops = await opsTok();
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let i = 0; i < 200; i++) {
      const q: string = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : "?limit=100";
      const page: ListResult = await listFirehose(ops, q);
      expect(page.status).toBe(200);
      for (const e of page.events) {
        const key = `${e.stream_id as string}:${e.seq as number}`;
        expect(seen.has(key), `duplicate keyset row ${key}`).toBe(false);
        seen.add(key);
      }
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    // our six firehose rows are all present exactly once
    for (const shp of [FIRE_1, FIRE_2]) for (let s = 0; s < 3; s++) expect(seen.has(`s:${shp}:${s}`)).toBe(true);
  });

  it("surfaces a bad cursor mode (after_seq without a shipment scope) as a clean 400, not a 500", async () => {
    const res = await SELF.fetch("https://api.local/v1/events?after_seq=1", { headers: { Authorization: `Bearer ${await opsTok()}` } });
    expect(res.status).toBe(400);
  });
});

// Driver WRITE authorization (the handler rule the plan leaves to the route): a driver may append only
// to a shipment assigned to them.
describe("driver append authorization", () => {
  it("D2 cannot append to D1's shipment (FORBIDDEN)", async () => {
    const r = await append(SHP_A, buildInput(SHP_A, "stop.arrived"), await driverTok(D2));
    expect(r.status).toBe(403);
  });
  it("D1 CAN append to its own assigned shipment", async () => {
    const r = await append(SHP_A, buildInput(SHP_A, "stop.arrived"), await driverTok(D1));
    expect(r.status).toBe(201);
  });
  it("a finance/read role cannot append at all (role gate)", async () => {
    const r = await append(SHP_A, buildInput(SHP_A, "stop.arrived"), await token({ sub: "adv-fin", tenant: TENANT_SLUG, role: "finance" }));
    expect(r.status).toBe(403);
  });
});

// Gate refusal reaches the client as the ENVELOPE with gate.required_evidence intact (error translation
// is the route's job — the DO throws a plain `Error("CODE:json")` across the RPC hop).
describe("gate refusal envelope", () => {
  it("invoice.issued with no pod.signed on the stream -> 403 with gate.required_evidence", async () => {
    const shp = "adv-shp-gate";
    const ops = await opsTok();
    await append(shp, buildInput(shp, "booking.created", { party_refs: [P1] }), ops);
    const r = await append(shp, buildInput(shp, "invoice.issued", { payload: { invoice_id: "inv-gate", party_id: P2, division: "main", lines: [{ line_no: 1, kind: "freight", amount_cents: 100, gl_map: "4000-REV" }] } }), ops);
    expect(r.status).toBe(403);
    expect(r.json!.code).toBe("GATE_BLOCKED");
    expect((r.json!.gate as { required_evidence: string[] }).required_evidence).toEqual(["pod.signed"]);
  });
});

// Mutations require an Idempotency-Key (the WP-01 middleware); confirm the ledger routes are under it.
describe("mutation idempotency", () => {
  it("POST /v1/shipments/:id/events without Idempotency-Key is 400", async () => {
    const res = await SELF.fetch(`https://api.local/v1/shipments/${SHP_A}/events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await opsTok()}`, "content-type": "application/json" },
      body: JSON.stringify(buildInput(SHP_A, "stop.arrived")),
    });
    expect(res.status).toBe(400);
  });
});

// POST /v1/positions — the partition. Bypasses the sequencer; PK (shipment_id, device_id, ts) +
// INSERT OR IGNORE dedupes the row; hash = sha256(canonical(row)) is stable across re-ingest.
describe("POST /v1/positions", () => {
  async function postPosition(input: Record<string, unknown>, tok: string): Promise<Response> {
    return SELF.fetch("https://api.local/v1/positions", {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  it("a driver posts a position; the row lands with a canonical hash", async () => {
    const pos = { shipment_id: "adv-pos-1", device_id: "dev-x", ts: 1_720_000_000_111, lat_e6: 37_421_000, lon_e6: -122_084_000, accuracy_m: 5, speed_cms: 1_500 };
    const res = await postPosition(pos, await driverTok(D1));
    expect(res.status).toBe(201);
    const row = await env.TENANT_A_DB.prepare("SELECT * FROM positions WHERE shipment_id=? AND device_id=? AND ts=?").bind(pos.shipment_id, pos.device_id, pos.ts).first<Record<string, string | number | null>>();
    expect(row).not.toBeNull();
    const expected = await sha256Hex(canonicalBytes({ shipment_id: pos.shipment_id, device_id: pos.device_id, ts: pos.ts, lat_e6: pos.lat_e6, lon_e6: pos.lon_e6, accuracy_m: pos.accuracy_m, speed_cms: pos.speed_cms }));
    expect(row!.hash).toBe(expected);
    expect(row!.recorded_at).toEqual(expect.any(Number));
  });

  it("re-ingesting the same position (fresh Idempotency-Key) is a no-op dedupe, not an error", async () => {
    const pos = { shipment_id: "adv-pos-2", device_id: "dev-y", ts: 1_720_000_000_222, lat_e6: 1_000_001, lon_e6: 2_000_002 };
    expect((await postPosition(pos, await driverTok(D1))).status).toBe(201);
    expect((await postPosition(pos, await driverTok(D1))).status).toBe(201); // PK + INSERT OR IGNORE
    const n = await env.TENANT_A_DB.prepare("SELECT COUNT(*) AS n FROM positions WHERE shipment_id=? AND device_id=? AND ts=?").bind(pos.shipment_id, pos.device_id, pos.ts).first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it("rejects a float coordinate (integer-only canonical law)", async () => {
    const res = await postPosition({ shipment_id: "adv-pos-3", device_id: "dev-z", ts: 1_720_000_000_333, lat_e6: 1.5, lon_e6: 2 }, await driverTok(D1));
    expect(res.status).toBe(400);
  });

  // A PK conflict with DIFFERENT data trips positions_guard_ins (RAISE(ABORT)). Integrity holds (the row
  // is NOT rewritten), but it is a CLIENT conflict — it must surface as 400, never a 500 (which a client
  // would retry forever and which would pollute Watchtower's unhandled-error alarm).
  it("a same-PK re-ingest with DIFFERENT coordinates is a 400 (not a 500), and the row is not rewritten", async () => {
    const base = { shipment_id: "adv-pos-conflict", device_id: "dev-c", ts: 1_720_000_000_777, lat_e6: 10_000_000, lon_e6: 20_000_000 };
    expect((await postPosition(base, await driverTok(D1))).status).toBe(201);

    const conflict = await postPosition({ ...base, lat_e6: 99_000_000 }, await driverTok(D1));
    expect(conflict.status).toBe(400);
    const body = JSON.parse(await conflict.text()) as { code: string };
    expect(body.code).toBe("VALIDATION_FAILED"); // NOT INTERNAL -> the error.unhandled/500 path was NOT taken

    // integrity: the stored row still carries the ORIGINAL coordinates (the guard blocked the overwrite)
    const row = await env.TENANT_A_DB.prepare("SELECT lat_e6 FROM positions WHERE shipment_id=? AND device_id=? AND ts=?").bind(base.shipment_id, base.device_id, base.ts).first<{ lat_e6: number }>();
    expect(row!.lat_e6).toBe(base.lat_e6);
  });

  it("requires an Idempotency-Key", async () => {
    const res = await SELF.fetch("https://api.local/v1/positions", {
      method: "POST",
      headers: { Authorization: `Bearer ${await driverTok(D1)}`, "content-type": "application/json" },
      body: JSON.stringify({ shipment_id: "adv-pos-4", device_id: "d", ts: 1, lat_e6: 1, lon_e6: 2 }),
    });
    expect(res.status).toBe(400);
  });

  it("a read/portal role cannot post positions (role gate)", async () => {
    const res = await postPosition({ shipment_id: "adv-pos-5", device_id: "d", ts: 1, lat_e6: 1, lon_e6: 2 }, await portalTok(P1));
    expect(res.status).toBe(403);
  });
});

// Minor route-level coverage the probes confirmed but the shipped suite did not assert.
describe("route-level geo + position.updated event handling", () => {
  it("a driver lens keeps geo EXACT — coarsening is a party-only projection (doc 07 §02)", async () => {
    const res = await listShipment(SHP_A, await driverTok(D1));
    const custody = res.events.find((e) => e.kind === "custody.transferred");
    expect(custody).toBeDefined();
    const g = (custody!.payload as { geo: Record<string, unknown> }).geo;
    expect(g.lat_e6).toBe(GEO.lat_e6);
    expect(g.lon_e6).toBe(GEO.lon_e6);
    expect(g.accuracy_m).toBe(GEO.accuracy_m);
  });

  it("a position.updated EVENT on the events route is rejected 400 — positions own the partition, not the log", async () => {
    const shp = "adv-shp-posevent";
    const r = await append(shp, buildInput(shp, "position.updated", { payload: { lat_e6: 1, lon_e6: 2 } }), await opsTok());
    expect(r.status).toBe(400);
  });
});
