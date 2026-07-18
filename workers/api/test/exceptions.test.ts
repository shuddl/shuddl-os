import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureSchema, token, post, TENANT_SLUG } from "./helpers.js";
import { eventFixture, type JsonObject } from "@shuddl/contracts";
import { eventToRow } from "@shuddl/ledger/lens";
import { EXCEPTIONS_LIMIT } from "../src/routes/exceptions.js";

// WP-10 Task 3 (REQ-082) — the command "exceptions" queue. The TRAP the WP-10 sweep flagged: the only
// status_cache open-signal (state='exception', status-cache.ts:135-136) is SILENTLY CLOBBERED by a later
// pod.signed→'delivered' (:133-134), so a queue built on status_cache LOSES the item the instant the
// shipment delivers. The fix under test: read the DURABLE, append-only exception.raised + osd.captured
// EVENTS (never overwritten) and join the shipment's CURRENT state only to decide open vs resolved.

const HEX64 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const GEO = { lat_e6: 37_421_000, lon_e6: -122_084_000, accuracy_m: 5 };

const opsTok = (): Promise<string> => token({ sub: "exc-ops", tenant: TENANT_SLUG, role: "ops" });

// A booking.created that creates the shipments row (state 'booked') — the bill_to (party-bill-to) carries a
// deliverable contact, so the REQ-042/182 booking gates pass on the happy path (see helpers PARTIES).
function bookingInput(shipmentId: string): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    shipment_id: shipmentId,
    ts: 1_720_000_000_000,
    actor: { party: "party-shipper" },
    party_refs: [],
    evidence: [],
    source: "native",
    confidence: 10_000,
    kind: "booking.created",
    payload: {
      quote_event_id: `evt-quote-${shipmentId}`,
      division: "main",
      shipper_party_id: "party-shipper",
      consignee_party_id: "party-consignee",
      bill_to_party_id: "party-bill-to",
    },
  };
}

function eventInput(shipmentId: string, kind: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    shipment_id: shipmentId,
    ts: Date.now(),
    actor: { party: "party-carrier" },
    party_refs: [],
    evidence: [],
    source: "native",
    confidence: 10_000,
    kind,
    payload,
  };
}

type ExceptionItem = {
  shipment_id: string | null;
  exception_event_id: string;
  kind: string;
  reason_code: string | null;
  ts: number;
  open: boolean;
};

async function getExceptions(
  tok: string,
  status?: string,
  beforeTs?: number,
): Promise<{ status: number; items: ExceptionItem[]; nextBeforeTs: number | null }> {
  const params = new URLSearchParams();
  if (status !== undefined) params.set("status", status);
  if (beforeTs !== undefined) params.set("before_ts", String(beforeTs));
  const qs = params.toString() === "" ? "" : `?${params.toString()}`;
  const res = await SELF.fetch(`https://api.local/v1/exceptions${qs}`, { headers: { Authorization: `Bearer ${tok}` } });
  const body = (await res.json().catch(() => ({}))) as { exceptions?: ExceptionItem[]; next_before_ts?: number | null };
  return { status: res.status, items: body.exceptions ?? [], nextBeforeTs: body.next_before_ts ?? null };
}

