import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { callApi, type Env } from "../src/index.js";
import { buildRegistry, defaultDispatchDeps, dispatch, type ToolCtx } from "../src/tools/registry.js";
import { applyControl, seedPairing, seedTenant } from "./helpers.js";
import { MAX_WEIGHT_LB } from "@shuddl/contracts";

// WP-13 Tasks 4-5 (REQ-101/107/195) — quote_freight + book_shipment, THE DoD booking path.
//
// HARNESS PATH — the recording fake `env.API` FALLBACK (the task's blessed fallback), threaded through the
// REAL OAuth→mint→dispatch→chokepoint→mutatingCallApi pipeline. WHY: exercising the tools against the REAL
// cross-worker api DO in this pool is intractable — the api's tenant D1 + ShipmentSequencer DO live in an
// AUXILIARY worker whose storage is isolated and UNSEEDABLE from this (main) worker's `env` (cloudflare:test
// exposes only the main worker's bindings). This is the repo's established precedent: the translator + agents
// pools STUB the api DO (501) and assert the identical "stops at quote.accepted, never booking.created"
// no-bypass invariant through an INJECTED recording port (workers/translator/test/inbound.test.ts). We do the
// same at the callApi seam: a recording Fetcher captures the EXACT REST call set (method+path+body), so the
// verbs, the pairing-ownership stamp, "no price on air", and the no-bypass are all proven structurally. The
// api's own gates (lens/credit/evidence, "no price on air") are proven UNCHANGED by the api's suites
// (portal-actions/rate/intake/booking .test.ts); the full DO-backed end-to-end is a Task-12 staging smoke.

const PAIRING_A = "prn-mcp-qb-a";
const TENANT_A = "t-qb-a";
const PAIRING_B = "prn-mcp-qb-b";
const TENANT_B = "t-qb-b";
const TOKEN_A = "mcpt_qb_a_access_token";
const TOKEN_B = "mcpt_qb_b_access_token";
const ISSUER = "https://mcp.shuddl.test";

// ── recording fake api (the fallback seam) ─────────────────────────────────────────────────────────────────
interface Recorded {
  method: string;
  path: string;
  search: string;
  body: Record<string, unknown> | undefined;
  idemKey: string | null;
  hasAuth: boolean;
}
type Reply = { status: number; json: unknown };
function recordingApi(route: (r: Recorded) => Reply): { api: Fetcher; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const api = {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      let body: Record<string, unknown> | undefined;
      if (request.method !== "GET" && request.method !== "HEAD") {
        body = (await request.json().catch(() => undefined)) as Record<string, unknown> | undefined;
      }
      const rec: Recorded = {
        method: request.method,
        path: url.pathname,
        search: url.search,
        body,
        idemKey: request.headers.get("idempotency-key"),
        hasAuth: request.headers.get("authorization") !== null,
      };
      calls.push(rec);
      const { status, json } = route(rec);
      return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
    },
  } as unknown as Fetcher;
  return { api, calls };
}

// JSON-RPC helpers (mirrors dispatch.test.ts).
interface RpcBody {
  jsonrpc: string;
  id: unknown;
  result?: { content?: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
  error?: { code: number; message: string; data?: unknown };
}
let rpcId = 0;
function mcpRequest(token: string | null, message: unknown): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers["authorization"] = `Bearer ${token}`;
  return new Request(`${ISSUER}/mcp`, { method: "POST", headers, body: JSON.stringify(message) });
}

// Drive one tool call through the REAL dispatcher with a spliced fake `env.API`. resolveGrant/mint/chokepoint
// are the LIVE composition-root deps (defaultDispatchDeps); only env.API is the recorder.
async function runTool(
  token: string,
  toolName: string,
  args: Record<string, unknown>,
  route: (r: Recorded) => Reply,
): Promise<{ body: RpcBody; calls: Recorded[] }> {
  const { api, calls } = recordingApi(route);
  const apiEnv = { ...env, API: api } as Env;
  const message = { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name: toolName, arguments: args } };
  const res = await dispatch(apiEnv, defaultDispatchDeps(apiEnv), mcpRequest(token, message));
  return { body: (await res.json()) as RpcBody, calls };
}
function structured(body: RpcBody): Record<string, unknown> {
  return body.result?.structuredContent ?? {};
}

