import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { callApi, type Env } from "../src/index.js";
import { buildRegistry, defaultDispatchDeps, dispatch, type ToolCtx } from "../src/tools/registry.js";
import { confirmCheck } from "../src/confirm.js";
import { mintPrincipalJwt } from "../src/principal.js";
import { applyControl, seedPairing, seedTenant } from "./helpers.js";

// WP-13 Task 9 (REQ-108) — the CONFIRM-BEFORE-MONEY gate on book_shipment, proved SERVER-SIDE and MODEL-INDEPENDENT.
//
// book_shipment is the money commitment (accept a priced quote). It MUST carry a STRUCTURED confirm
// `{ intent: "book", amount_cents }` whose amount EQUALS the SERVER-RECORDED accepted quote's sell. A missing or
// mismatched confirm REFUSES the write (MutationBlocked) BEFORE the accept-quote — the model cannot self-authorize
// money movement, and a client that claims a cheap amount for an expensive booking is refused (the sell is the
// server's, never the client's). Read tools (quote/track/document) and the approve decision carry no confirm.
//
// Harness: the caps.test.ts precedent — the recording fake `env.API` threaded through the REAL
// OAuth→mint→dispatch→chokepoint pipeline (the cross-worker api DO is unseedable from this pool). The chain is
// [caps, confirm] (gate.ts): caps runs first (it owns the accepted-quote fetch + fail-closed codes), confirm reuses
// the sell MEMOIZED on ctx (no double-fetch). Generous caps here so caps always passes and confirm is the decider.

const ISSUER = "https://mcp.shuddl.test";
const TENANT = "t-confirm";
const BIG = 1_000_000_000; // spend/velocity ceilings well above any test booking (caps never the decider here)

const P = {
  OK: "prn-cfm-ok", // generous caps → caps passes, confirm decides
  TIGHT: "prn-cfm-tight", // a $1 spend cap → caps refuses FIRST (proves caps still runs ahead of confirm)
} as const;
const TOK = (p: string): string => `mcpt_${p}`;

// ── recording fake api (same seam as caps.test.ts) ──────────────────────────────────────────────────────────────
interface Recorded {
  method: string;
  path: string;
  search: string;
  body: Record<string, unknown> | undefined;
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
      const rec: Recorded = { method: request.method, path: url.pathname, search: url.search, body };
      calls.push(rec);
      const { status, json } = route(rec);
      return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
    },
  } as unknown as Fetcher;
  return { api, calls };
}

// A fake api serving ONE booking: the events-hop (GET …/events → the priced quote, id === quoteId, with a known
// `sell`) then the accept-quote write. Anything else 500s (proves the exact call set).
function bookApi(shipmentId: string, quoteId: string, sell: number): (r: Recorded) => Reply {
  return (r) => {
    if (r.method === "GET" && r.path === `/v1/shipments/${shipmentId}/events`) {
      return { status: 200, json: { events: [{ id: quoteId, kind: "quote.priced", seq: 1, payload: { sell, basis: {} } }], next_cursor: null } };
    }
    if (r.method === "POST" && r.path === `/v1/shipments/${shipmentId}/accept-quote`) {
      return { status: 201, json: { id: `acc-${quoteId}`, kind: "quote.accepted", seq: 2 } };
    }
    return { status: 500, json: { error: `unexpected ${r.method} ${r.path}` } };
  };
}

