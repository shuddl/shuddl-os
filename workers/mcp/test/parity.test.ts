import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { type Env } from "../src/index.js";
import { defaultDispatchDeps, dispatch } from "../src/tools/registry.js";
import { handleRest } from "../src/rest.js";
import { applyControl, seedPairing, seedTenant } from "./helpers.js";

// WP-13 Task 10 (REQ-109) — THE MCP-vs-REST PARITY SUITE. The public JSON API mirror (rest.ts) must be
// STRUCTURALLY the same path as the MCP tools/call — never a re-implementation and never a gate-bypass. We prove
// this by driving the SAME input through BOTH surfaces against the SAME recording fake `env.API` and asserting:
//   1. the SAME structured result, AND
//   2. the SAME exact api call set (method + path + search + body + idempotency key), AND
//   3. the SAME gating — a REST book with no confirm / over-cap is refused EXACTLY as the MCP tool is (the
//      chokepoint runs identically because rest.ts reuses `dispatch`, it does not fork the tool logic).
// Harness precedent: quote-book.test.ts (the recording fake api fallback threaded through the real
// OAuth→mint→dispatch→chokepoint→callApi pipeline).

const PAIRING_A = "prn-mcp-par-a";
const TENANT_A = "t-par-a";
const PAIRING_CAP = "prn-mcp-par-cap"; // a tiny-spend-cap pairing to prove the REST path is gated, not a bypass
const TENANT_CAP = "t-par-cap";
const TOKEN_A = "mcpt_par_a_access_token";
const TOKEN_CAP = "mcpt_par_cap_access_token";
const ISSUER = "https://mcp.shuddl.test";

// ── recording fake api (mirrors quote-book.test.ts) ──────────────────────────────────────────────────────────
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

interface RpcBody {
  jsonrpc: string;
  id: unknown;
  result?: { content?: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
  error?: { code: number; message: string; data?: unknown };
}
let rpcId = 0;

// Drive one MCP tools/call through the REAL dispatcher with a spliced fake env.API (the /mcp path).
async function runMcp(token: string | null, tool: string, args: Record<string, unknown>, route: (r: Recorded) => Reply): Promise<{ status: number; body: RpcBody; calls: Recorded[] }> {
  const { api, calls } = recordingApi(route);
  const apiEnv = { ...env, API: api } as Env;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers["authorization"] = `Bearer ${token}`;
  const message = { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name: tool, arguments: args } };
  const req = new Request(`${ISSUER}/mcp`, { method: "POST", headers, body: JSON.stringify(message) });
  const res = await dispatch(apiEnv, defaultDispatchDeps(apiEnv), req);
  return { status: res.status, body: (await res.json().catch(() => ({}))) as RpcBody, calls };
}

// Drive one REST call through handleRest with the SAME spliced fake env.API (the /api path).
async function runRest(
  token: string | null,
  method: "GET" | "POST",
  path: string,
  body: Record<string, unknown> | null,
  route: (r: Recorded) => Reply,
): Promise<{ status: number; json: Record<string, unknown>; calls: Recorded[]; res: Response }> {
  const { api, calls } = recordingApi(route);
  const apiEnv = { ...env, API: api } as Env;
  const headers: Record<string, string> = {};
  if (token !== null) headers["authorization"] = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== null) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await handleRest(new Request(`${ISSUER}${path}`, init), apiEnv);
  if (res === null) throw new Error(`handleRest returned null for ${method} ${path}`);
  return { status: res.status, json: (await res.clone().json().catch(() => ({}))) as Record<string, unknown>, calls, res };
}

function structured(body: RpcBody): Record<string, unknown> {
  // §1575: NOT `?? {}`. The production REST bridge applies exactly that fallback (`rest.ts:134`), so defaulting
  // here too makes an empty body equal an empty body — `expect(rest.json).toEqual(structured(mcp.body))` then
  // holds BECAUSE both sides lost the payload. Two of the three parity cases are incidentally defended (they
  // also assert `status` is 'PRICED' / 'ACCEPTED'); the track case asserts nothing but this equality and the
  // call set, so it passed with `toToolResult` stripped of `structuredContent` entirely. A helper must fail
  // where the code under test falls back, never agree with it.
  const sc = body.result?.structuredContent;
  if (sc === undefined) throw new Error("§1575: MCP envelope carried no structuredContent — parity would be vacuous");
  return sc;
}
function errData(body: RpcBody): { code?: unknown } {
  return (body.error?.data as { code?: unknown }) ?? {};
}