// A priceable happy-path api: distinct party ids, a fixed shipment id, a PRICED rate, and one quote.priced.
function happyApi(): (r: Recorded) => Reply {
  let partyN = 0;
  return (r) => {
    if (r.method === "POST" && r.path === "/v1/parties") return { status: 201, json: { id: `party_${++partyN}`, created: true } };
    if (r.method === "POST" && r.path === "/v1/shipments") return { status: 201, json: { shipment_id: "shp_qb01" } };
    if (r.method === "POST" && r.path === "/v1/rate") {
      return { status: 200, json: { status: "PRICED", sell_cents: 187_400, floors: {}, approval: { approval: "none" }, transit: { status: "known", business_days: 3 }, anomaly: null } };
    }
    if (r.method === "GET" && r.path === "/v1/shipments/shp_qb01/events") {
      return { status: 200, json: { events: [{ id: "evt-priced-1", kind: "quote.priced", seq: 1 }], next_cursor: null } };
    }
    return { status: 500, json: { error: `unexpected ${r.method} ${r.path}` } };
  };
}

const PRICEABLE = {
  shipper: { name: "Acme Widgets" },
  consignee: { name: "Beta Receiving" },
  origin_zip: "97201",
  dest_zip: "80012",
  weight_lb: 1200,
  dims: { l_in: 48, w_in: 40, h_in: 60, pieces: 2 },
};

beforeAll(async () => {
  await applyControl(env.CONTROL_DB);
  await seedTenant(env.CONTROL_DB, TENANT_A, "tenant-qb-a");
  await seedTenant(env.CONTROL_DB, TENANT_B, "tenant-qb-b");
  // Task 8 (REQ-105): book_shipment now runs the caps chokepoint. Seed GENEROUS spend/velocity caps (and no lane
  // restriction) so these DoD-booking-path tests exercise the tool, not the cap edges — the caps EDGES (refuse/
  // fail-closed/attribution) are proven in caps.test.ts. `spend` is integer cents; `velocity` is a count.
  const OPEN_CAPS = JSON.stringify({ spend: 1_000_000_000, velocity: 100_000 });
  await seedPairing(env.CONTROL_DB, { id: PAIRING_A, tenantId: TENANT_A, kind: "mcp", status: "active", scopes: '["mcp"]', caps: OPEN_CAPS });
  await seedPairing(env.CONTROL_DB, { id: PAIRING_B, tenantId: TENANT_B, kind: "mcp", status: "active", scopes: '["mcp"]', caps: OPEN_CAPS });
  // Seed a real KV access-token→pairing grant (the OAuth ceremony's product; resolveTokenGrant reads it).
  const exp = Math.floor(Date.now() / 1000) + 3600;
  await env.GRANTS.put(`token:${TOKEN_A}`, JSON.stringify({ pairingId: PAIRING_A, scope: "mcp", exp }));
  await env.GRANTS.put(`token:${TOKEN_B}`, JSON.stringify({ pairingId: PAIRING_B, scope: "mcp", exp }));
});

