import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureSchema, token, post, streamCount, TENANT_SLUG } from "./helpers.js";

// WP-10 Task 7 (REQ-038/024) — POST /v1/copilot/ask. A READ-ONLY, cite-or-abstain answerer over the ledger.
// In CI no ANTHROPIC_API_KEY is bound, so the route runs the DeterministicCopilot floor (the LLM is never
// called). These tests prove: a seeded question returns an answer citing REAL event ids; an unanswerable
// question ABSTAINS with no fabrication; the citations are lens/tenant-scoped; the route never writes; role gating.

const HEX64 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const GEO = { lat_e6: 37_421_000, lon_e6: -122_084_000, accuracy_m: 5 };

const opsTok = (): Promise<string> => token({ sub: "copilot-ops", tenant: TENANT_SLUG, role: "ops" });

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

function eventInput(shipmentId: string, kind: string, payload: Record<string, unknown>, ts = Date.now()): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    shipment_id: shipmentId,
    ts,
    actor: { party: "party-carrier" },
    party_refs: [],
    evidence: [],
    source: "native",
    confidence: 10_000,
    kind,
    payload,
  };
}

type AnswerResult = { text: string; citations: Array<{ event_id: string; kind: string; shipment_id?: string }>; abstained: boolean };

async function ask(tok: string, question: string): Promise<{ status: number; body: AnswerResult }> {
  const res = await SELF.fetch("https://api.local/v1/copilot/ask", {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
    body: JSON.stringify({ question }),
  });
  const body = (await res.json().catch(() => ({}))) as AnswerResult;
  return { status: res.status, body };
}

beforeAll(async () => {
  await ensureSchema(env);
});

describe("POST /v1/copilot/ask — read-only, cite-or-abstain (REQ-038)", () => {
  it("a shipment-status question → an answer citing the REAL freshest event id (lens-scoped)", async () => {
    const SHP = "copilot-status-shp";
    const ops = await opsTok();
    const b = await post(SHP, bookingInput(SHP), ops);
    expect(b.status).toBe(201);
    const pod = await post(SHP, eventInput(SHP, "pod.signed", { signature_hash: HEX64, geo: { ...GEO }, unwitnessed: true }), ops);
    expect(pod.status).toBe(201);
    const podId = pod.json?.id as string;

    const { status, body } = await ask(ops, `what's the status of shipment ${SHP}?`);
    expect(status).toBe(200);
    expect(body.abstained).toBe(false);
    expect(body.citations.length).toBeGreaterThanOrEqual(1);
    // Every citation is a REAL event id on this shipment's stream — never fabricated.
    const ids = body.citations.map((c) => c.event_id);
    expect(ids).toContain(podId);
    expect(body.citations.every((c) => c.shipment_id === SHP)).toBe(true);
    expect(body.text).toContain(SHP);
  });

  it("does NOT write — the shipment stream is unchanged after asking (no append, no new event)", async () => {
    const SHP = "copilot-nowrite-shp";
    const ops = await opsTok();
    await post(SHP, bookingInput(SHP), ops);
    await post(SHP, eventInput(SHP, "exception.raised", { photo_hash: HEX64, reason_code: "damage" }), ops);
    const before = await streamCount(SHP);
    await ask(ops, `what's the status of shipment ${SHP}?`);
    await ask(ops, "which shipments have open exceptions?");
    const after = await streamCount(SHP);
    expect(after).toBe(before); // the copilot is READ-ONLY — asking never mutates the ledger
  });

  it("an unanswerable question → ABSTAIN (abstained:true, zero citations, no fabrication)", async () => {
    const ops = await opsTok();
    const { status, body } = await ask(ops, "should I buy more trucks next quarter?");
    expect(status).toBe(200);
    expect(body.abstained).toBe(true);
    expect(body.citations).toEqual([]);
    expect(body.text.toLowerCase()).toContain("can't answer");
  });

  it("a shipment with no visible events → ABSTAIN (never a fabricated status)", async () => {
    const ops = await opsTok();
    const { body } = await ask(ops, "status of shipment copilot-no-such-shipment");
    expect(body.abstained).toBe(true);
    expect(body.citations).toEqual([]);
  });

  it("'which shipments have open exceptions?' cites the real exception events", async () => {
    const SHP = "copilot-exc-shp";
    const ops = await opsTok();
    await post(SHP, bookingInput(SHP), ops);
    const exc = await post(SHP, eventInput(SHP, "exception.raised", { photo_hash: HEX64, reason_code: "damage" }), ops);
    expect(exc.status).toBe(201);
    const { body } = await ask(ops, "which shipments have open exceptions?");
    expect(body.abstained).toBe(false);
    expect(body.citations.some((c) => c.event_id === (exc.json?.id as string))).toBe(true);
    expect(body.text).toContain(SHP);
  });

  it("role gating: a read role may ask (200); a driver / portal may not (403)", async () => {
    const read = await token({ sub: "copilot-read", tenant: TENANT_SLUG, role: "read" });
    const driver = await token({ sub: "copilot-driver", tenant: TENANT_SLUG, role: "driver" });
    expect((await ask(read, "which shipments have open exceptions?")).status).toBe(200);
    const dRes = await SELF.fetch("https://api.local/v1/copilot/ask", {
      method: "POST",
      headers: { Authorization: `Bearer ${driver}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
      body: JSON.stringify({ question: "which shipments have open exceptions?" }),
    });
    expect(dRes.status).toBe(403);
  });

  it("a blank/malformed body is a clean 400, never a 500", async () => {
    const ops = await opsTok();
    const res = await SELF.fetch("https://api.local/v1/copilot/ask", {
      method: "POST",
      headers: { Authorization: `Bearer ${ops}`, "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" },
      body: JSON.stringify({ question: "" }),
    });
    expect(res.status).toBe(400);
  });
});
