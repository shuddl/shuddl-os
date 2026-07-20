import { env } from "cloudflare:test";
import { decode } from "hono/jwt";
import { beforeAll, describe, expect, it } from "vitest";
import { callApi, type Env } from "../src/index.js";
import { buildRegistry, defaultDispatchDeps, dispatch } from "../src/tools/registry.js";
import { currentPeriod } from "../src/caps.js";
import { mintPrincipalJwt, MCP_PRINCIPAL_ROLE } from "../src/principal.js";
import { applyControl, seedPairing, seedTenant } from "./helpers.js";

// WP-13 Task 11 (REQ-025) — THE CONSOLIDATED TENANT / COMPANY ISOLATION MATRIX for the MCP surface.
//
// REQ-025 (CLAUDE.md rule #8): a cross-tenant read/write ANYWHERE is a build failure. For the MCP surface
// "anywhere" is every tool × every seam it drives. The isolation root is the MINT: `tenant` is the pairing row's
// tenant_id and NOTHING else — never a tool arg, never a header, never a client field (principal.ts). This suite
// proves, per tool (quote, book, track, get_document, approve, dispute), that a pairing scoped to tenant A cannot
// read or write tenant B — and does it the way the skill (prove-tenant-isolation-read-paths) demands: BOTH a
// per-path route case with all attack shapes AND a direct mint assertion (the "prefix regression net" — a builder
// whose output for two tenants is identical up to the tenant slug is the whole point).
//
// HARNESS — the quote-book/caps precedent: the recording fake `env.API` threaded through the REAL
// OAuth→mint→dispatch→chokepoint→callApi pipeline (the cross-worker api DO is unseedable from this pool). The
// fake is TENANT-AWARE: it DECODES the minted principal off the wire and serves a shipment's data ONLY when the
// requesting tenant owns it — so if the MCP layer ever LEAKED tenant B (minted B, or forwarded a smuggled B),
// the fake would return B's rows and the assertion would FAIL. That is the fail-on-leak property REQ-025 needs.
// (The api's OWN lens redaction/coarsening is proven UNCHANGED by the api suites; here we prove the MCP layer
// never hands the api anything but its own pairing's tenant, and never fabricates a cross-tenant row.)

const ISSUER = "https://mcp.shuddl.test";

const TENANT_A = "t-iso-a";
const TENANT_B = "t-iso-b";

const PAIRING_A1 = "prn-iso-a1"; // tenant A
const PAIRING_A2 = "prn-iso-a2"; // tenant A — a DIFFERENT pairing (the "company / cross-pairing" case)
const PAIRING_B1 = "prn-iso-b1"; // tenant B
const MTR_A = "prn-iso-mtr-a"; // tenant A, velocity 1 — the per-pairing CapsMeter DO isolation
const MTR_B = "prn-iso-mtr-b"; // tenant B, velocity 1
const TOK = (p: string): string => `mcpt_${p}`;

const SHIP_A = "shp_iso_a"; // owned by tenant A
const SHIP_B = "shp_iso_b"; // owned by tenant B
const BIG = 1_000_000_000;

// ── the tenant-aware recording fake api ──────────────────────────────────────────────────────────────────────
// Decodes the principal off the Authorization bearer so a route closure can gate on the ACTUAL minted tenant.
function bearerTenant(request: Request): string | null {
  const h = request.headers.get("authorization");
  if (h === null || !h.startsWith("Bearer ")) return null;
  try {
    const { payload } = decode(h.slice(7));
    const t = (payload as { tenant?: unknown }).tenant;
    return typeof t === "string" ? t : null;
  } catch {
    return null;
  }
}

