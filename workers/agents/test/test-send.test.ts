import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import type { AgentsEnv } from "../src/tenants.js";

// WP-06 follow-up — the GUARDED, DEV-ONLY evidence live-send probe (REQ-092 wiring proof).
//
// POST /_dev/evidence-test-send composes the REAL evidence email (renderEvidenceEmail) and sends it
// through the REAL sender selection (evidenceSender: ResendSender when RESEND_API_KEY+EVIDENCE_FROM are
// bound, else NotConfiguredSender) to a SINK recipient the operator controls — never a client-supplied
// address. It is a wiring probe, NOT production sending: it proves the live-send path end-to-end
// (a real Resend id in the dashboard) with zero risk of mailing a real consignee.
//
// The gates, IN ORDER, each pinned below:
//   1. FLAG — env.ALLOW_TEST_SEND !== "1" ⇒ 404 (the route is INERT — indistinguishable from
//      not existing — in any normal/prod deploy). Wrong method/path with the flag on ⇒ 404 too.
//   2. TOKEN — flag on but TEST_SEND_TOKEN unset/empty ⇒ 500 (fail-closed: the flag alone must
//      NEVER open an unauthenticated outbound-email route). Missing/≠ bearer ⇒ 401.
//   3. RECIPIENT — operator-controlled ONLY: env.TEST_SEND_TO, else the hardcoded "delivered@resend.dev"
//      sink. A body that supplies `to`/`recipient` is REFUSED loudly (400) — it can NEVER become the
//      recipient. This is the load-bearing safety property.
//   4. SENDER — the EXACT biller env selection (ResendSender vs NotConfiguredSender).
//   5. COMPOSE+SEND — the canned REQ-167-clean fictional sample (SHP-40206), idempotency-keyed by an
//      optional operator `probe_id` (default "manual") so repeated probes don't collapse to one send.
//
// The Resend network is a LOCAL stub (vi.stubGlobal on globalThis.fetch — the ResendSender reads it at
// call time). ZERO real network, ever.

const FROM = "SHUDDL <pod@tenant.example>";
const API_KEY = "re_test_key_SECRET_do_not_leak";
const TOKEN = "op-secret-token-abc123";
const SINK = "delivered@resend.dev";

function mkEnv(over: Partial<AgentsEnv>): AgentsEnv {
  // Spread the real bindings (D1/R2/DO) so the env is well-formed; the test-send path touches none of
  // them, but keeping the shape honest guards against accidental coupling. Base env carries NONE of the
  // probe vars (they are not in wrangler.toml), so an omitted override reads as "unset".
  return { ...(env as AgentsEnv), ...over };
}

async function call(
  e: AgentsEnv,
  opts: { method?: string; path?: string; token?: string; body?: unknown; rawBody?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) headers["Authorization"] = `Bearer ${opts.token}`;
  let body: string | undefined;
  if (opts.rawBody !== undefined) {
    body = opts.rawBody;
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["Content-Type"] = "application/json";
  }
  const req = new Request(`https://agents.internal${opts.path ?? "/_dev/evidence-test-send"}`, {
    method: opts.method ?? "POST",
    headers,
    ...(body !== undefined ? { body } : {}),
  });
  return worker.fetch(req, e, createExecutionContext());
}

interface CapturedCall {
  url: string;
  init: RequestInit;
}

