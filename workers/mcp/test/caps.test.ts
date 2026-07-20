import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { callApi, type Env } from "../src/index.js";
import { buildRegistry, defaultDispatchDeps, dispatch, type ToolCtx } from "../src/tools/registry.js";
import { capsCheck, currentPeriod } from "../src/caps.js";
import { mintPrincipalJwt } from "../src/principal.js";
import { applyControl, seedPairing, seedTenant } from "./helpers.js";

// WP-13 Task 8 (REQ-105) — the SPEND / VELOCITY / LANE caps on the MCP principal, proved PROMPT-INDEPENDENT and
// FAIL-CLOSED. The check runs SERVER-SIDE in the mutation chokepoint (gate.ts), keyed off ctx.pairingId (the OAuth
// token subject) — so a hostile prompt can never talk past it, and it can never be dodged via a client arg or by
// booking another pairing's pre-created quote. Same harness precedent as quote-book.test.ts: the recording fake
// `env.API` threaded through the REAL OAuth→mint→dispatch→chokepoint pipeline (the cross-worker api DO is
// unseedable from this pool). The per-actor counter is a REAL Durable Object (CAPS_METER) provisioned by the
// pool from wrangler.toml — atomic checkAndReserve, keyed by idFromName(pairingId).

const ISSUER = "https://mcp.shuddl.test";
const TENANT = "t-caps";

// Pairings (with their caps) + the KV token grants that resolve to them. Distinct ids per scenario so each starts
// with a FRESH counter DO (idFromName(pairingId)); tallies never bleed across `it`s.
const P = {
  SPEND: "prn-caps-spend",
  VEL: "prn-caps-vel",
  LANE: "prn-caps-lane",
  NOCAPS: "prn-caps-nocaps",
  QUOTEFAIL: "prn-caps-qfail",
  ATTR_A: "prn-caps-attr-a",
  ATTR_B: "prn-caps-attr-b",
  GHOST: "prn-caps-ghost", // a token grant points here but the pairing row is NEVER seeded (unresolvable)
  LOW: "prn-caps-low", // hostile-prompt: a TINY cap the token pairing really has
  HIGH: "prn-caps-high", // hostile-prompt: the fat cap a malicious arg tries to name
  PASS: "prn-caps-pass", // generous — meter-error + pass-through drives
} as const;
const TOK = (p: string): string => `mcpt_${p}`;

const BIG = 1_000_000_000; // a spend/velocity ceiling well above any test booking

// ── recording fake api (identical seam to quote-book.test.ts) ────────────────────────────────────────────────
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

