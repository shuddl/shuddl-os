import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { callApi, type Env } from "../src/index.js";
import { buildRegistry, defaultDispatchDeps, dispatch, type ToolCtx } from "../src/tools/registry.js";
import { applyControl, seedPairing, seedTenant } from "./helpers.js";

// WP-13 Tasks 6-7 (REQ-101/192/194) — track + get_document (READS) and approve + dispute (mutating),
// driven through the REAL OAuth→mint→dispatch→(chokepoint)→callApi pipeline with a RECORDING fake `env.API`
// (the quote-book harness precedent). The recorder captures the EXACT REST call set (method+path+search+body),
// so the reused verbs, the read pass-through, the strict decision body, and the no-bypass are proven
// structurally. The api's own gates (lens redaction / coarse geo / the approval matrix required_role re-check)
// are proven UNCHANGED by the api's suites (events/documents/invoices/approvals/portal-actions .test.ts); this
// suite proves the TOOL routes to the right verb, passes the lens-narrowed api response through untouched, and
// surfaces an api refusal (403/404) as an isError result rather than fabricating success.

const PAIRING_A = "prn-mcp-rd-a";
const TENANT_A = "t-rd-a";
const TOKEN_A = "mcpt_rd_a_access_token";
const ISSUER = "https://mcp.shuddl.test";

// ── recording fake api (the fallback seam, mirrors quote-book.test.ts) ───────────────────────────────────────
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
function mcpRequest(token: string | null, message: unknown): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers["authorization"] = `Bearer ${token}`;
  return new Request(`${ISSUER}/mcp`, { method: "POST", headers, body: JSON.stringify(message) });
}

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
function errorText(body: RpcBody): string {
  return body.result?.content?.[0]?.text ?? "";
}

beforeAll(async () => {
  await applyControl(env.CONTROL_DB);
  await seedTenant(env.CONTROL_DB, TENANT_A, "tenant-rd-a");
  await seedPairing(env.CONTROL_DB, { id: PAIRING_A, tenantId: TENANT_A, kind: "mcp", status: "active", scopes: '["mcp"]' });
  const exp = Math.floor(Date.now() / 1000) + 3600;
  await env.GRANTS.put(`token:${TOKEN_A}`, JSON.stringify({ pairingId: PAIRING_A, scope: "mcp", exp }));
});

// ── track (READ) ─────────────────────────────────────────────────────────────────────────────────────────────
describe("track (Task 6) — the lens-narrowed shipment feed, passed through untouched", () => {
  // A canned api response IN THE api's own lens-narrowed shape: a coarse (~city) position, and NONE of the
  // internal fields the lens strips (no prev_hash/hash/device_seq). The tool must return it VERBATIM.
  const lensNarrowedApi: (r: Recorded) => Reply = (r) => {
    if (r.method === "GET" && r.path === "/v1/shipments/shp01/events") {
      return {
        status: 200,
        json: {
          events: [{ id: "evt-1", kind: "stop.arrived", seq: 5, position: { city: "Denver", region: "CO" } }],
          next_cursor: null,
        },
      };
    }
    return { status: 500, json: { error: "unexpected" } };
  };

  it("returns the api's lens-narrowed events verbatim (coarse position, no internal fields, one GET, no raw read)", async () => {
    const { body, calls } = await runTool(TOKEN_A, "track", { shipment_id: "shp01" }, lensNarrowedApi);
    const out = structured(body);
    const events = out.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    // Passed through exactly — the coarse position survives, and nothing internal was added.
    expect((events[0]?.position as Record<string, unknown>)?.city).toBe("Denver");
    expect(events[0]).not.toHaveProperty("prev_hash");
    expect(events[0]).not.toHaveProperty("hash");
    // Structural proof it did NOT do a raw D1 read: the ONLY api call is the single lens GET.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.path).toBe("/v1/shipments/shp01/events");
    expect(calls[0]?.hasAuth).toBe(true);
  });

  it("passes a kind filter through to the api query (the api validates the 35-kind catalog)", async () => {
    const { calls } = await runTool(TOKEN_A, "track", { shipment_id: "shp01", kind: "stop.arrived" }, lensNarrowedApi);
    expect(calls[0]?.search).toContain("kind=stop.arrived");
  });

  it("a shipment the lens returns EMPTY for → an empty feed, never a fabricated event (fail-closed)", async () => {
    const emptyApi: (r: Recorded) => Reply = () => ({ status: 200, json: { events: [], next_cursor: null } });
    const { body } = await runTool(TOKEN_A, "track", { shipment_id: "shp-unseen" }, emptyApi);
    expect(body.result?.isError).toBeFalsy();
    expect((structured(body).events as unknown[]).length).toBe(0);
  });

  it("a non-2xx from the api → an isError result (fail-closed), NEVER a fabricated feed", async () => {
    const notFoundApi: (r: Recorded) => Reply = () => ({ status: 404, json: { error: "NOT FOUND" } });
    const { body } = await runTool(TOKEN_A, "track", { shipment_id: "shp-missing" }, notFoundApi);
    expect(body.result?.isError).toBe(true);
    expect(structured(body).events).toBeUndefined();
  });
});