interface Recorded {
  method: string;
  path: string;
  search: string;
  body: Record<string, unknown> | undefined;
  tenant: string | null; // the tenant claim minted onto THIS request — the isolation observable
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
      const rec: Recorded = { method: request.method, path: url.pathname, search: url.search, body, tenant: bearerTenant(request) };
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
  error?: { code: number; message: string; data?: { code?: string } };
}
let rpcId = 0;
function mcpRequest(token: string, message: unknown, extraHeaders: Record<string, string> = {}): Request {
  return new Request(`${ISSUER}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...extraHeaders },
    body: JSON.stringify(message),
  });
}
async function runTool(
  token: string,
  toolName: string,
  args: Record<string, unknown>,
  route: (r: Recorded) => Reply,
  extraHeaders: Record<string, string> = {},
): Promise<{ body: RpcBody; calls: Recorded[] }> {
  const { api, calls } = recordingApi(route);
  const apiEnv = { ...env, API: api } as Env;
  const message = { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name: toolName, arguments: args } };
  const res = await dispatch(apiEnv, defaultDispatchDeps(apiEnv), mcpRequest(token, message, extraHeaders));
  return { body: (await res.json()) as RpcBody, calls };
}
function structured(body: RpcBody): Record<string, unknown> {
  return body.result?.structuredContent ?? {};
}
function peekTally(pairingId: string): Promise<{ spend: number; count: number }> {
  const stub = env.CAPS_METER.get(env.CAPS_METER.idFromName(pairingId)) as unknown as { peek(p: string): Promise<{ spend: number; count: number }> };
  return stub.peek(currentPeriod(Date.now()));
}

// A priced quote.priced fact FOR a shipment, served ONLY to that shipment's owning tenant (else an empty lens feed).
const PRICED = { id: "q_iso", kind: "quote.priced", seq: 1, payload: { sell: 50_000, basis: { zone: "Z2", matched_zip_prefix: "800" } } };

beforeAll(async () => {
  await applyControl(env.CONTROL_DB);
  await seedTenant(env.CONTROL_DB, TENANT_A, "tenant-iso-a");
  await seedTenant(env.CONTROL_DB, TENANT_B, "tenant-iso-b");
  const gen = JSON.stringify({ spend: BIG, velocity: BIG });
  const vel1 = JSON.stringify({ spend: BIG, velocity: 1 });
  await seedPairing(env.CONTROL_DB, { id: PAIRING_A1, tenantId: TENANT_A, kind: "mcp", status: "active", scopes: '["mcp"]', caps: gen });
  await seedPairing(env.CONTROL_DB, { id: PAIRING_A2, tenantId: TENANT_A, kind: "mcp", status: "active", scopes: '["mcp"]', caps: gen });
  await seedPairing(env.CONTROL_DB, { id: PAIRING_B1, tenantId: TENANT_B, kind: "mcp", status: "active", scopes: '["mcp"]', caps: gen });
  await seedPairing(env.CONTROL_DB, { id: MTR_A, tenantId: TENANT_A, kind: "mcp", status: "active", scopes: '["mcp"]', caps: vel1 });
  await seedPairing(env.CONTROL_DB, { id: MTR_B, tenantId: TENANT_B, kind: "mcp", status: "active", scopes: '["mcp"]', caps: vel1 });
  const exp = Math.floor(Date.now() / 1000) + 3600;
  for (const p of [PAIRING_A1, PAIRING_A2, PAIRING_B1, MTR_A, MTR_B]) {
    await env.GRANTS.put(`token:${TOK(p)}`, JSON.stringify({ pairingId: p, scope: "mcp", exp }));
  }
});

// ── THE ISOLATION ROOT — the mint is pairing-derived (the "key builder" unit assertion) ───────────────────────
describe("the minted principal's tenant is pairing-derived — the isolation root (REQ-025)", () => {
  it("mintPrincipalJwt embeds the PAIRING's tenant, and two pairings never mint the same tenant (the prefix-regression net)", async () => {
    const a = decode(await mintPrincipalJwt(env, PAIRING_A1)).payload as { tenant?: string; role?: string };
    const b = decode(await mintPrincipalJwt(env, PAIRING_B1)).payload as { tenant?: string; role?: string };
    expect(a.tenant).toBe(TENANT_A);
    expect(b.tenant).toBe(TENANT_B);
    expect(a.tenant).not.toBe(b.tenant); // a mint that dropped/ignored the pairing tenant would collapse these
    // Role is the bounded ops sentinel for BOTH — structurally never finance/admin/driver (REQ-102/105).
    expect(a.role).toBe(MCP_PRINCIPAL_ROLE);
    expect(b.role).toBe(MCP_PRINCIPAL_ROLE);
    expect(MCP_PRINCIPAL_ROLE).toBe("ops");
  });

  it("the api aux worker VERIFIES (not merely decodes) each pairing's tenant at /v1/whoami", async () => {
    // Closes the loop with a REAL HS256 verify + Zod parse inside the api: the pairing-A principal is accepted AS
    // tenant A, the pairing-B principal AS tenant B — the two never resolve to the same tenant.
    const a = (await (await callApi(env, { method: "GET", path: "/v1/whoami", jwt: await mintPrincipalJwt(env, PAIRING_A1) })).json()) as { tenant: string; role: string };
    const b = (await (await callApi(env, { method: "GET", path: "/v1/whoami", jwt: await mintPrincipalJwt(env, PAIRING_B1) })).json()) as { tenant: string; role: string };
    expect(a.tenant).toBe(TENANT_A);
    expect(b.tenant).toBe(TENANT_B);
    expect(a.role).toBe("ops");
  });
});

// ── THE FULL CROSS-TENANT MATRIX — a tenant-A pairing cannot read/write tenant B, per tool ─────────────────────
describe("cross-tenant matrix — a tenant-A pairing reads/writes ONLY tenant A (never tenant B)", () => {
  // Helper: assert EVERY api call this action made carried tenant A on the wire, and NONE carried tenant B.
  function assertWireTenantA(calls: Recorded[]): void {
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.tenant).toBe(TENANT_A);
      expect(c.tenant).not.toBe(TENANT_B);
    }
  }

  it("quote_freight — a pairing's writes are ALL stamped with ITS OWN tenant (A stamps A, B stamps B)", async () => {
    const happy = (): ((r: Recorded) => Reply) => {
      let n = 0;
      return (r) => {
        if (r.method === "POST" && r.path === "/v1/parties") return { status: 201, json: { id: `party_${++n}` } };
        if (r.method === "POST" && r.path === "/v1/shipments") return { status: 201, json: { shipment_id: SHIP_A } };
        if (r.method === "POST" && r.path === "/v1/rate") return { status: 200, json: { status: "PRICED", sell_cents: 50_000, floors: {}, approval: { approval: "none" }, transit: { status: "known", business_days: 2 }, anomaly: null } };
        if (r.method === "GET" && r.path === `/v1/shipments/${SHIP_A}/events`) return { status: 200, json: { events: [PRICED], next_cursor: null } };
        return { status: 500, json: { error: "unexpected" } };
      };
    };
    const priceable = { shipper: { name: "Acme" }, consignee: { name: "Beta" }, origin_zip: "97201", dest_zip: "80012", weight_lb: 1200, dims: { l_in: 48, w_in: 40, h_in: 60, pieces: 2 } };
    const a = await runTool(TOK(PAIRING_A1), "quote_freight", priceable, happy());
    assertWireTenantA(a.calls);
    expect((a.calls.find((c) => c.path === "/v1/shipments")?.body?.refs as Record<string, unknown> | undefined)?.pairing).toBe(PAIRING_A1);

    const b = await runTool(TOK(PAIRING_B1), "quote_freight", priceable, happy());
    for (const c of b.calls) expect(c.tenant).toBe(TENANT_B); // B's writes never carry tenant A
  });

  it("track — a tenant-A pairing GETting tenant-B's shipment reads an EMPTY feed (never B's events)", async () => {
    // The lens: tenant B's shipment returns its events ONLY to a tenant-B principal; a tenant-A read gets empty.
    const lens: (r: Recorded) => Reply = (r) => {
      if (r.path === `/v1/shipments/${SHIP_B}/events`) {
        return { status: 200, json: { events: r.tenant === TENANT_B ? [{ id: "evt-B-SECRET", kind: "stop.arrived" }] : [], next_cursor: null } };
      }
      return { status: 500, json: { error: "unexpected" } };
    };
    const { body, calls } = await runTool(TOK(PAIRING_A1), "track", { shipment_id: SHIP_B }, lens);
    expect(body.result?.isError).toBeFalsy();
    expect(structured(body).events).toEqual([]); // no fabricated cross-tenant event
    expect(JSON.stringify(body)).not.toContain("evt-B-SECRET");
    assertWireTenantA(calls);
  });

  it("track — the SAME shipment IS visible to its OWNING tenant (control: the fake WOULD have leaked on a mint bug)", async () => {
    const lens: (r: Recorded) => Reply = (r) => ({ status: 200, json: { events: r.tenant === TENANT_B ? [{ id: "evt-B-1", kind: "stop.arrived" }] : [], next_cursor: null } });
    const { body } = await runTool(TOK(PAIRING_B1), "track", { shipment_id: SHIP_B }, lens);
    expect((structured(body).events as unknown[]).length).toBe(1); // tenant B sees its own — proves the gate is real
  });

  it("get_document — a tenant-A pairing GETting tenant-B docs/url is fail-closed (404 → isError, no B rows)", async () => {
    const docs: (r: Recorded) => Reply = (r) =>
      r.path === `/v1/shipments/${SHIP_B}/documents`
        ? r.tenant === TENANT_B
          ? { status: 200, json: { documents: [{ id: "doc-B-SECRET" }] } }
          : { status: 404, json: { error: "NOT FOUND" } }
        : { status: 500, json: { error: "unexpected" } };
    const list = await runTool(TOK(PAIRING_A1), "get_document", { shipment_id: SHIP_B }, docs);
    expect(list.body.result?.isError).toBe(true);
    expect(JSON.stringify(list.body)).not.toContain("doc-B-SECRET");
    assertWireTenantA(list.calls);

    const url: (r: Recorded) => Reply = (r) =>
      r.path.startsWith("/v1/documents/") && r.path.endsWith("/url")
        ? r.tenant === TENANT_B
          ? { status: 200, json: { url: "/pub/documents/CAP-B-SECRET", expires_in: 300 } }
          : { status: 404, json: { error: "NOT FOUND" } }
        : { status: 500, json: { error: "unexpected" } };
    const one = await runTool(TOK(PAIRING_A1), "get_document", { shipment_id: SHIP_B, document_id: "evidence:shp_iso_b:ab" }, url);
    expect(one.body.result?.isError).toBe(true);
    expect(JSON.stringify(one.body)).not.toContain("CAP-B-SECRET");
    assertWireTenantA(one.calls);
  });

  it("book_shipment — a tenant-A pairing CANNOT book tenant-B's shipment (caps quote-read fail-closed, no accept-quote)", async () => {
    // The caps events-hop reads the accepted quote FIRST. Tenant A gets an empty lens feed for tenant B's
    // shipment ⇒ the quote.priced is not found ⇒ caps_quote_unresolved (fail-closed), and the accept-quote write
    // is NEVER attempted — no tenant-B row is written.
    const lens: (r: Recorded) => Reply = (r) => {
      if (r.method === "GET" && r.path === `/v1/shipments/${SHIP_B}/events`) {
        return { status: 200, json: { events: r.tenant === TENANT_B ? [PRICED] : [], next_cursor: null } };
      }
      return { status: 201, json: { id: "acc-SHOULD-NOT-HAPPEN" } }; // any accept-quote write would be a LEAK
    };
    const { body, calls } = await runTool(TOK(PAIRING_A1), "book_shipment", { shipment_id: SHIP_B, quote_event_id: "q_iso", confirm: { intent: "book", amount_cents: 50_000 } }, lens);
    expect(body.error?.code).toBe(-32001);
    expect(body.error?.data?.code).toBe("caps_quote_unresolved");
    expect(calls.some((c) => c.method === "POST")).toBe(false); // no write into tenant B
    assertWireTenantA(calls);
    expect(JSON.stringify(body)).not.toContain("SHOULD-NOT-HAPPEN");
  });

  it("approve — a tenant-A pairing's decision on tenant-B's shipment is refused (403 → isError, no B decision)", async () => {
    const gated: (r: Recorded) => Reply = (r) =>
      r.path === `/v1/shipments/${SHIP_B}/approval-decision`
        ? r.tenant === TENANT_B
          ? { status: 201, json: { id: "evt-B-decided" } }
          : { status: 403, json: { error: "NOT IN YOUR SCOPE" } }
        : { status: 500, json: { error: "unexpected" } };
    const { body, calls } = await runTool(TOK(PAIRING_A1), "approve", { shipment_id: SHIP_B, decision: "approved" }, gated);
    expect(body.result?.isError).toBe(true); // surfaced, never a fabricated decision
    expect(JSON.stringify(body)).not.toContain("evt-B-decided");
    assertWireTenantA(calls);
  });

  it("dispute — a tenant-A pairing filing on tenant-B's shipment is refused (403 → isError)", async () => {
    const gated: (r: Recorded) => Reply = (r) =>
      r.path === `/v1/shipments/${SHIP_B}/claim`
        ? r.tenant === TENANT_B
          ? { status: 201, json: { id: "evt-B-claim" } }
          : { status: 403, json: { error: "NOT IN YOUR SCOPE" } }
        : { status: 500, json: { error: "unexpected" } };
    const { body, calls } = await runTool(TOK(PAIRING_A1), "dispute", { shipment_id: SHIP_B, reason: "probe" }, gated);
    expect(body.result?.isError).toBe(true);
    expect(JSON.stringify(body)).not.toContain("evt-B-claim");
    assertWireTenantA(calls);
  });
});

// ── SMUGGLE — a tenant named in the args or a header NEVER re-points the principal ─────────────────────────────
describe("a smuggled tenant (tool arg or HTTP header) never re-points the pairing-derived principal", () => {
  it("an X-Tenant-Id / X-Shuddl-Tenant header naming tenant B is IGNORED — the wire principal is still tenant A", async () => {
    const lens: (r: Recorded) => Reply = (r) => ({ status: 200, json: { events: r.tenant === TENANT_B ? [{ id: "evt-B-SECRET" }] : [], next_cursor: null } });
    const { body, calls } = await runTool(
      TOK(PAIRING_A1),
      "track",
      { shipment_id: SHIP_B },
      lens,
      { "x-tenant-id": TENANT_B, "x-shuddl-tenant": TENANT_B, "x-tenant": TENANT_B },
    );
    // The header did NOT re-key the principal: the wire tenant stayed A ⇒ the lens returned empty ⇒ no B data.
    for (const c of calls) expect(c.tenant).toBe(TENANT_A);
    expect(structured(body).events).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("evt-B-SECRET");
  });

  it("a `tenant` / `tenant_id` field smuggled into the tool args is rejected by the strict schema — it never reaches a read", async () => {
    // Every tool schema is `.strict()`, so a tenant channel simply does not exist in the args: the smuggle is an
    // INVALID_PARAMS before any mint / api round-trip. (And even a non-strict tool would be inert — the mint reads
    // only ctx.pairingId; there is no arg path to `tenant`.)
    let apiHit = 0;
    const spy: (r: Recorded) => Reply = () => {
      apiHit++;
      return { status: 200, json: {} };
    };
    const t = await runTool(TOK(PAIRING_A1), "track", { shipment_id: SHIP_A, tenant: TENANT_B }, spy);
    expect(t.body.error?.code).toBe(-32602); // invalid params — the extra `tenant` key is rejected
    const b = await runTool(TOK(PAIRING_A1), "book_shipment", { shipment_id: SHIP_B, quote_event_id: "q_iso", tenant_id: TENANT_B, confirm: { intent: "book", amount_cents: 50_000 } }, spy);
    expect(b.body.error?.code).toBe(-32602);
    expect(apiHit).toBe(0); // neither smuggle ever reached the api
  });
});

// ── COMPANY POSTURE — intra-tenant cross-pairing is ALLOWED (one carrier = one trust domain), but METERED per pairing
describe("company posture: a tenant is one trust domain — cross-PAIRING within a tenant is allowed but separately metered", () => {
  // V1 DECISION (pinned in code): an `ops` pairing carries the TENANT-WIDE lens, so pairing A2 sees shipments
  // ORIGINATED by pairing A1 — intra-tenant cross-pairing is intentional (a tenant = one carrier). What is NOT
  // shared is the CAPS counter: a booking is charged to the ACTING pairing's own CapsMeter DO (ctx.pairingId),
  // never the shipment's refs.pairing — so pairing A2 cannot spend against pairing A1's budget.
  it("pairing A2 CAN read a shipment ORIGINATED by pairing A1 (same tenant ⇒ same lens)", async () => {
    const lens: (r: Recorded) => Reply = (r) => ({ status: 200, json: { events: r.tenant === TENANT_A ? [{ id: "evt-A1-created", kind: "quote.priced" }] : [], next_cursor: null } });
    const { body } = await runTool(TOK(PAIRING_A2), "track", { shipment_id: SHIP_A }, lens);
    expect((structured(body).events as unknown[]).length).toBe(1); // A2 sees A1's shipment — allowed intra-tenant
  });

  it("a booking by pairing A2 counts against A2's own meter, NEVER pairing A1's (per-actor metering)", async () => {
    const lens: (r: Recorded) => Reply = (r) => {
      if (r.method === "GET" && r.path === `/v1/shipments/${SHIP_A}/events`) return { status: 200, json: { events: [{ ...PRICED, payload: { sell: 7_500, basis: {} } }], next_cursor: null } };
      if (r.method === "POST" && r.path === `/v1/shipments/${SHIP_A}/accept-quote`) return { status: 201, json: { id: "acc-a2" } };
      return { status: 500, json: { error: "unexpected" } };
    };
    const { body } = await runTool(TOK(PAIRING_A2), "book_shipment", { shipment_id: SHIP_A, quote_event_id: "q_iso", confirm: { intent: "book", amount_cents: 7_500 } }, lens);
    expect(structured(body).status).toBe("ACCEPTED");
    expect(await peekTally(PAIRING_A2)).toEqual({ spend: 7_500, count: 1 }); // charged to the ACTING pairing
    expect(await peekTally(PAIRING_A1)).toEqual({ spend: 0, count: 0 }); // A1's budget is untouched by A2's action
  });
});

// ── THE CapsMeter DO IS PER-PAIRING — a tenant-B pairing never reads/increments a tenant-A pairing's counter ────
describe("the CapsMeter DO is keyed idFromName(pairingId) — no cross-tenant counter can collide", () => {
  it("a tenant-A pairing and a tenant-B pairing each meter ONLY their own DO (neither touches the other)", async () => {
    const bookOnce = (pairing: string, ship: string, quote: string): Promise<{ body: RpcBody; calls: Recorded[] }> => {
      const lens: (r: Recorded) => Reply = (r) => {
        if (r.method === "GET" && r.path === `/v1/shipments/${ship}/events`) return { status: 200, json: { events: [{ id: quote, kind: "quote.priced", seq: 1, payload: { sell: 4_200, basis: {} } }], next_cursor: null } };
        if (r.method === "POST" && r.path === `/v1/shipments/${ship}/accept-quote`) return { status: 201, json: { id: `acc-${quote}` } };
        return { status: 500, json: { error: "unexpected" } };
      };
      return runTool(TOK(pairing), "book_shipment", { shipment_id: ship, quote_event_id: quote, confirm: { intent: "book", amount_cents: 4_200 } }, lens);
    };

    const a = await bookOnce(MTR_A, "shp_mtr_a", "q_mtr_a");
    const b = await bookOnce(MTR_B, "shp_mtr_b", "q_mtr_b");
    expect(structured(a.body).status).toBe("ACCEPTED");
    expect(structured(b.body).status).toBe("ACCEPTED");
    expect(await peekTally(MTR_A)).toEqual({ spend: 4_200, count: 1 }); // A's DO
    expect(await peekTally(MTR_B)).toEqual({ spend: 4_200, count: 1 }); // B's DO — a separate instance

    // Each is now at ITS OWN velocity-1 cap. A tenant-A second booking is refused by A's OWN counter — proving the
    // counter is A's alone (B's booking never spent A's slot, and vice versa).
    const aSecond = await bookOnce(MTR_A, "shp_mtr_a2", "q_mtr_a2");
    expect(aSecond.body.error?.data?.code).toBe("velocity_cap_exceeded");
    expect(await peekTally(MTR_B)).toEqual({ spend: 4_200, count: 1 }); // B's DO STILL untouched by A's activity
  });
});

// A tiny structural anchor: the registry is exactly the blessed tool set (no rogue tenant-crossing tool slipped in).
describe("the tool registry is the blessed set (no rogue tool outside the isolation matrix)", () => {
  it("exposes exactly the WP-13 tools + the two proof stubs", () => {
    const names = buildRegistry().list().map((t) => t.name).sort();
    expect(names).toEqual(["approve", "book_shipment", "dispute", "get_document", "noop_mutation", "quote_freight", "track", "whoami"]);
  });
});