// Stub globalThis.fetch (the ResendSender's default fetch impl). Captures every outbound call so the
// SAFETY property (never the attacker `to`) and the Resend contract can be asserted without a network.
function stubResend(status: number, body: unknown): CapturedCall[] {
  const calls: CapturedCall[] = [];
  vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    calls.push({ url, init: init ?? {} });
    const raw = typeof body === "string";
    return Promise.resolve(
      new Response(raw ? (body as string) : JSON.stringify(body), {
        status,
        headers: { "content-type": raw ? "text/html" : "application/json" },
      }),
    );
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── GATE 1 — the flag makes the route INERT ─────────────────────────────────────────────────────
describe("gate 1 — ALLOW_TEST_SEND flag (route is inert unless exactly '1')", () => {
  it("flag unset → 404 even for the correct POST route (indistinguishable from not existing)", async () => {
    const res = await call(mkEnv({ TEST_SEND_TOKEN: TOKEN }), { token: TOKEN });
    expect(res.status).toBe(404);
  });

  it("flag ≠ '1' (e.g. 'true') → 404", async () => {
    const res = await call(mkEnv({ ALLOW_TEST_SEND: "true", TEST_SEND_TOKEN: TOKEN }), { token: TOKEN });
    expect(res.status).toBe(404);
  });

  it("flag on but WRONG path → 404", async () => {
    const res = await call(mkEnv({ ALLOW_TEST_SEND: "1", TEST_SEND_TOKEN: TOKEN }), { token: TOKEN, path: "/_dev/other" });
    expect(res.status).toBe(404);
  });

  it("flag on but GET (wrong method) on the right path → 404", async () => {
    const res = await call(mkEnv({ ALLOW_TEST_SEND: "1", TEST_SEND_TOKEN: TOKEN }), { token: TOKEN, method: "GET" });
    expect(res.status).toBe(404);
  });
});

// ── GATE 2 — token (fail-closed: the flag alone never opens an unauthenticated send route) ───────
describe("gate 2 — bearer token", () => {
  it("flag on but TEST_SEND_TOKEN unset → 500 misconfigured (fail-closed)", async () => {
    const res = await call(mkEnv({ ALLOW_TEST_SEND: "1" }), { token: TOKEN });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "misconfigured: set TEST_SEND_TOKEN" });
  });

  it("flag on, TEST_SEND_TOKEN empty string → 500 misconfigured (empty is not a token)", async () => {
    const res = await call(mkEnv({ ALLOW_TEST_SEND: "1", TEST_SEND_TOKEN: "" }), { token: TOKEN });
    expect(res.status).toBe(500);
  });

  it("token set but NO bearer header → 401", async () => {
    const res = await call(mkEnv({ ALLOW_TEST_SEND: "1", TEST_SEND_TOKEN: TOKEN }), {});
    expect(res.status).toBe(401);
  });

  it("token set but WRONG bearer → 401", async () => {
    const res = await call(mkEnv({ ALLOW_TEST_SEND: "1", TEST_SEND_TOKEN: TOKEN }), { token: "not-the-token" });
    expect(res.status).toBe(401);
  });
});

// ── GATE 4 — sender selection: NotConfigured (no key) rejects loudly, sends NOTHING ──────────────
describe("gate 4 — NotConfiguredSender when no provider is bound (the 'is the key wired?' probe)", () => {
  it("correct bearer, NO RESEND_API_KEY → actionable not-configured message, and NOTHING is sent", async () => {
    const calls = stubResend(200, { id: "re_should_never_be_called" });
    const res = await call(mkEnv({ ALLOW_TEST_SEND: "1", TEST_SEND_TOKEN: TOKEN }), { token: TOKEN });
    // A clear probe answer, not a crash: 200 with the actionable text.
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; error: string };
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/not configured/i);
    expect(j.error).toContain("REQ-092");
    // The load-bearing part: an unconfigured environment sends NOTHING.
    expect(calls).toHaveLength(0);
  });
});