// ── the fakes ────────────────────────────────────────────────────────────────────────────────────────────────
function happyQuoteApi(): (r: Recorded) => Reply {
  let partyN = 0;
  return (r) => {
    if (r.method === "POST" && r.path === "/v1/parties") return { status: 201, json: { id: `party_${++partyN}`, created: true } };
    if (r.method === "POST" && r.path === "/v1/shipments") return { status: 201, json: { shipment_id: "shp_par01" } };
    if (r.method === "POST" && r.path === "/v1/rate") {
      return { status: 200, json: { status: "PRICED", sell_cents: 187_400, floors: {}, approval: { approval: "none" }, transit: { status: "known", business_days: 3 }, anomaly: null } };
    }
    if (r.method === "GET" && r.path === "/v1/shipments/shp_par01/events") {
      return { status: 200, json: { events: [{ id: "evt-priced-1", kind: "quote.priced", seq: 1 }], next_cursor: null } };
    }
    return { status: 500, json: { error: `unexpected ${r.method} ${r.path}` } };
  };
}

const PRICED_EVENT = { id: "evt-priced-1", kind: "quote.priced", seq: 1, payload: { sell: 187_400, basis: { zone: "Z2", matched_zip_prefix: "800" } } };
const acceptApi: (r: Recorded) => Reply = (r) => {
  if (r.method === "GET" && r.path === "/v1/shipments/shp_par01/events") return { status: 200, json: { events: [PRICED_EVENT], next_cursor: null } };
  if (r.method === "POST" && r.path === "/v1/shipments/shp_par01/accept-quote") return { status: 201, json: { id: "evt-accepted-1", kind: "quote.accepted", seq: 2 } };
  return { status: 500, json: { error: `unexpected ${r.method} ${r.path}` } };
};
const trackApi: (r: Recorded) => Reply = (r) => {
  if (r.method === "GET" && r.path === "/v1/shipments/shp_par01/events") return { status: 200, json: { events: [{ id: "e1", kind: "stop.arrived" }], next_cursor: null } };
  return { status: 500, json: { error: `unexpected ${r.method} ${r.path}` } };
};

const PRICEABLE = {
  shipper: { name: "Acme Widgets" },
  consignee: { name: "Beta Receiving" },
  origin_zip: "97201",
  dest_zip: "80012",
  weight_lb: 1200,
  dims: { l_in: 48, w_in: 40, h_in: 60, pieces: 2 },
};
const BOOK_ARGS = { shipment_id: "shp_par01", quote_event_id: "evt-priced-1", confirm: { intent: "book", amount_cents: 187_400 } };

beforeAll(async () => {
  await applyControl(env.CONTROL_DB);
  await seedTenant(env.CONTROL_DB, TENANT_A, "tenant-par-a");
  await seedTenant(env.CONTROL_DB, TENANT_CAP, "tenant-par-cap");
  const OPEN_CAPS = JSON.stringify({ spend: 1_000_000_000, velocity: 100_000 });
  const TINY_CAPS = JSON.stringify({ spend: 1_000, velocity: 100_000 }); // any real booking (187_400¢) exceeds spend
  await seedPairing(env.CONTROL_DB, { id: PAIRING_A, tenantId: TENANT_A, kind: "mcp", status: "active", scopes: '["mcp"]', caps: OPEN_CAPS });
  await seedPairing(env.CONTROL_DB, { id: PAIRING_CAP, tenantId: TENANT_CAP, kind: "mcp", status: "active", scopes: '["mcp"]', caps: TINY_CAPS });
  const exp = Math.floor(Date.now() / 1000) + 3600;
  await env.GRANTS.put(`token:${TOKEN_A}`, JSON.stringify({ pairingId: PAIRING_A, scope: "mcp", exp }));
  await env.GRANTS.put(`token:${TOKEN_CAP}`, JSON.stringify({ pairingId: PAIRING_CAP, scope: "mcp", exp }));
});