// §1514 (REQ-101/051/004) — THE THIRD PRICING SURFACE, and why the bound belongs to the payload not the route.
//
// §1513 bounded `weight_lb` on `/v1/rate` and `/pub/quote` after measuring an HTTP 500 on the unauthenticated
// surface — and missed THIS one, because it enumerated ROUTES rather than SURFACES THAT PRICE. The miss has a
// consequence the other two do not: `quote_freight` creates a party and a SHIPMENT (`POST /v1/shipments`)
// BEFORE it rates, so an over-cap weight the api now refuses would leave ledger residue behind a request that
// can never succeed. Bounding it in the tool's own schema refuses it before the first write.
//
// The constant now lives in `@shuddl/contracts` and all three import it, so a fourth pricing surface inherits
// the ceiling rather than re-deciding it — this file's own `dims` note records what three-way drift on one
// payload already cost once.
describe("§1514 — quote_freight bounds the weight BEFORE its first write (REQ-101/004)", () => {
  it("an over-cap weight is refused by the tool's schema — no party, no shipment, no rate call", async () => {
    const overCap = { ...PRICEABLE, weight_lb: MAX_WEIGHT_LB + 1 };
    const { body, calls } = await runTool(TOKEN_A, "quote_freight", overCap, happyApi());
    expect(JSON.stringify(body)).toMatch(/invalid|validation|weight/i);
    expect(calls, "an unsatisfiable request must not create a party or a shipment first").toHaveLength(0);
  });

  // §1528 — THE MECHANISM, CHECKED. §1514's whole argument for bounding the weight HERE (rather than leaving
  // it to the api's 400) is that this tool WRITES BEFORE IT RATES: an over-cap weight the api refuses would
  // leave a party and a shipment behind an impossible request. That was read off the source, never asserted —
  // and §1527 measured a different read-off-the-source mechanism of mine and found it FALSE. So it is pinned
  // behaviourally now: the recorded call ORDER is the claim.
  it("writes BEFORE it rates — the order that makes a client-side bound worth having", async () => {
    const { calls } = await runTool(TOKEN_A, "quote_freight", PRICEABLE, happyApi());
    const paths = calls.map((c) => c.path);
    const firstShipment = paths.indexOf("/v1/shipments");
    const firstRate = paths.indexOf("/v1/rate");
    expect(firstShipment, "the tool no longer creates a shipment — re-derive §1514's residue argument").toBeGreaterThanOrEqual(0);
    expect(firstRate, "the tool no longer rates — this test is measuring something else").toBeGreaterThanOrEqual(0);
    expect(
      firstShipment < firstRate,
      "the tool now RATES BEFORE IT WRITES, so an api-refused weight would leave no residue and §1514's " +
        "reason for bounding the weight in this schema no longer holds. Re-read that section before removing " +
        "the bound — the OTHER reason (three surfaces, one payload, no drift) still stands on its own.",
    ).toBe(true);
    // …and a party is created before the shipment, so the residue is two rows rather than one.
    expect(paths.filter((p) => p === "/v1/parties").length, "no party was created before the shipment").toBeGreaterThan(0);
    expect(paths.indexOf("/v1/parties")).toBeLessThan(firstShipment);
  });

  it("the heaviest LEGAL shipment still prices through the tool (the ceiling refuses nothing real)", async () => {
    const { calls } = await runTool(TOKEN_A, "quote_freight", { ...PRICEABLE, weight_lb: 80_000 }, happyApi());
    expect(calls.some((c) => c.path === "/v1/rate"), "80,000 lb is a legal truckload and must still reach the rater").toBe(true);
  });
});