// Direct-insert an exception.raised EVENT (bypasses the sequencer/gate — we are proving the READ path). A
// fieldless (no reason_code) exception is UNREACHABLE via the normal gate (assertException requires photo+
// reason_code), but IS reachable via a REQ-049 override append (override short-circuits the gate) or a
// legacy/migrated loose payload — so the read must parse reason_code DEFENSIVELY. Unique 64-hex hash keeps
// UNIQUE(hash) + the append-only insert guard happy.
let hashN = 0xe0000;
const nextHash = (): string => (hashN++).toString(16).padStart(64, "0");
async function seedRawException(shipmentId: string, payload: JsonObject): Promise<string> {
  const e = eventFixture("exception.raised", {
    id: crypto.randomUUID(),
    stream_id: `s:${shipmentId}`,
    shipment_id: shipmentId,
    seq: 0,
    visibility: "internal",
    party_refs: [],
    payload,
  });
  const row = eventToRow(e);
  row.hash = nextHash();
  const cols = Object.keys(row);
  await env.TENANT_A_DB.prepare(`INSERT INTO events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .bind(...cols.map((c) => row[c]))
    .run();
  return e.id;
}

async function shipmentState(shipmentId: string): Promise<string | null> {
  const row = await env.TENANT_A_DB.prepare("SELECT json_extract(status_cache,'$.state') AS state FROM shipments WHERE id = ?")
    .bind(shipmentId)
    .first<{ state: string | null }>();
  return row?.state ?? null;
}

beforeAll(async () => {
  await ensureSchema(env);
});

describe("GET /v1/exceptions — durable read over the ledger (REQ-082)", () => {
  it("an exception.raised on a live shipment is OPEN; after pod.signed→delivered it is RESOLVED, never LOST (the status_cache-clobber trap)", async () => {
    const SHP = "exc-trap-shp";
    const ops = await opsTok();

    const b = await post(SHP, bookingInput(SHP), ops);
    expect(b.status).toBe(201); // shipment row created, state 'booked'
    const exc = await post(SHP, eventInput(SHP, "exception.raised", { photo_hash: HEX64, reason_code: "damage" }), ops);
    expect(exc.status).toBe(201); // status_cache.state → 'exception' (non-terminal)
    const excId = exc.json?.id as string;

    // While the shipment is live, the exception is OPEN and cites its durable event id.
    const openBefore = await getExceptions(ops, "open");
    expect(openBefore.status).toBe(200);
    const mineBefore = openBefore.items.find((e) => e.shipment_id === SHP);
    expect(mineBefore).toBeDefined();
    expect(mineBefore?.open).toBe(true);
    expect(mineBefore?.kind).toBe("exception.raised");
    expect(mineBefore?.reason_code).toBe("damage");
    expect(mineBefore?.exception_event_id).toBe(excId); // the citation handle for click-through

    // pod.signed CLOBBERS status_cache.state 'exception' → 'delivered' (status-cache.ts:133-134). A queue
    // built on status_cache would now show NOTHING for this shipment — the item is silently lost.
    const pod = await post(SHP, eventInput(SHP, "pod.signed", { signature_hash: HEX64, geo: { ...GEO }, unwitnessed: true }), ops);
    expect(pod.status).toBe(201);
    expect(await shipmentState(SHP)).toBe("delivered"); // the clobber really happened

    // The durable exception.raised EVENT is UNTOUCHED (append-only) — it is still on the stream.
    const stillThere = await env.TENANT_A_DB.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE stream_id = ? AND kind = 'exception.raised'",
    )
      .bind(`s:${SHP}`)
      .first<{ n: number }>();
    expect(stillThere?.n).toBe(1);

    // ?status=open no longer lists it (its shipment reached a terminal state → RESOLVED)…
    const openAfter = await getExceptions(ops, "open");
    expect(openAfter.items.some((e) => e.shipment_id === SHP)).toBe(false);
    // …but it is NOT lost: ?status=all still surfaces it, flagged resolved. THIS is what reading the durable
    // event (not the clobbered status_cache) buys us.
    const allAfter = await getExceptions(ops, "all");
    const mineAfter = allAfter.items.find((e) => e.shipment_id === SHP && e.exception_event_id === excId);
    expect(mineAfter).toBeDefined();
    expect(mineAfter?.open).toBe(false);
  });

  it("osd.captured surfaces in the exceptions queue", async () => {
    const SHP = "exc-osd-shp";
    const ops = await opsTok();
    const b = await post(SHP, bookingInput(SHP), ops);
    expect(b.status).toBe(201);
    const osd = await post(SHP, eventInput(SHP, "osd.captured", { photo_hash: HEX64, reason_code: "shortage" }), ops);
    expect(osd.status).toBe(201);

    const open = await getExceptions(ops, "open");
    const mine = open.items.find((e) => e.shipment_id === SHP);
    expect(mine).toBeDefined();
    expect(mine?.kind).toBe("osd.captured");
    expect(mine?.reason_code).toBe("shortage");
    expect(mine?.open).toBe(true);
    expect(mine?.exception_event_id).toBe(osd.json?.id);
  });

  it("a fieldless exception.raised payload is parsed DEFENSIVELY — reason_code absent → null, no crash", async () => {
    const SHP = "exc-fieldless-shp";
    const ops = await opsTok();
    // A live (non-terminal) shipment row so the join reports OPEN; status_cache DEFAULT '{}' → no state.
    await env.TENANT_A_DB.prepare(
      "INSERT OR IGNORE INTO shipments (id, shipper_party_id, consignee_party_id, bill_to_party_id, status_cache, created_ts) VALUES (?,?,?,?,?,0)",
    )
      .bind(SHP, "party-shipper", "party-consignee", "party-bill-to", JSON.stringify({ state: "in_transit" }))
      .run();
    // An exception with NO reason_code (override-appended / legacy) — the loose JsonObject the read must not assume.
    const excId = await seedRawException(SHP, { note: "override-appended, no reason_code" });

    const open = await getExceptions(ops, "open");
    expect(open.status).toBe(200); // did not crash on the missing field
    const mine = open.items.find((e) => e.shipment_id === SHP && e.exception_event_id === excId);
    expect(mine).toBeDefined();
    expect(mine?.reason_code).toBeNull(); // absent field → null, never a throw or a fabricated value
    expect(mine?.open).toBe(true);
  });

  it("is a tenant-lens surface — a read role sees it (200), a driver does not (403)", async () => {
    const read = await token({ sub: "exc-read", tenant: TENANT_SLUG, role: "read" });
    const driver = await token({ sub: "exc-driver", tenant: TENANT_SLUG, role: "driver" });
    expect((await getExceptions(read, "open")).status).toBe(200);
    const driverRes = await SELF.fetch("https://api.local/v1/exceptions?status=open", { headers: { Authorization: `Bearer ${driver}` } });
    expect(driverRes.status).toBe(403);
  });

  it("an unknown status value is a 400, never a silent empty result", async () => {
    const ops = await opsTok();
    const res = await SELF.fetch("https://api.local/v1/exceptions?status=bogus", { headers: { Authorization: `Bearer ${ops}` } });
    expect(res.status).toBe(400);
  });

  it("a malformed before_ts cursor is a hard 400, never a silent full-page reset", async () => {
    const ops = await opsTok();
    for (const bad of ["abc", "-1", "1.5"]) {
      const res = await SELF.fetch(`https://api.local/v1/exceptions?before_ts=${bad}`, { headers: { Authorization: `Bearer ${ops}` } });
      expect(res.status, bad).toBe(400);
    }
  });
});