describe("REST mirror ≡ MCP tools — same result AND same api call set (structural reuse)", () => {
  it("POST /api/quote ≡ tools/call quote_freight", async () => {
    const mcp = await runMcp(TOKEN_A, "quote_freight", PRICEABLE, happyQuoteApi());
    const rest = await runRest(TOKEN_A, "POST", "/api/quote", PRICEABLE, happyQuoteApi());
    expect(rest.status).toBe(200);
    expect(rest.json).toEqual(structured(mcp.body)); // identical structured output
    expect(rest.json.status).toBe("PRICED");
    expect(rest.calls).toEqual(mcp.calls); // identical api verbs/paths/bodies/idem-keys — not a forked path
  });

  it("POST /api/book ≡ tools/call book_shipment (the DoD booking path)", async () => {
    const mcp = await runMcp(TOKEN_A, "book_shipment", BOOK_ARGS, acceptApi);
    const rest = await runRest(TOKEN_A, "POST", "/api/book", BOOK_ARGS, acceptApi);
    expect(rest.status).toBe(200);
    expect(rest.json).toEqual(structured(mcp.body));
    expect(rest.json.status).toBe("ACCEPTED");
    expect(rest.json.accepted_event_id).toBe("evt-accepted-1");
    // The ONLY write in BOTH is the accept-quote (preceded by the caps read) — no bypass, no extra write.
    expect(rest.calls).toEqual(mcp.calls);
    const writes = rest.calls.filter((c) => c.method !== "GET");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe("/v1/shipments/shp_par01/accept-quote");
    expect(writes[0]?.idemKey).toBe(mcp.calls.find((c) => c.method !== "GET")?.idemKey); // same derived idem key
  });

  it("GET /api/track/:id ≡ tools/call track (a read pass-through)", async () => {
    const mcp = await runMcp(TOKEN_A, "track", { shipment_id: "shp_par01" }, trackApi);
    const rest = await runRest(TOKEN_A, "GET", "/api/track/shp_par01", null, trackApi);
    expect(rest.status).toBe(200);
    expect(rest.json).toEqual(structured(mcp.body));
    expect(rest.calls).toEqual(mcp.calls);
  });

  it("GET /api/track/:id?kind= forwards the query as the tool `kind` arg", async () => {
    const mcp = await runMcp(TOKEN_A, "track", { shipment_id: "shp_par01", kind: "stop.arrived" }, trackApi);
    const rest = await runRest(TOKEN_A, "GET", "/api/track/shp_par01?kind=stop.arrived", null, trackApi);
    expect(rest.calls).toEqual(mcp.calls);
    expect(rest.calls[0]?.search).toContain("kind=stop.arrived");
  });
});