// ── get_document (READ) ──────────────────────────────────────────────────────────────────────────────────────
describe("get_document (Task 6) — documents list, a signed cap url, and invoices", () => {
  it("default → the portal-safe documents list (the api omits r2_key/hash)", async () => {
    const docsApi: (r: Recorded) => Reply = (r) => {
      if (r.method === "GET" && r.path === "/v1/shipments/shp01/documents") {
        return { status: 200, json: { documents: [{ id: "evidence:shp01:ab", shipment_id: "shp01", party_id: "p1", kind: "pod", visibility: "counterparty" }] } };
      }
      return { status: 500, json: { error: "unexpected" } };
    };
    const { body, calls } = await runTool(TOKEN_A, "get_document", { shipment_id: "shp01" }, docsApi);
    const out = structured(body);
    const docs = out.documents as Array<Record<string, unknown>>;
    expect(docs).toHaveLength(1);
    expect(docs[0]?.id).toBe("evidence:shp01:ab");
    expect(docs[0]).not.toHaveProperty("r2_key"); // portal-safe — the api enforces the column set
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/v1/shipments/shp01/documents");
  });

  it("a specific document_id → the short-lived SIGNED cap url via /v1/documents/:id/url", async () => {
    // The evidence doc id carries colons; the tool encodeURIComponent's it to one path segment (Hono decodes it
    // back for :id). So the WIRE pathname is percent-encoded — match on it, and prove it round-trips to the id.
    const urlApi: (r: Recorded) => Reply = (r) => {
      if (r.method === "GET" && r.path.startsWith("/v1/documents/") && r.path.endsWith("/url")) {
        return { status: 200, json: { url: "/pub/documents/CAP123", expires_in: 300 } };
      }
      return { status: 500, json: { error: "unexpected" } };
    };
    const { body, calls } = await runTool(TOKEN_A, "get_document", { shipment_id: "shp01", document_id: "evidence:shp01:ab" }, urlApi);
    const out = structured(body);
    expect(out.url).toBe("/pub/documents/CAP123");
    expect(out.expires_in).toBe(300);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/v1/documents/evidence%3Ashp01%3Aab/url"); // encoded on the wire
    expect(decodeURIComponent(calls[0]!.path)).toBe("/v1/documents/evidence:shp01:ab/url"); // decodes to the id
  });

  it("invoices:true → the invoices via the invoice endpoint (portal-safe columns)", async () => {
    const invApi: (r: Recorded) => Reply = (r) => {
      if (r.method === "GET" && r.path === "/v1/invoices") {
        return { status: 200, json: { invoices: [{ id: "inv1", party_id: "p1", shipment_ids: ["shp01"], total_cents: 187_400, status: "open", due_ts: 0 }] } };
      }
      return { status: 500, json: { error: "unexpected" } };
    };
    const { body, calls } = await runTool(TOKEN_A, "get_document", { shipment_id: "shp01", invoices: true }, invApi);
    const out = structured(body);
    const invoices = out.invoices as Array<Record<string, unknown>>;
    expect(invoices).toHaveLength(1);
    expect(invoices[0]?.id).toBe("inv1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/v1/invoices");
    expect(calls[0]?.search).toContain("shipment_id=shp01");
  });
});