// REQ-197 — the FRESHEST-first guarantee under the 1000-cap. The old read did `ORDER BY stream_id LIMIT 1000`
// then sorted by ts in JS, so the cap TRUNCATED by lexicographic stream_id BEFORE the freshest-first sort — a
// fresh OPEN exception past the 1000th lifetime exception event silently vanished. This proves ts_desc keeps
// the freshest AND before_ts reaches the older page with no silent loss.
describe("GET /v1/exceptions — freshest-first past the cap, paged with no silent loss (REQ-197)", () => {
  const CAP = EXCEPTIONS_LIMIT;
  const EXTRA = 5;
  const BASE_TS = 1_800_000_000_000; // fresher than every other seeded exception in this file
  const PREFIX = "exc-cap-";
  const seededIds: string[] = [];

  beforeAll(async () => {
    // CAP + EXTRA exception.raised events, each on its OWN shipment stream, ts ASCENDING with the index.
    // stream_id is zero-padded so its lexicographic order EQUALS the ts order — so the OLD read (ORDER BY
    // stream_id LIMIT CAP) truncated away exactly the freshest EXTRA (the lexicographically-largest streams).
    // No shipments row exists for these → the state join reports them OPEN (fail-toward-surfacing).
    const total = CAP + EXTRA;
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < total; i++) {
      const shipmentId = `${PREFIX}${i.toString().padStart(5, "0")}`;
      const e = eventFixture("exception.raised", {
        id: crypto.randomUUID(),
        stream_id: `s:${shipmentId}`,
        shipment_id: shipmentId,
        seq: 0,
        ts: BASE_TS + i,
        visibility: "internal",
        party_refs: [],
        payload: { photo_hash: HEX64, reason_code: "damage" },
      });
      const row = eventToRow(e);
      row.hash = nextHash();
      const cols = Object.keys(row);
      stmts.push(
        env.TENANT_A_DB.prepare(`INSERT INTO events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).bind(...cols.map((c) => row[c])),
      );
      seededIds.push(e.id);
    }
    // Chunked batches keep each transaction within SQLite's bound-variable ceiling.
    for (let i = 0; i < stmts.length; i += 100) await env.TENANT_A_DB.batch(stmts.slice(i, i + 100));
  });

  it("the FRESHEST exception surfaces at the top (old lexicographic truncation would have DROPPED it); the older page is reachable via before_ts, nothing lost", async () => {
    const ops = await opsTok();

    // PAGE 1 — no cursor. ts_desc + the CAP returns the freshest CAP; my seeds are fresher than every other
    // exception in this file, so the whole page is mine and the NEWEST seed sits at the very top.
    const p1 = await getExceptions(ops, "open");
    expect(p1.status).toBe(200);
    const mine1 = p1.items.filter((i) => i.shipment_id?.startsWith(PREFIX));
    expect(mine1).toHaveLength(CAP); // exactly the cap, all freshest-first
    const freshestId = seededIds[seededIds.length - 1];
    expect(mine1[0]!.exception_event_id).toBe(freshestId); // the fresh OPEN exception is at the top, not lost
    expect(mine1[0]!.open).toBe(true);
    for (let i = 1; i < mine1.length; i++) expect(mine1[i - 1]!.ts).toBeGreaterThanOrEqual(mine1[i]!.ts); // ts-descending
    // a full page ⇒ an older-page cursor is returned (the oldest ts ON this page)
    expect(p1.nextBeforeTs).not.toBeNull();
    expect(p1.nextBeforeTs).toBe(mine1[mine1.length - 1]!.ts);

    // PAGE 2 — walk OLDER via before_ts. The EXTRA oldest seeds (indices 0..EXTRA-1) live here — the ones the
    // old lexicographic truncation would have made UNREACHABLE behind the cap. None are silently lost.
    const p2 = await getExceptions(ops, "open", p1.nextBeforeTs!);
    expect(p2.status).toBe(200);
    const mine2 = p2.items.filter((i) => i.shipment_id?.startsWith(PREFIX));
    expect(mine2.some((i) => i.exception_event_id === seededIds[0])).toBe(true); // the very oldest is reachable
    const p1Ids = new Set(mine1.map((i) => i.exception_event_id));
    expect(mine2.every((i) => !p1Ids.has(i.exception_event_id))).toBe(true); // pages do not overlap
  });
});