describe("quote_freight (Task 4) — parties → shipment → rate, over the api verbs", () => {
  it("a priceable load → PRICED with a sell, a shipment id, and a quote.priced event id", async () => {
    const { body, calls } = await runTool(TOKEN_A, "quote_freight", PRICEABLE, happyApi());
    const out = structured(body);
    expect(out.status).toBe("PRICED");
    expect(out.sell_cents).toBe(187_400);
    expect(out.shipment_id).toBe("shp_qb01");
    expect(out.quote_event_id).toBe("evt-priced-1"); // the priced-event hop (rate response carries no id)

    // The EXACT verb sequence (bill_to omitted ⇒ 2 parties, shipper reused as bill-to).
    const seq = calls.map((c) => `${c.method} ${c.path}`);
    expect(seq).toEqual([
      "POST /v1/parties",
      "POST /v1/parties",
      "POST /v1/shipments",
      "POST /v1/rate",
      "GET /v1/shipments/shp_qb01/events",
    ]);
    expect(calls[4]?.search).toContain("kind=quote.priced");
    // Every write carried the minted principal + an Idempotency-Key.
    for (const c of calls.filter((x) => x.method === "POST")) {
      expect(c.hasAuth).toBe(true);
      expect(c.idemKey).not.toBeNull();
    }
  });

  it("stamps the shipment with refs.pairing == pairingId (ownership provenance, REQ-107)", async () => {
    const { calls } = await runTool(TOKEN_A, "quote_freight", PRICEABLE, happyApi());
    const shipmentPost = calls.find((c) => c.path === "/v1/shipments");
    expect((shipmentPost?.body?.refs as Record<string, unknown> | undefined)?.pairing).toBe(PAIRING_A);
    // bill_to omitted ⇒ billed to the shipper (same party id).
    expect(shipmentPost?.body?.bill_to_party_id).toBe(shipmentPost?.body?.shipper_party_id);
  });

  it("the three party writes carry DISTINCT idempotency keys (no api-middleware replay-collision)", async () => {
    const withBillTo = { ...PRICEABLE, bill_to: { name: "Gamma Brokerage", kind: "broker" as const } };
    const { calls } = await runTool(TOKEN_A, "quote_freight", withBillTo, happyApi());
    const partyKeys = calls.filter((c) => c.path === "/v1/parties").map((c) => c.idemKey);
    expect(partyKeys).toHaveLength(3);
    expect(new Set(partyKeys).size).toBe(3); // distinct — else consignee/bill_to would replay the shipper's id
  });

  it("a stranger pairing stamps ITS OWN pairing id (each call bound to its principal)", async () => {
    const { calls } = await runTool(TOKEN_B, "quote_freight", PRICEABLE, happyApi());
    const shipmentPost = calls.find((c) => c.path === "/v1/shipments");
    expect((shipmentPost?.body?.refs as Record<string, unknown> | undefined)?.pairing).toBe(PAIRING_B);
  });

  it("missing weight/dims → UNKNOWN, NO fabricated price, and NO events hop (no price on air)", async () => {
    const unknownApi: (r: Recorded) => Reply = (r) => {
      if (r.method === "POST" && r.path === "/v1/parties") return { status: 201, json: { id: "party_x", created: true } };
      if (r.method === "POST" && r.path === "/v1/shipments") return { status: 201, json: { shipment_id: "shp_qb02" } };
      if (r.method === "POST" && r.path === "/v1/rate") return { status: 200, json: { status: "UNKNOWN", reason: "missing_physics" } };
      return { status: 500, json: { error: "unexpected" } };
    };
    const noPhysics = { shipper: { name: "Acme" }, consignee: { name: "Beta" }, origin_zip: "97201", dest_zip: "80012" };
    const { body, calls } = await runTool(TOKEN_A, "quote_freight", noPhysics, unknownApi);
    const out = structured(body);
    expect(out.status).toBe("UNKNOWN");
    expect(out.reason).toBe("missing_physics");
    expect(out.sell_cents).toBeUndefined(); // never fabricated
    expect(out.quote_event_id).toBeUndefined();
    expect(calls.some((c) => c.method === "GET")).toBe(false); // no priced fact → no events hop
  });
});