// A fake api serving ONE booking: the caps events-hop (GET …/events → the priced quote, id === quoteId, with a
// known `sell` + lane basis) then the accept-quote write. Anything else 500s (proves the exact call set).
function bookApi(shipmentId: string, quoteId: string, opts: { sell: number; zone?: string; prefix?: string }): (r: Recorded) => Reply {
  return (r) => {
    if (r.method === "GET" && r.path === `/v1/shipments/${shipmentId}/events`) {
      const basis: Record<string, unknown> = {};
      if (opts.zone !== undefined) basis.zone = opts.zone;
      if (opts.prefix !== undefined) basis.matched_zip_prefix = opts.prefix;
      return { status: 200, json: { events: [{ id: quoteId, kind: "quote.priced", seq: 1, payload: { sell: opts.sell, basis } }], next_cursor: null } };
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

// Drive one tool call through the REAL dispatcher (live composition-root deps) with a spliced fake env.API.
async function runTool(token: string, toolName: string, args: Record<string, unknown>, route: (r: Recorded) => Reply): Promise<{ body: RpcBody; calls: Recorded[] }> {
  const { api, calls } = recordingApi(route);
  const apiEnv = { ...env, API: api } as Env;
  const message = { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name: toolName, arguments: args } };
  const res = await dispatch(apiEnv, defaultDispatchDeps(apiEnv), mcpRequest(token, message));
  return { body: (await res.json()) as RpcBody, calls };
}

// Drive capsCheck DIRECTLY — same real ctx the dispatcher builds (real CONTROL_DB, real mint, real CAPS_METER),
// bypassing only the JSON-RPC envelope + strict-Zod. Used to feed HOSTILE args (which strict Zod would reject) and
// to inject a broken counter. Returns the check's promise + the recorded api calls.
function driveCapsCheck(
  pairingId: string,
  args: unknown,
  route: (r: Recorded) => Reply,
  over: Partial<Env> = {},
): { run: Promise<void>; calls: Recorded[] } {
  const { api, calls } = recordingApi(route);
  const capsEnv = { ...env, API: api, ...over } as Env;
  const ctx: ToolCtx = {
    env: capsEnv,
    pairingId,
    mintJwt: () => mintPrincipalJwt(capsEnv, pairingId),
    callApi,
    idempotencyKey: "caps-test-idem",
    mutationCleared: false,
  };
  const bookTool = buildRegistry().get("book_shipment")!;
  return { run: capsCheck.check(ctx, bookTool, args), calls };
}

function peekTally(pairingId: string): Promise<{ spend: number; count: number }> {
  const stub = env.CAPS_METER.get(env.CAPS_METER.idFromName(pairingId)) as unknown as { peek(p: string): Promise<{ spend: number; count: number }> };
  return stub.peek(currentPeriod(Date.now()));
}

beforeAll(async () => {
  await applyControl(env.CONTROL_DB);
  await seedTenant(env.CONTROL_DB, TENANT, "tenant-caps");
  const caps: Record<string, string> = {
    [P.SPEND]: JSON.stringify({ spend: 200_000, velocity: BIG }), // $2,000/period
    [P.VEL]: JSON.stringify({ spend: BIG, velocity: 2 }),
    [P.LANE]: JSON.stringify({ spend: BIG, velocity: BIG, lanes: ["Z2", "800"] }),
    [P.NOCAPS]: "{}", // unconfigured ⇒ fail-closed
    [P.QUOTEFAIL]: JSON.stringify({ spend: BIG, velocity: BIG }),
    [P.ATTR_A]: JSON.stringify({ spend: BIG, velocity: 1 }),
    [P.ATTR_B]: JSON.stringify({ spend: BIG, velocity: 1 }),
    [P.LOW]: JSON.stringify({ spend: 100, velocity: 5 }), // $1 spend cap
    [P.HIGH]: JSON.stringify({ spend: BIG, velocity: BIG }),
    [P.PASS]: JSON.stringify({ spend: BIG, velocity: BIG }),
  };
  for (const [id, c] of Object.entries(caps)) {
    await seedPairing(env.CONTROL_DB, { id, tenantId: TENANT, kind: "mcp", status: "active", scopes: '["mcp"]', caps: c });
  }
  // KV token grants for the dispatch-driven pairings (+ a GHOST grant whose pairing row is deliberately absent).
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const grant = (p: string): string => JSON.stringify({ pairingId: p, scope: "mcp", exp });
  for (const p of [P.SPEND, P.VEL, P.LANE, P.NOCAPS, P.QUOTEFAIL, P.ATTR_A, P.ATTR_B, P.GHOST, P.LOW]) {
    await env.GRANTS.put(`token:${TOK(p)}`, grant(p));
  }
});

// ── SPEND ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe("spend cap", () => {
  it("a booking that would exceed caps.spend is refused; the accept-quote is NOT made and the tally does not advance", async () => {
    // cap $2,000; each booking sells $1,200 → the 2nd would total $2,400 > cap.
    // Task 9 (REQ-108): book_shipment now runs BEHIND the confirm gate too — an ACCEPTED booking must carry a
    // matching confirm (amount_cents == the server sell). A caps refusal short-circuits ahead of confirm, so the
    // refused calls below need no confirm; the ACCEPTED ones do.
    const first = await runTool(TOK(P.SPEND), "book_shipment", { shipment_id: "shp_s1", quote_event_id: "q_s1", confirm: { intent: "book", amount_cents: 120_000 } }, bookApi("shp_s1", "q_s1", { sell: 120_000 }));
    expect(first.body.result?.structuredContent?.status).toBe("ACCEPTED");
    expect(first.calls.some((c) => c.path.endsWith("/accept-quote"))).toBe(true); // the write happened
    expect(await peekTally(P.SPEND)).toEqual({ spend: 120_000, count: 1 }); // tally advanced

    const second = await runTool(TOK(P.SPEND), "book_shipment", { shipment_id: "shp_s2", quote_event_id: "q_s2" }, bookApi("shp_s2", "q_s2", { sell: 120_000 }));
    expect(second.body.error?.code).toBe(-32001); // MUTATION_BLOCKED
    expect(second.body.error?.data?.code).toBe("spend_cap_exceeded");
    expect(second.calls.some((c) => c.method === "POST")).toBe(false); // accept-quote NEVER attempted
    expect(await peekTally(P.SPEND)).toEqual({ spend: 120_000, count: 1 }); // unchanged — no reserve on a breach
  });
});

