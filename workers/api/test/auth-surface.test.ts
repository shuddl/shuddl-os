import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/index.js";

// REQ-025/030/156 — THE AUTHENTICATION SURFACE (audit §57).
//
// `app.use("/v1/*", auth)` is a real chokepoint: a new /v1 route cannot forget it. But the protection is NOT
// the prefix, it is REGISTRATION ORDER — Hono runs matching handlers in the order they were registered, so a
// route registered ABOVE that line answers before auth ever runs. `GET /v1/health` does exactly that today,
// deliberately (REQ-111/114 probe target), and it returns 200 with no token. A guard written as "starts with
// /v1 ⇒ authenticated" would therefore be FALSE, and would go on being false for the next route someone adds
// above line 96.
//
// So these assert the mechanism, not the prefix:
//   1. nothing is registered above the auth middleware except an allowlisted probe,
//   2. every path outside /v1/* belongs to a namespace with its own stated gate, and
//   3. the middleware is actually registered — without which 1 and 2 prove nothing.

type Route = { method: string; path: string; handler: { name?: string } };
const routes = (): Route[] => (app as unknown as { routes: Route[] }).routes;

/** Route handlers permitted to answer BEFORE auth runs, each with the reason it may. */
const UNAUTHENTICATED_BY_DESIGN = new Map<string, string>([
  ["GET /v1/health", "REQ-111/114 uptime probe — returns {ok, env} only, no tenant data, no ledger read."],
]);

/** Namespaces outside /v1/* that carry their OWN authorization, each named. */
const SELF_GATED_NAMESPACES = new Map<string, string>([
  ["/pub/", "public by design: /pub/quote + /pub/signup are the stranger-facing funnel; /pub/status/:cap and /pub/documents/:cap are unguessable CAP TOKENS scoped to one shipment."],
  ["/internal/", "server-to-server platform-credit seam behind the fail-closed PLATFORM_INTERNAL_SECRET (DARK by default) — reachable over the service binding, never by a customer JWT."],
]);

describe("REQ-025/156: the authentication surface has no accidental holes", () => {
  it("the /v1/* auth middleware is registered — the premise every other case rests on", () => {
    expect(routes().some((r) => r.path === "/v1/*" && r.handler?.name === "auth")).toBe(true);
  });

  it("NOTHING answers before auth except the allowlisted probe (this is registration order, not prefix)", () => {
    const all = routes();
    const authIdx = all.findIndex((r) => r.path === "/v1/*" && r.handler?.name === "auth");
    const before = all
      .slice(0, authIdx)
      .filter((r) => r.path !== "/*") // app.use("*") middleware (reqId, cors) — not route handlers
      .map((r) => `${r.method} ${r.path}`);
    for (const r of before) {
      expect(UNAUTHENTICATED_BY_DESIGN.has(r), `${r} answers BEFORE auth — it is unauthenticated. Register it below app.use("/v1/*", auth), or allowlist it here with the reason it is safe.`).toBe(true);
    }
  });

  it("every mounted path is either /v1/* or in a self-gated namespace", () => {
    const paths = [...new Set(routes().map((r) => r.path))].filter((p) => p !== "/*");
    for (const p of paths) {
      const ok = p.startsWith("/v1/") || [...SELF_GATED_NAMESPACES.keys()].some((ns) => p.startsWith(ns));
      expect(ok, `${p} is mounted outside /v1/* and outside every self-gated namespace — it has NO authorization at all`).toBe(true);
    }
  });

  it("the allowlists carry a real reason, not a bare path", () => {
    for (const why of [...UNAUTHENTICATED_BY_DESIGN.values(), ...SELF_GATED_NAMESPACES.values()]) {
      expect(why.length).toBeGreaterThan(40);
    }
  });

  // The behavioural half: the claims above are about wiring, these are about what the server actually answers.
  it("BEHAVIOUR: an authenticated /v1 route 401s without a token, while the allowlisted probe answers 200", async () => {
    expect((await app.fetch(new Request("https://api.test/v1/whoami"), env)).status).toBe(401);
    expect((await app.fetch(new Request("https://api.test/v1/health"), env)).status).toBe(200);
  });

  it("BEHAVIOUR: a client-supplied tenant is REJECTED outright, not ignored (REQ-156)", async () => {
    const res = await app.fetch(new Request("https://api.test/v1/whoami", { headers: { "X-Tenant-Id": "tenant-b" } }), env);
    expect(res.status).toBe(403);
  });
});