describe("book_shipment (Task 5) — accept-quote ONLY (the no-bypass invariant)", () => {
  // The caps chokepoint (Task 8, REQ-105) reads the accepted quote's sell BEFORE the handler runs, so a
  // book_shipment now hops GET …/events?kind=quote.priced first (a READ). The fake serves that priced event
  // (a sell WELL under the OPEN_CAPS spend) then the accept-quote write.
  const PRICED_EVENT = { id: "evt-priced-1", kind: "quote.priced", seq: 1, payload: { sell: 187_400, basis: { zone: "Z2", matched_zip_prefix: "800" } } };
  const acceptApi: (r: Recorded) => Reply = (r) => {
    if (r.method === "GET" && r.path === "/v1/shipments/shp_qb01/events") {
      return { status: 200, json: { events: [PRICED_EVENT], next_cursor: null } };
    }
    if (r.method === "POST" && r.path === "/v1/shipments/shp_qb01/accept-quote") {
      return { status: 201, json: { id: "evt-accepted-1", kind: "quote.accepted", seq: 2, stream_id: "s:shp_qb01" } };
    }
    return { status: 500, json: { error: `unexpected ${r.method} ${r.path}` } };
  };

  it("accepts the priced quote → quote.accepted; surfaces the provenance ids", async () => {
    // Task 9 (REQ-108): book_shipment now carries the CONFIRM-before-money block — amount_cents == the server sell
    // (187_400). A missing/mismatched confirm would be refused by the chokepoint before the accept-quote.
    const { body, calls } = await runTool(TOKEN_A, "book_shipment", { shipment_id: "shp_qb01", quote_event_id: "evt-priced-1", confirm: { intent: "book", amount_cents: 187_400 } }, acceptApi);
    const out = structured(body);
    expect(out.status).toBe("ACCEPTED");
    expect(out.shipment_id).toBe("shp_qb01");
    expect(out.quote_event_id).toBe("evt-priced-1"); // the accepted priced quote
    expect(out.accepted_event_id).toBe("evt-accepted-1"); // the quote.accepted appended

    // THE NO-BYPASS INVARIANT: the ONLY write is [POST …/accept-quote] with body {quote_event_id}; the sole
    // preceding call is the caps READ (GET …/events). No extra write, and never a booking route.
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.method).toBe("POST");
    expect(writes[0]?.path).toBe("/v1/shipments/shp_qb01/accept-quote");
    expect(writes[0]?.body).toEqual({ quote_event_id: "evt-priced-1" });
    for (const c of calls) {
      expect(c.path).not.toContain("booking");
      expect(c.body?.kind).not.toBe("booking.created");
    }
  });

  it("an api rejection on accept-quote is surfaced (not swallowed, not fabricated) and STILL stops at accept-quote", async () => {
    // The caps read passes (pairing A's quote is readable, sell under cap); the api then refuses the accept-quote
    // itself (e.g. its lens/existence gate — modeled as 404, proven for real by the api's isolation suite). The
    // tool must SURFACE it as an isError, never a fabricated ACCEPTED, and never reach a booking route.
    const rejectAcceptApi: (r: Recorded) => Reply = (r) => {
      if (r.method === "GET" && r.path === "/v1/shipments/shp_qb01/events") return { status: 200, json: { events: [PRICED_EVENT], next_cursor: null } };
      return { status: 404, json: { error: "SHIPMENT NOT IN YOUR SCOPE" } };
    };
    const { body, calls } = await runTool(TOKEN_A, "book_shipment", { shipment_id: "shp_qb01", quote_event_id: "evt-priced-1", confirm: { intent: "book", amount_cents: 187_400 } }, rejectAcceptApi);
    expect(body.result?.isError).toBe(true); // surfaced, never a fabricated ACCEPTED
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe("/v1/shipments/shp_qb01/accept-quote");
    for (const c of calls) expect(c.path).not.toContain("booking");
  });
});

describe("both tools are mutating and route every write through the chokepoint-linked seam", () => {
  it("quote_freight + book_shipment are declared mutating:true", () => {
    const reg = buildRegistry();
    expect(reg.get("quote_freight")?.mutating).toBe(true);
    expect(reg.get("book_shipment")?.mutating).toBe(true);
  });

  it("a write on an UNCLEARED ctx THROWS (proves the tools use mutatingCallApi, not raw callApi)", async () => {
    // If either tool were mis-declared mutating:false, the chokepoint would never run, ctx.mutationCleared
    // would stay false, and mutatingCallApi refuses the write — so invoking the handler with an uncleared ctx
    // throws BEFORE any api round-trip (caps+confirm can never be skipped by a mis-declaration).
    const { api, calls } = recordingApi(() => ({ status: 200, json: {} }));
    const apiEnv = { ...env, API: api } as Env;
    const uncleared: ToolCtx = {
      env: apiEnv,
      pairingId: PAIRING_A,
      mintJwt: async () => "jwt",
      callApi,
      idempotencyKey: "mcp-idem-uncleared",
      mutationCleared: false,
    };
    const reg = buildRegistry();
    await expect(reg.get("book_shipment")!.handler(uncleared, { shipment_id: "shp_qb01", quote_event_id: "evt-priced-1" })).rejects.toThrow();
    await expect(reg.get("quote_freight")!.handler(uncleared, PRICEABLE)).rejects.toThrow();
    expect(calls).toHaveLength(0); // the write never reached the api
  });
});