// ── GATE 3 + 5 — configured send, the Resend contract, and the SAFETY property ───────────────────
describe("gate 5 — configured ResendSender send (REQ-092 wiring proof)", () => {
  const configured = (over: Partial<AgentsEnv> = {}): AgentsEnv =>
    mkEnv({ ALLOW_TEST_SEND: "1", TEST_SEND_TOKEN: TOKEN, RESEND_API_KEY: API_KEY, EVIDENCE_FROM: FROM, ...over });

  it("correct bearer + key bound → 200 with the Resend receipt, sent to the default sink", async () => {
    const calls = stubResend(200, { id: "re_test" });
    const res = await call(configured(), { token: TOKEN });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, provider: "resend", provider_id: "re_test", sent_to: SINK });

    // The Resend POST contract.
    expect(calls).toHaveLength(1);
    const c = calls[0];
    if (c === undefined) throw new Error("expected one captured call");
    expect(c.url).toBe("https://api.resend.com/emails");
    expect(c.init.method).toBe("POST");
    const headers = new Headers(c.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(headers.get("idempotency-key")).toBe("evidence-test-send/manual");

    const body = JSON.parse(String(c.init.body)) as Record<string, unknown>;
    expect(body["to"]).toEqual([SINK]); // the sink, never a client value
    const html = body["html"] as string;
    expect(html.startsWith("<!doctype html>")).toBe(true); // the sender's wrap
    expect(html).toContain('<meta charset="utf-8">'); // the · U+00B7 needs the charset
    expect(html).toContain("Delivered"); // the DELIVERED content
    expect(html).toContain("shuddl.tech"); // the REQ-129 referral surface
  });

  it("SAFETY: a body {to:'attacker@evil.com'} is REFUSED (400) — the attacker address is NEVER the recipient, and NOTHING is sent", async () => {
    const calls = stubResend(200, { id: "re_test" });
    const res = await call(configured(), { token: TOKEN, body: { to: "attacker@evil.com" } });
    expect(res.status).toBe(400);
    // Belt AND suspenders: not only did the response 400, no send happened at all — so there is no
    // outbound request whose `to` could possibly be the attacker value.
    expect(calls).toHaveLength(0);
    // And the attacker value appears nowhere in the response.
    expect(JSON.stringify(await res.json())).not.toContain("attacker@evil.com");
  });

  it("SAFETY: a body {recipient:'attacker@evil.com'} is likewise REFUSED (400), nothing sent", async () => {
    const calls = stubResend(200, { id: "re_test" });
    const res = await call(configured(), { token: TOKEN, body: { recipient: "attacker@evil.com" } });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("TEST_SEND_TO env override → the send goes to the operator's address, not the default sink", async () => {
    const calls = stubResend(200, { id: "re_test" });
    const res = await call(configured({ TEST_SEND_TO: "ops@example.test" }), { token: TOKEN });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, provider: "resend", provider_id: "re_test", sent_to: "ops@example.test" });
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body["to"]).toEqual(["ops@example.test"]);
  });

  it("no TEST_SEND_TO → the hardcoded delivered@resend.dev sink", async () => {
    const calls = stubResend(200, { id: "re_test" });
    await call(configured(), { token: TOKEN });
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body["to"]).toEqual([SINK]);
  });

  it("optional probe_id varies the idempotency key (repeated manual probes don't collapse to one send)", async () => {
    const calls = stubResend(200, { id: "re_test" });
    await call(configured(), { token: TOKEN, body: { probe_id: "run-2" } });
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("idempotency-key")).toBe("evidence-test-send/run-2");
  });

  it("a CRLF probe_id → clean 400 (not an opaque 500), and NOTHING is sent — it rides the Idempotency-Key header", async () => {
    const calls = stubResend(200, { id: "re_test" });
    const res = await call(configured(), { token: TOKEN, body: { probe_id: "run\r\nX-Evil: 1" } });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("a Resend 403 surfaces the error with retriable:false and NEVER leaks the api key", async () => {
    stubResend(403, { statusCode: 403, name: "validation_error", message: "Domain is not verified" });
    const res = await call(configured(), { token: TOKEN });
    const j = (await res.json()) as { ok: boolean; retriable: boolean; status?: number; error: string };
    expect(j.ok).toBe(false);
    expect(j.retriable).toBe(false);
    expect(j.status).toBe(403);
    // The api key must appear NOWHERE in the surfaced error.
    expect(JSON.stringify(j)).not.toContain(API_KEY);
  });
});
