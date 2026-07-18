import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { rowToEvent } from "@shuddl/ledger/lens";
import type { LedgerEvent } from "@shuddl/contracts";
import { handleQuoteAccepted } from "../../agents/src/booking.js";
import type { BookingDeps } from "../../agents/src/booking.js";
import type { SeqStubLike } from "../../agents/src/biller.js";
import { ensureSchema, seedRateConfig, TEST_RATE_CONFIG, token, TENANT_SLUG } from "./helpers.js";

// WP-10 Task 6 (REQ-150 / REQ-195 / REQ-030 / REQ-025) — THE SYNCHRONOUS CSR NET-NEW INTAKE SEAM.
//
// A CSR keying a brand-new phone/walk-in order (new customer, no prior shipment) could not book from scratch:
// POST /v1/rate appends quote.priced to a bare stream but creates NO shipments row and NO parties rows, so the
// Booking agent returned skipped:shipment_not_found. This task adds the two deterministic, synchronous ops
// write seams that let a CSR compose a booking from nothing:
//   POST /v1/parties    — find-or-create a party (admin/ops), deterministic + idempotent, no LLM.
//   POST /v1/shipments  — materialize a QUOTE-STAGE shipments row with the shipper/consignee/bill_to FKs.
// Then the EXISTING verbs compose: parties → shipment → /v1/rate → accept-quote → the gated Booking agent.
//
// LAWS UNDER TEST (the DoD):
//   · party find-or-create is idempotent (a re-POST of the same party returns the SAME id, no duplicate).
//   · a shipment is materialized quote-stage: NO booking.created on the stream, status_cache not `booked`.
//   · THE END-TO-END: intake → rate → accept-quote → the Booking agent books EXACTLY ONE booking.created.
//   · GATE-PARITY (REQ-030): the seam NEVER bypasses the credit/evidence gates — a net-new booking to a
//     bill_to on a credit hold is HELD (no booking.created), proving the intake path is not a gate bypass.
//   · roles admin/ops ONLY (portal/driver/read/finance → 403); tenant off the JWT only (REQ-025).
//
// isolatedStorage is OFF (shared D1): every id is prefixed `ix-` / unique to this file; no case assumes an
// empty table. Cross-tenant isolation for both routes lives in isolation.test.ts (the merge-gate suite).

const TENANT = TENANT_SLUG;
const PRICEABLE = { origin_zip: "97201", dest_zip: "80012", weight_lb: 1000, dims: { l_in: 48, w_in: 40, h_in: 48, pieces: 2 } };

const opsTok = (): Promise<string> => token({ sub: "ix-ops", tenant: TENANT, role: "ops" });
const adminTok = (): Promise<string> => token({ sub: "ix-admin", tenant: TENANT, role: "admin" });

// ── drive the Booking agent directly against the REAL DO + D1 (mirrors booking.test.ts) ────────────────
const seqStub: SeqStubLike = {
  append: (req) =>
    (env.SHIPMENT_SEQ.get(env.SHIPMENT_SEQ.idFromName(`${req.tenant}|${req.streamId}`)) as unknown as SeqStubLike).append(req),
};
const bookingDeps: BookingDeps = { db: env.TENANT_A_DB, seq: seqStub };