// ── approve (mutating) ───────────────────────────────────────────────────────────────────────────────────────
describe("approve (Task 7) — the matrix-gated approval decision", () => {
  it("an ops-satisfiable approval → the api's 201 decision, surfaced (strict {decision} body, no approval_event_id leak)", async () => {
    const okApi: (r: Recorded) => Reply = (r) => {
      if (r.method === "POST" && r.path === "/v1/shipments/shp01/approval-decision") {
        return { status: 201, json: { id: "evt-decided-1", kind: "approval.decided", seq: 9, stream_id: "s:shp01" } };
      }
      return { status: 500, json: { error: `unexpected ${r.method} ${r.path}` } };
    };
    // approval_event_id supplied in the tool input; it must NOT reach the api's strict body (the api selects the
    // OPEN approval by shipment itself). decision is the whole api surface.
    const { body, calls } = await runTool(TOKEN_A, "approve", { shipment_id: "shp01", decision: "approved", approval_event_id: "evt-req-1" }, okApi);
    const out = structured(body);
    expect(out.decision).toBe("approved");
    expect(out.decided_event_id).toBe("evt-decided-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/v1/shipments/shp01/approval-decision");
    expect(calls[0]?.body).toEqual({ decision: "approved" }); // strict — approval_event_id was NOT forwarded
    expect(calls[0]?.idemKey).not.toBeNull(); // a mutation carries the derived Idempotency-Key
  });

  it("a FINANCE-required approval → the api's 403 (ops principal cannot satisfy it) surfaced as isError", async () => {
    // The MCP principal is role=ops. The api re-checks the matrix required_role SERVER-SIDE and 403s an ops
    // decision on a finance-required (loss/dual) approval — modeled here, proven for real by approvals.test.ts.
    const financeGatedApi: (r: Recorded) => Reply = () => ({ status: 403, json: { error: "YOUR ROLE DOES NOT SATISFY THIS APPROVAL'S REQUIRED ROLE" } });
    const { body, calls } = await runTool(TOKEN_A, "approve", { shipment_id: "shp01", decision: "approved" }, financeGatedApi);
    expect(body.result?.isError).toBe(true); // surfaced, never a fabricated decision
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/v1/shipments/shp01/approval-decision");
  });

  it("is declared mutating:true and routes its write through the chokepoint-linked seam", async () => {
    const reg = buildRegistry();
    expect(reg.get("approve")?.mutating).toBe(true);
    // A write on an UNCLEARED ctx THROWS (proves the tool uses mutatingCallApi, not raw callApi).
    const { api, calls } = recordingApi(() => ({ status: 200, json: {} }));
    const apiEnv = { ...env, API: api } as Env;
    const uncleared: ToolCtx = { env: apiEnv, pairingId: PAIRING_A, mintJwt: async () => "jwt", callApi, idempotencyKey: "mcp-idem-uncleared", mutationCleared: false };
    await expect(reg.get("approve")!.handler(uncleared, { shipment_id: "shp01", decision: "approved" })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

// ── dispute (mutating) ───────────────────────────────────────────────────────────────────────────────────────
describe("dispute (Task 7) — a claim as a portal-channel message.received (no new kind/table)", () => {
  it("records a claim; the api-call set is EXACTLY [POST …/claim] with the reason as the message body", async () => {
    const claimApi: (r: Recorded) => Reply = (r) => {
      if (r.method === "POST" && r.path === "/v1/shipments/shp01/claim") {
        return { status: 201, json: { id: "evt-claim-1", kind: "message.received", seq: 3, stream_id: "s:shp01" } };
      }
      return { status: 500, json: { error: `unexpected ${r.method} ${r.path}` } };
    };
    const { body, calls } = await runTool(TOKEN_A, "dispute", { shipment_id: "shp01", reason: "pallet crushed on arrival" }, claimApi);
    const out = structured(body);
    expect(out.claim_event_id).toBe("evt-claim-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/v1/shipments/shp01/claim");
    expect(calls[0]?.body?.description).toBe("pallet crushed on arrival");
    expect(calls[0]?.idemKey).not.toBeNull();
  });

  it("is declared mutating:true and routes its write through the chokepoint-linked seam", async () => {
    const reg = buildRegistry();
    expect(reg.get("dispute")?.mutating).toBe(true);
    const { api, calls } = recordingApi(() => ({ status: 200, json: {} }));
    const apiEnv = { ...env, API: api } as Env;
    const uncleared: ToolCtx = { env: apiEnv, pairingId: PAIRING_A, mintJwt: async () => "jwt", callApi, idempotencyKey: "mcp-idem-uncleared", mutationCleared: false };
    await expect(reg.get("dispute")!.handler(uncleared, { shipment_id: "shp01", reason: "x" })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

// ── error hygiene (REQ-192) ──────────────────────────────────────────────────────────────────────────────────
describe("error hygiene — no internal detail / stack in any tool response or error (REQ-192)", () => {
  it("an api 500 → a generic isError with only the status, NEVER the api's internal error body", async () => {
    const leakyApi: (r: Recorded) => Reply = () => ({ status: 500, json: { error: "INTERNAL_STACK_SECRET at events.ts:274" } });
    const { body } = await runTool(TOKEN_A, "track", { shipment_id: "shp01" }, leakyApi);
    expect(body.result?.isError).toBe(true);
    const text = errorText(body);
    expect(text).not.toContain("INTERNAL_STACK_SECRET");
    expect(text).not.toContain("events.ts");
    expect(text).not.toMatch(/\bat \w+.*:\d+/); // no stack frame
  });
});