describe("the REST mutation path is GATED IDENTICALLY — not a gate-bypass (REQ-109/030)", () => {
  it("a REST book with NO confirm is refused (403 confirm_required) EXACTLY like the MCP tool, no accept-quote write", async () => {
    const noConfirm = { shipment_id: "shp_par01", quote_event_id: "evt-priced-1" };
    const mcp = await runMcp(TOKEN_A, "book_shipment", noConfirm, acceptApi);
    const rest = await runRest(TOKEN_A, "POST", "/api/book", noConfirm, acceptApi);

    // MCP: a JSON-RPC MutationBlocked (-32001) carrying the machine token.
    expect(mcp.body.error?.code).toBe(-32001);
    expect(errData(mcp.body).code).toBe("confirm_required");
    // REST: the SAME refusal surfaced as a 403 carrying the SAME machine token.
    expect(rest.status).toBe(403);
    expect(rest.json.code).toBe("confirm_required");
    // Neither reached the accept-quote write (the chokepoint blocked ahead of the handler).
    expect(rest.calls.some((c) => c.path.includes("accept-quote"))).toBe(false);
    expect(mcp.calls.some((c) => c.path.includes("accept-quote"))).toBe(false);
  });

  it("a REST book OVER the spend cap is refused (403 spend_cap_exceeded) EXACTLY like the MCP tool", async () => {
    const mcp = await runMcp(TOKEN_CAP, "book_shipment", BOOK_ARGS, acceptApi);
    const rest = await runRest(TOKEN_CAP, "POST", "/api/book", BOOK_ARGS, acceptApi);
    expect(mcp.body.error?.code).toBe(-32001);
    expect(errData(mcp.body).code).toBe("spend_cap_exceeded");
    expect(rest.status).toBe(403);
    expect(rest.json.code).toBe("spend_cap_exceeded");
    expect(rest.calls.some((c) => c.path.includes("accept-quote"))).toBe(false);
  });

  it("a REST book with a MISMATCHED confirm amount is refused (403 confirm_mismatch)", async () => {
    const wrong = { shipment_id: "shp_par01", quote_event_id: "evt-priced-1", confirm: { intent: "book", amount_cents: 1 } };
    const rest = await runRest(TOKEN_A, "POST", "/api/book", wrong, acceptApi);
    expect(rest.status).toBe(403);
    expect(rest.json.code).toBe("confirm_mismatch");
    expect(rest.calls.some((c) => c.path.includes("accept-quote"))).toBe(false);
  });
});

describe("REST auth edge is identical to MCP (OAuth bearer → resolveTokenGrant)", () => {
  it("no bearer → 401 on both surfaces (nothing dispatched)", async () => {
    const mcp = await runMcp(null, "track", { shipment_id: "shp_par01" }, trackApi);
    const rest = await runRest(null, "GET", "/api/track/shp_par01", null, trackApi);
    expect(mcp.status).toBe(401);
    expect(rest.status).toBe(401);
    expect(rest.res.headers.get("www-authenticate")).toContain("Bearer"); // same challenge as /mcp
    expect(rest.calls).toHaveLength(0); // no api round-trip on an unauthenticated call
  });

  it("an invalid/unknown bearer → 401 (fail-closed, no mint, no api call)", async () => {
    const rest = await runRest("not-a-real-token", "POST", "/api/book", BOOK_ARGS, acceptApi);
    expect(rest.status).toBe(401);
    expect(rest.calls).toHaveLength(0);
  });
});

describe("REST envelope edges", () => {
  it("an unknown /api/* route is a 404 (owned by the mirror, never a fall-through)", async () => {
    const res = await handleRest(new Request(`${ISSUER}/api/nope`, { method: "POST", headers: { authorization: `Bearer ${TOKEN_A}` } }), env);
    expect(res).not.toBeNull();
    expect(res?.status).toBe(404);
  });

  it("a non-/api path returns null (falls through to /mcp + health)", async () => {
    const res = await handleRest(new Request(`${ISSUER}/mcp`, { method: "POST" }), env);
    expect(res).toBeNull();
  });

  it("a malformed JSON body on a POST → 400 before any dispatch", async () => {
    const res = await handleRest(
      new Request(`${ISSUER}/api/quote`, { method: "POST", headers: { authorization: `Bearer ${TOKEN_A}`, "content-type": "application/json" }, body: "{not json" }),
      env,
    );
    expect(res?.status).toBe(400);
  });

  it("an api rejection surfaces as a non-2xx (never a fabricated success)", async () => {
    const rejectApi: (r: Recorded) => Reply = (r) => {
      if (r.method === "GET" && r.path === "/v1/shipments/shp_par01/events") return { status: 200, json: { events: [PRICED_EVENT], next_cursor: null } };
      return { status: 404, json: { error: "NOT IN SCOPE" } };
    };
    const rest = await runRest(TOKEN_A, "POST", "/api/book", BOOK_ARGS, rejectApi);
    expect(rest.status).toBe(502); // the tool's isError → a gateway error, carrying only a status-derived message
    expect(String(rest.json.error)).not.toContain("NOT IN SCOPE"); // the api's internal body never leaks (REQ-192)
  });
});