interface Res {
  status: number;
  json: Record<string, unknown> | null;
}
async function createParty(body: unknown, tok: string, key = crypto.randomUUID()): Promise<Res> {
  const res = await SELF.fetch("https://api.local/v1/parties", {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Idempotency-Key": key, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}
async function createShipment(body: unknown, tok: string, key = crypto.randomUUID()): Promise<Res> {
  const res = await SELF.fetch("https://api.local/v1/shipments", {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Idempotency-Key": key, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}
async function rate(shipmentId: string, tok: string): Promise<Res> {
  const res = await SELF.fetch("https://api.local/v1/rate", {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
    body: JSON.stringify({ shipment_id: shipmentId, ...PRICEABLE }),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}
async function acceptQuote(shipmentId: string, quoteEventId: string, tok: string): Promise<Res> {
  const res = await SELF.fetch(`https://api.local/v1/shipments/${shipmentId}/accept-quote`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
    body: JSON.stringify({ quote_event_id: quoteEventId }),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

// ── DB probes ──────────────────────────────────────────────────────────────────────────────────────
async function streamEvents(shipmentId: string): Promise<LedgerEvent[]> {
  const r = await env.TENANT_A_DB.prepare("SELECT * FROM events WHERE stream_id = ? ORDER BY seq").bind(`s:${shipmentId}`).all();
  return (r.results as Record<string, string | number | null>[]).map((row) => rowToEvent(row));
}
async function bookingEvents(shipmentId: string): Promise<LedgerEvent[]> {
  return (await streamEvents(shipmentId)).filter((e) => e.kind === "booking.created");
}
async function quotePricedIdOf(shipmentId: string): Promise<string> {
  const q = (await streamEvents(shipmentId)).find((e) => e.kind === "quote.priced");
  if (!q) throw new Error(`no quote.priced on ${shipmentId}`);
  return q.id;
}
async function partyRow(id: string): Promise<{ id: string; kind: string; names: string; contacts: string } | null> {
  return env.TENANT_A_DB.prepare("SELECT id, kind, names, contacts FROM parties WHERE id = ?").bind(id).first();
}
async function shipmentRow(id: string): Promise<{ id: string; shipper_party_id: string; consignee_party_id: string; bill_to_party_id: string; status_cache: string } | null> {
  return env.TENANT_A_DB
    .prepare("SELECT id, shipper_party_id, consignee_party_id, bill_to_party_id, status_cache FROM shipments WHERE id = ?")
    .bind(id)
    .first();
}
async function shipmentState(id: string): Promise<string | undefined> {
  const row = await env.TENANT_A_DB.prepare("SELECT json_extract(status_cache, '$.state') AS state FROM shipments WHERE id = ?").bind(id).first<{ state: string | null }>();
  return row?.state ?? undefined;
}

// Create the three parties a shipment needs and return their ids. bill_to carries a deliverable email so the
// REQ-182 evidence-recipient gate passes on the happy path; shipper/consignee need no contact.
async function threeParties(suffix: string, tok: string): Promise<{ shipper: string; consignee: string; billTo: string }> {
  const s = (await createParty({ kind: "shipper", name: `IX Shipper ${suffix}`, email: `shipper+${suffix}@ix-intake.test` }, tok)).json;
  const c = (await createParty({ kind: "consignee", name: `IX Consignee ${suffix}`, email: `consignee+${suffix}@ix-intake.test` }, tok)).json;
  const b = (await createParty({ kind: "broker", name: `IX BillTo ${suffix}`, email: `billto+${suffix}@ix-intake.test` }, tok)).json;
  return { shipper: s?.id as string, consignee: c?.id as string, billTo: b?.id as string };
}

beforeAll(async () => {
  await ensureSchema(env);
  await seedRateConfig(env.TENANT_A_DB, TEST_RATE_CONFIG);
  // A bill_to on a credit HOLD with a deliverable email (so ONLY credit blocks → reason credit_clear). Seeded
  // directly because POST /v1/parties intentionally does not accept a credit_status (credit is a finance fact).
  await env.TENANT_A_DB.prepare("INSERT OR IGNORE INTO parties (id, kind, names, contacts, credit_status) VALUES (?,?,?,?,?)")
    .bind("ix-billto-held", "broker", "{}", JSON.stringify([{ kind: "billing", email: "held@ix-intake.test" }]), "hold")
    .run();
});

// ---- POST /v1/parties — find-or-create ------------------------------------------------------------
describe("POST /v1/parties — deterministic find-or-create (REQ-195/025)", () => {
  it("creates a new party and returns its id + a deliverable contact (ops)", async () => {
    const r = await createParty({ kind: "shipper", name: "Acme Distributing", email: "ops@ix-acme.test" }, await opsTok());
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const id = r.json?.id as string;
    expect(id).toMatch(/^party_/);
    expect(r.json?.created).toBe(true);
    const row = await partyRow(id);
    expect(row?.kind).toBe("shipper");
    expect(JSON.parse(row!.contacts)).toEqual([{ kind: "primary", email: "ops@ix-acme.test" }]);
    expect(JSON.parse(row!.names)).toEqual({ legal: "Acme Distributing" });
  });

  it("find-or-create is idempotent: a re-POST of the same email returns the SAME id, no duplicate (even case-variant, distinct key)", async () => {
    const email = "dedupe@ix-intake.test";
    const first = await createParty({ kind: "shipper", name: "Dedupe Co", email }, await opsTok());
    expect(first.status).toBe(201);
    const id = first.json?.id as string;
    // A DIFFERENT Idempotency-Key bypasses the HTTP replay cache → the DOMAIN find-or-create must dedupe. A
    // case-variant email proves the match is normalized.
    const second = await createParty({ kind: "consignee", name: "Dedupe Co Again", email: "DEDUPE@IX-Intake.TEST" }, await opsTok());
    expect(second.status).toBe(200);
    expect(second.json?.created).toBe(false);
    expect(second.json?.id).toBe(id); // same party — not a duplicate
    const dupes = await env.TENANT_A_DB
      .prepare("SELECT COUNT(*) AS n FROM parties p, json_each(p.contacts) je WHERE lower(json_extract(je.value, '$.email')) = ?")
      .bind(email)
      .first<{ n: number }>();
    expect(dupes?.n).toBe(1);
  });

  it("admin may also create a party", async () => {
    const r = await createParty({ kind: "consignee", name: "Admin Made Co", email: "admin@ix-intake.test" }, await adminTok());
    expect(r.status).toBe(201);
  });

  it("a non-strict / malformed body is a clean 400", async () => {
    expect((await createParty({ kind: "shipper", name: "X", email: "x@y.test", sneaky: 1 }, await opsTok())).status).toBe(400);
    expect((await createParty({ kind: "not-a-kind", name: "X" }, await opsTok())).status).toBe(400);
    expect((await createParty({ name: "no kind" }, await opsTok())).status).toBe(400);
  });

  it("role gating: portal / driver / read / finance are 403 on /v1/parties", async () => {
    for (const role of ["portal", "driver", "read", "finance"] as const) {
      const tok = await token({ sub: `ix-${role}`, tenant: TENANT, role, ...(role === "portal" ? { party_id: "ix-p" } : {}) });
      expect((await createParty({ kind: "shipper", name: "Nope", email: "nope@ix-intake.test" }, tok)).status, role).toBe(403);
    }
  });
});

// ---- POST /v1/shipments — quote-stage materialization ---------------------------------------------
describe("POST /v1/shipments — quote-stage row with party FKs (REQ-195/025)", () => {
  it("materializes a quote-stage shipments row: no booking.created, status_cache not booked", async () => {
    const p = await threeParties("mat", await opsTok());
    const r = await createShipment({ shipper_party_id: p.shipper, consignee_party_id: p.consignee, bill_to_party_id: p.billTo }, await opsTok());
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const shipmentId = r.json?.shipment_id as string;
    expect(shipmentId).toMatch(/^shp_/);
    const row = await shipmentRow(shipmentId);
    expect(row?.shipper_party_id).toBe(p.shipper);
    expect(row?.consignee_party_id).toBe(p.consignee);
    expect(row?.bill_to_party_id).toBe(p.billTo);
    // QUOTE-STAGE: no booking.created on the stream, status_cache carries no `booked` state (WP-09 gate stays green).
    expect(await bookingEvents(shipmentId)).toHaveLength(0);
    expect(await shipmentState(shipmentId)).toBeUndefined();
  });

  it("a shipment referencing a party that does not exist is a clean 400 (no orphan shipment)", async () => {
    const p = await threeParties("orphan", await opsTok());
    const r = await createShipment({ shipper_party_id: p.shipper, consignee_party_id: p.consignee, bill_to_party_id: "ix-nonexistent-party" }, await opsTok());
    expect(r.status).toBe(400);
  });

  it("a non-strict / malformed body is a clean 400", async () => {
    const p = await threeParties("strict", await opsTok());
    expect((await createShipment({ shipper_party_id: p.shipper, consignee_party_id: p.consignee, bill_to_party_id: p.billTo, sneaky: 1 }, await opsTok())).status).toBe(400);
    expect((await createShipment({ shipper_party_id: p.shipper, consignee_party_id: p.consignee }, await opsTok())).status).toBe(400);
  });

  it("role gating: portal / driver / read / finance are 403 on /v1/shipments", async () => {
    const p = await threeParties("role", await opsTok());
    for (const role of ["portal", "driver", "read", "finance"] as const) {
      const tok = await token({ sub: `ix-s-${role}`, tenant: TENANT, role, ...(role === "portal" ? { party_id: "ix-p" } : {}) });
      const r = await createShipment({ shipper_party_id: p.shipper, consignee_party_id: p.consignee, bill_to_party_id: p.billTo }, tok);
      expect(r.status, role).toBe(403);
    }
  });
});

// ---- THE END-TO-END: book a brand-new order from scratch through the EXISTING verbs ----------------
describe("CSR net-new intake composes: parties → shipment → rate → accept → the gated Booking agent (REQ-150/030)", () => {
  it("GOLDEN: a brand-new order books EXACTLY ONE booking.created through the credit/evidence gates", async () => {
    const ops = await opsTok();
    const p = await threeParties("e2e", ops); // bill_to has a deliverable email, no credit hold
    const shp = (await createShipment({ shipper_party_id: p.shipper, consignee_party_id: p.consignee, bill_to_party_id: p.billTo }, ops)).json?.shipment_id as string;

    // rate the NEW shipment → quote.priced on its stream (ops admitted)
    const priced = await rate(shp, ops);
    expect(priced.status, JSON.stringify(priced.json)).toBe(200);
    expect(priced.json?.status).toBe("PRICED");

    // accept the priced quote → quote.accepted (the Booking trigger fires off it)
    const quoteId = await quotePricedIdOf(shp);
    const acc = await acceptQuote(shp, quoteId, ops);
    expect(acc.status, JSON.stringify(acc.json)).toBe(201);
    const acceptEventId = acc.json?.id as string;

    // drive the Booking agent (the queue consumer is out-of-isolate; the function is the venue) → booked
    const outcome = await handleQuoteAccepted({ kind: "quote.accepted", tenant: TENANT, shipment_id: shp, event_id: acceptEventId }, bookingDeps);
    expect(outcome.status, JSON.stringify(outcome)).toBe("booked");

    // EXACTLY ONE booking.created, and the shipment projected to `booked` (the T4 projection ran in the gated batch).
    expect(await bookingEvents(shp)).toHaveLength(1);
    expect(await shipmentState(shp)).toBe("booked");
  });

  it("GATE-PARITY (REQ-030): a net-new booking to a bill_to on a CREDIT HOLD is HELD — the intake seam is not a gate bypass", async () => {
    const ops = await opsTok();
    const p = await threeParties("hold", ops);
    // Same shipper/consignee, but a HELD bill_to (seeded in beforeAll). The intake seam creates the shipment
    // exactly the same way; the booking STILL runs #enforceBooking through the DO.
    const shp = (await createShipment({ shipper_party_id: p.shipper, consignee_party_id: p.consignee, bill_to_party_id: "ix-billto-held" }, ops)).json?.shipment_id as string;

    const priced = await rate(shp, ops);
    expect(priced.json?.status).toBe("PRICED");
    const quoteId = await quotePricedIdOf(shp);
    const acc = await acceptQuote(shp, quoteId, ops);
    expect(acc.status).toBe(201);

    const outcome = await handleQuoteAccepted({ kind: "quote.accepted", tenant: TENANT, shipment_id: shp, event_id: acc.json?.id as string }, bookingDeps);
    expect(outcome.status, JSON.stringify(outcome)).toBe("held");
    if (outcome.status !== "held") throw new Error("unreachable");
    expect(outcome.reason).toBe("credit_clear");

    // The gate aborted the append: NO booking.created, the shipment never went `booked`. No bypass.
    expect(await bookingEvents(shp)).toHaveLength(0);
    expect(await shipmentState(shp)).toBeUndefined();
  });
});