interface RpcBody {
  jsonrpc: string;
  id: unknown;
  result?: { structuredContent?: Record<string, unknown>; isError?: boolean };
  error?: { code: number; message: string; data?: { code?: string } };
}
let rpcId = 0;
function mcpRequest(token: string, message: unknown): Request {
  return new Request(`${ISSUER}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(message),
  });
}

// Drive one tool call through the REAL dispatcher (live composition-root deps: caps + confirm chain) with a spliced
// fake env.API.
async function runTool(token: string, toolName: string, args: Record<string, unknown>, route: (r: Recorded) => Reply): Promise<{ body: RpcBody; calls: Recorded[] }> {
  const { api, calls } = recordingApi(route);
  const apiEnv = { ...env, API: api } as Env;
  const message = { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name: toolName, arguments: args } };
  const res = await dispatch(apiEnv, defaultDispatchDeps(apiEnv), mcpRequest(token, message));
  return { body: (await res.json()) as RpcBody, calls };
}

// Drive confirmCheck DIRECTLY — the same real ctx the dispatcher builds (real mint, memo lazily created), bypassing
// only the JSON-RPC envelope + strict-Zod. Used to feed shapes strict Zod would reject (a wrong intent) and to prove
// the pass-through for non-booking tools without an api round-trip.
function driveConfirmCheck(pairingId: string, toolName: string, args: unknown, route: (r: Recorded) => Reply): { run: Promise<void>; calls: Recorded[] } {
  const { api, calls } = recordingApi(route);
  const cEnv = { ...env, API: api } as Env;
  const ctx: ToolCtx = {
    env: cEnv,
    pairingId,
    mintJwt: () => mintPrincipalJwt(cEnv, pairingId),
    callApi,
    idempotencyKey: "confirm-test-idem",
    mutationCleared: false,
  };
  const tool = buildRegistry().get(toolName)!;
  return { run: confirmCheck.check(ctx, tool, args), calls };
}

const noApi: (r: Recorded) => Reply = (r) => ({ status: 500, json: { error: `unexpected ${r.method} ${r.path}` } });

// A matching confirm for a given sell (the happy shape the caller must supply).
const confirmFor = (amount: number): Record<string, unknown> => ({ intent: "book", amount_cents: amount });

beforeAll(async () => {
  await applyControl(env.CONTROL_DB);
  await seedTenant(env.CONTROL_DB, TENANT, "tenant-confirm");
  await seedPairing(env.CONTROL_DB, { id: P.OK, tenantId: TENANT, kind: "mcp", status: "active", scopes: '["mcp"]', caps: JSON.stringify({ spend: BIG, velocity: BIG }) });
  await seedPairing(env.CONTROL_DB, { id: P.TIGHT, tenantId: TENANT, kind: "mcp", status: "active", scopes: '["mcp"]', caps: JSON.stringify({ spend: 100, velocity: BIG }) }); // $1 spend cap
  const exp = Math.floor(Date.now() / 1000) + 3600;
  for (const p of [P.OK, P.TIGHT]) {
    await env.GRANTS.put(`token:${TOK(p)}`, JSON.stringify({ pairingId: p, scope: "mcp", exp }));
  }
});

// ── MISSING CONFIRM — the money commitment is refused ─────────────────────────────────────────────────────────
describe("book_shipment requires a structured confirm", () => {
  it("a booking WITHOUT a confirm block is refused (confirm_required); the accept-quote is NOT made", async () => {
    const { body, calls } = await runTool(TOK(P.OK), "book_shipment", { shipment_id: "shp_m1", quote_event_id: "q_m1" }, bookApi("shp_m1", "q_m1", 120_000));
    expect(body.error?.code).toBe(-32001); // MUTATION_BLOCKED
    expect(body.error?.data?.code).toBe("confirm_required");
    expect(body.result).toBeUndefined();
    expect(calls.some((c) => c.method === "POST")).toBe(false); // accept-quote NEVER attempted
  });
});

// ── MISMATCHED CONFIRM — the amount must equal the SERVER sell ─────────────────────────────────────────────────
describe("confirm.amount_cents must equal the accepted quote's SERVER sell", () => {
  it("a confirm whose amount_cents ≠ the accepted quote's sell is refused (confirm_mismatch); no accept-quote", async () => {
    const args = { shipment_id: "shp_x1", quote_event_id: "q_x1", confirm: confirmFor(999) }; // server sell is 120_000
    const { body, calls } = await runTool(TOK(P.OK), "book_shipment", args, bookApi("shp_x1", "q_x1", 120_000));
    expect(body.error?.data?.code).toBe("confirm_mismatch");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("SERVER-SELL vs CLIENT-CLAIM: a client that confirms a LOW amount for an EXPENSIVE booking is refused", async () => {
    // The confirm claims $50 while the server's recorded sell is $5,000. The gate compares against the SERVER sell,
    // so the model can NEVER talk the price down to self-authorize an expensive booking.
    const args = { shipment_id: "shp_c1", quote_event_id: "q_c1", confirm: confirmFor(5_000) };
    const { body, calls } = await runTool(TOK(P.OK), "book_shipment", args, bookApi("shp_c1", "q_c1", 500_000));
    expect(body.error?.data?.code).toBe("confirm_mismatch");
    expect(body.error?.message).toContain("500000"); // the SERVER sell, surfaced (not the client's 5000)
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

// ── MATCHING CONFIRM — proceeds through caps to the write; the sell is fetched ONCE ────────────────────────────
describe("a matching confirm proceeds through the chain to the accept-quote", () => {
  it("book_shipment with a matching confirm is ACCEPTED; both gates ran and the sell was fetched ONCE (ctx memo)", async () => {
    const args = { shipment_id: "shp_ok1", quote_event_id: "q_ok1", confirm: confirmFor(120_000) };
    const { body, calls } = await runTool(TOK(P.OK), "book_shipment", args, bookApi("shp_ok1", "q_ok1", 120_000));
    expect(body.result?.structuredContent?.status).toBe("ACCEPTED");
    // The accept-quote write happened ONLY because confirm AND caps both passed.
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/accept-quote"))).toBe(true);
    // MEMOIZATION: caps + confirm share the accepted-quote lookup — the quote.priced event is read exactly ONCE.
    const eventReads = calls.filter((c) => c.method === "GET" && c.path.endsWith("/events"));
    expect(eventReads).toHaveLength(1);
  });
});

// ── BOTH GATES RUN — a refusal from EITHER blocks the write ────────────────────────────────────────────────────
describe("caps + confirm both gate the booking (a refusal from either blocks it)", () => {
  it("caps refuses FIRST when its cap is breached — even with a perfectly matching confirm (proves caps still runs)", async () => {
    // P.TIGHT has a $1 spend cap; the booking sells $500 with a MATCHING confirm. caps runs ahead of confirm and
    // refuses the spend — so a valid confirm does NOT smuggle a booking past caps.
    const args = { shipment_id: "shp_t1", quote_event_id: "q_t1", confirm: confirmFor(50_000) };
    const { body, calls } = await runTool(TOK(P.TIGHT), "book_shipment", args, bookApi("shp_t1", "q_t1", 50_000));
    expect(body.error?.data?.code).toBe("spend_cap_exceeded");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

// ── WRONG INTENT / MALFORMED CONFIRM — fail-closed (direct, bypassing strict Zod) ──────────────────────────────
describe("confirmCheck fails closed on a malformed confirm (defense-in-depth beyond strict Zod)", () => {
  it("a confirm with the WRONG intent is refused (confirm_mismatch); the accept-quote is never read or made", async () => {
    const { run, calls } = driveConfirmCheck(P.OK, "book_shipment", { shipment_id: "shp_w1", quote_event_id: "q_w1", confirm: { intent: "cancel", amount_cents: 120_000 } }, noApi);
    await expect(run).rejects.toMatchObject({ name: "MutationBlocked", code: "confirm_mismatch" });
    expect(calls).toHaveLength(0); // refused before even the events hop
  });

  it("a confirm with a non-integer amount_cents is refused (confirm_mismatch)", async () => {
    const { run, calls } = driveConfirmCheck(P.OK, "book_shipment", { shipment_id: "shp_w2", quote_event_id: "q_w2", confirm: { intent: "book", amount_cents: 1.5 } }, noApi);
    await expect(run).rejects.toMatchObject({ name: "MutationBlocked", code: "confirm_mismatch" });
    expect(calls).toHaveLength(0);
  });

  it("a book_shipment missing shipment_id/quote_event_id cannot validate its confirm and is refused (fail-closed)", async () => {
    const { run, calls } = driveConfirmCheck(P.OK, "book_shipment", { confirm: { intent: "book", amount_cents: 120_000 } }, noApi);
    await expect(run).rejects.toMatchObject({ name: "MutationBlocked" });
    expect(calls).toHaveLength(0);
  });
});

// ── PASS-THROUGH — read tools + the approve decision carry NO confirm (approve-confirm deferred, REQ-108) ───────
describe("non-booking tools pass straight through the confirm gate (no confirm required)", () => {
  for (const toolName of ["quote_freight", "track", "get_document", "approve"] as const) {
    it(`${toolName} needs no confirm (confirmCheck resolves without touching the api)`, async () => {
      const { run, calls } = driveConfirmCheck(P.OK, toolName, { anything: true }, noApi);
      await expect(run).resolves.toBeUndefined();
      expect(calls).toHaveLength(0); // no events hop — a pure pass-through
    });
  }
});