// ── VELOCITY ──────────────────────────────────────────────────────────────────────────────────────────────────
describe("velocity cap", () => {
  it("blocks the N+1 booking in the period; earlier ones pass", async () => {
    for (let i = 1; i <= 2; i++) {
      const ok = await runTool(TOK(P.VEL), "book_shipment", { shipment_id: `shp_v${i}`, quote_event_id: `q_v${i}`, confirm: { intent: "book", amount_cents: 1_000 } }, bookApi(`shp_v${i}`, `q_v${i}`, { sell: 1_000 }));
      expect(ok.body.result?.structuredContent?.status).toBe("ACCEPTED");
    }
    const third = await runTool(TOK(P.VEL), "book_shipment", { shipment_id: "shp_v3", quote_event_id: "q_v3" }, bookApi("shp_v3", "q_v3", { sell: 1_000 }));
    expect(third.body.error?.data?.code).toBe("velocity_cap_exceeded");
    expect(third.calls.some((c) => c.method === "POST")).toBe(false);
    expect(await peekTally(P.VEL)).toEqual({ spend: 2_000, count: 2 });
  });
});

// ── LANE ──────────────────────────────────────────────────────────────────────────────────────────────────────
describe("lane cap (allow-list, fail-closed)", () => {
  it("an on-lane booking passes (zone in the allow-list)", async () => {
    const ok = await runTool(TOK(P.LANE), "book_shipment", { shipment_id: "shp_l1", quote_event_id: "q_l1", confirm: { intent: "book", amount_cents: 1_000 } }, bookApi("shp_l1", "q_l1", { sell: 1_000, zone: "Z2" }));
    expect(ok.body.result?.structuredContent?.status).toBe("ACCEPTED");
  });

  it("an off-lane booking is refused; the accept-quote is NOT made", async () => {
    const off = await runTool(TOK(P.LANE), "book_shipment", { shipment_id: "shp_l2", quote_event_id: "q_l2" }, bookApi("shp_l2", "q_l2", { sell: 1_000, zone: "Z9" }));
    expect(off.body.error?.data?.code).toBe("lane_not_allowed");
    expect(off.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("a booking whose lane cannot be determined is refused against a set allow-list (fail-closed)", async () => {
    const blank = await runTool(TOK(P.LANE), "book_shipment", { shipment_id: "shp_l3", quote_event_id: "q_l3" }, bookApi("shp_l3", "q_l3", { sell: 1_000 })); // no zone/prefix
    expect(blank.body.error?.data?.code).toBe("lane_not_allowed");
  });
});

// ── HOSTILE PROMPT — the cap keys off the TOKEN pairing, ignoring any arg a caller smuggles in ─────────────────
describe("prompt-independence (keyed off ctx.pairingId, never a client field)", () => {
  it("a smuggled pairing_id / cap / caps arg does NOT lift the token pairing's real (tiny) cap", async () => {
    // The token pairing is P.LOW ($1 spend cap). The args try to name P.HIGH and a fat cap. capsCheck must apply
    // P.LOW's real cap and refuse the $500 booking — proving it read ctx.pairingId, NOT the args.
    const hostile = { shipment_id: "shp_h1", quote_event_id: "q_h1", pairing_id: P.HIGH, cap: 99_999_999, caps: { spend: 99_999_999, velocity: 9_999 } };
    const { run, calls } = driveCapsCheck(P.LOW, hostile, bookApi("shp_h1", "q_h1", { sell: 50_000 }));
    await expect(run).rejects.toMatchObject({ name: "MutationBlocked", code: "spend_cap_exceeded" });
    expect(calls.some((c) => c.method === "POST")).toBe(false); // accept-quote NEVER attempted
    // P.HIGH's counter was never touched — the malicious arg named a pairing the check simply ignores.
    expect(await peekTally(P.HIGH)).toEqual({ spend: 0, count: 0 });
  });

  it("a smuggled cap arg is inert through the FULL dispatch pipeline (the real cap still refuses; no write)", async () => {
    // Through the whole pipeline to P.LOW ($1 cap): a $500 booking carrying a fat `cap` arg. Whichever layer bites
    // — the strict tool schema rejecting the unknown key, OR capsCheck applying LOW's real $1 cap — the booking is
    // REFUSED and no accept-quote write is made. The smuggled cap never lifts the token pairing's real cap.
    const { body, calls } = await runTool(TOK(P.LOW), "book_shipment", { shipment_id: "shp_h2", quote_event_id: "q_h2", cap: 99_999_999 }, bookApi("shp_h2", "q_h2", { sell: 50_000 }));
    expect(body.error).toBeDefined();
    expect(body.result).toBeUndefined();
    expect(calls.some((c) => c.method === "POST")).toBe(false); // accept-quote NEVER attempted
  });
});

// ── ACTOR ATTRIBUTION — the anti-bypass property ──────────────────────────────────────────────────────────────
describe("actor attribution (tally keyed by the ACTING pairing, never refs.pairing)", () => {
  it("pairing B booking a shipment CREATED BY A counts against B's cap, not A's", async () => {
    // shp_ab was created by pairing A (refs.pairing = A). Pairing B ACTS on book_shipment. Both have velocity 1.
    // B's booking must count against B (its 1 slot is spent → a 2nd B booking is refused), and A's slot must be
    // untouched (A can still make its 1 booking) — the exact bypass the review flagged, now impossible.
    const bOk = await runTool(TOK(P.ATTR_B), "book_shipment", { shipment_id: "shp_ab", quote_event_id: "q_ab", confirm: { intent: "book", amount_cents: 5_000 } }, bookApi("shp_ab", "q_ab", { sell: 5_000 }));
    expect(bOk.body.result?.structuredContent?.status).toBe("ACCEPTED");
    expect(await peekTally(P.ATTR_B)).toEqual({ spend: 5_000, count: 1 }); // charged to B
    expect(await peekTally(P.ATTR_A)).toEqual({ spend: 0, count: 0 }); // A untouched by B's action

    // B is now at its velocity cap — a second B booking (even of a different shipment) is refused.
    const bSecond = await runTool(TOK(P.ATTR_B), "book_shipment", { shipment_id: "shp_ab2", quote_event_id: "q_ab2" }, bookApi("shp_ab2", "q_ab2", { sell: 1 }));
    expect(bSecond.body.error?.data?.code).toBe("velocity_cap_exceeded");

    // A can STILL book its own single slot — B never spent it.
    const aOk = await runTool(TOK(P.ATTR_A), "book_shipment", { shipment_id: "shp_ab", quote_event_id: "q_ab", confirm: { intent: "book", amount_cents: 5_000 } }, bookApi("shp_ab", "q_ab", { sell: 5_000 }));
    expect(aOk.body.result?.structuredContent?.status).toBe("ACCEPTED");
    expect(await peekTally(P.ATTR_A)).toEqual({ spend: 5_000, count: 1 });
  });
});

// ── FAIL-CLOSED ───────────────────────────────────────────────────────────────────────────────────────────────
describe("fail-closed", () => {
  it("an unconfigured cap ({}) refuses the booking and makes NO api call (an unconfigured cap is ZERO, not ∞)", async () => {
    const { body, calls } = await runTool(TOK(P.NOCAPS), "book_shipment", { shipment_id: "shp_n1", quote_event_id: "q_n1" }, bookApi("shp_n1", "q_n1", { sell: 1 }));
    expect(body.error?.data?.code).toBe("caps_unconfigured");
    expect(calls).toHaveLength(0); // refused before even the events hop
  });

  it("an unresolvable pairing (no row) refuses the booking (fail-closed), never allows", async () => {
    const { body, calls } = await runTool(TOK(P.GHOST), "book_shipment", { shipment_id: "shp_g1", quote_event_id: "q_g1" }, bookApi("shp_g1", "q_g1", { sell: 1 }));
    expect(body.error?.data?.code).toBe("caps_unconfigured");
    expect(calls).toHaveLength(0);
  });

  it("an unreadable accepted quote (api 403 on the events hop) refuses the booking; the accept-quote is NOT made", async () => {
    const forbidQuote: (r: Recorded) => Reply = (r) => {
      if (r.method === "GET") return { status: 403, json: { error: "NOT IN YOUR SCOPE" } };
      return { status: 201, json: { id: "should-not-happen" } };
    };
    const { body, calls } = await runTool(TOK(P.QUOTEFAIL), "book_shipment", { shipment_id: "shp_q1", quote_event_id: "q_q1" }, forbidQuote);
    expect(body.error?.data?.code).toBe("caps_quote_unresolved");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("a counter-storage error refuses the booking (fail-closed), never allows", async () => {
    const brokenMeter = {
      idFromName: (name: string) => ({ name }),
      get: () => ({ checkAndReserve: async () => { throw new Error("DO unavailable"); } }),
    } as unknown as Env["CAPS_METER"];
    const { run, calls } = driveCapsCheck(P.PASS, { shipment_id: "shp_m1", quote_event_id: "q_m1" }, bookApi("shp_m1", "q_m1", { sell: 1_000 }), { CAPS_METER: brokenMeter });
    await expect(run).rejects.toMatchObject({ name: "MutationBlocked", code: "caps_meter_error" });
    expect(calls.some((c) => c.method === "POST")).toBe(false); // the write never runs when the meter is down
  });
});

// ── PASS-THROUGH — the check does NOT fire for non-booking tools ───────────────────────────────────────────────
describe("non-booking tools pass straight through (no cap logic, no api call)", () => {
  for (const toolName of ["quote_freight", "track", "get_document"] as const) {
    it(`${toolName} is not metered (capsCheck resolves without touching caps or the api)`, async () => {
      const { api, calls } = recordingApi(() => ({ status: 500, json: { error: "should not be called" } }));
      const capsEnv = { ...env, API: api } as Env;
      const ctx: ToolCtx = {
        env: capsEnv,
        pairingId: P.PASS,
        mintJwt: () => mintPrincipalJwt(capsEnv, P.PASS),
        callApi,
        idempotencyKey: "caps-test-idem",
        mutationCleared: false,
      };
      const tool = buildRegistry().get(toolName)!;
      await expect(capsCheck.check(ctx, tool, { anything: true })).resolves.toBeUndefined();
      expect(calls).toHaveLength(0); // no events hop, no cap lookup — a pure pass-through
    });
  }
});
