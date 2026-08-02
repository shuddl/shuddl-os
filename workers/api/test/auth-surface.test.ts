import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/index.js";
import { token } from "./helpers.js";

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

// REQ-106/156 — THE IDEMPOTENCY SURFACE (audit §59).
//
// `app.use("/v1/*", idempotency)` REQUIRES an Idempotency-Key on every mutation and 400s without one. Like
// auth, it is mounted by prefix — so the six mutating routes OUTSIDE /v1/* are not covered by it. Each is
// nonetheless idempotent, by a mechanism suited to what it does; the four mechanisms were read from source
// and are named below. That is the point: "idempotency keys on all mutations" is satisfied here by FOUR
// different designs, only one of which is the middleware, so a reader who assumes the middleware covers
// everything would be wrong, and a seventh route added to these namespaces would inherit nothing.
const DEDUPED_WITHOUT_THE_MIDDLEWARE = new Map<string, string>([
  ["POST /pub/quote", "appends NOTHING — zero-append by construction (the module imports no sequencer/DO/append surface), so a retry merely re-prices."],
  ["POST /pub/signup", "structural: the workspace slug and email are UNIQUE, so a duplicate signup is a 409, never a second tenant."],
  ["POST /internal/platform/credit-append", "the event id is content-derived, so a redelivery re-derives the SAME id and the sequencer dedupes it (once-out)."],
  ["POST /internal/platform/credit-settle", "a no-op once paid: it flips issued→paid only while a covering payment.received is committed and the total is uncovered."],
]);

describe("REQ-106: every mutation is deduplicated, by the middleware or by a named mechanism", () => {
  it("the /v1/* idempotency middleware is registered", () => {
    expect(routes().some((r) => r.path === "/v1/*" && r.handler?.name === "idempotency")).toBe(true);
  });

  it("every mutating route outside /v1/* names how it deduplicates", () => {
    const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
    const outside = routes()
      .filter((r) => MUTATING.has(r.method) && !r.path.startsWith("/v1/") && r.path !== "/*")
      .map((r) => `${r.method} ${r.path}`);
    for (const r of new Set(outside)) {
      expect(DEDUPED_WITHOUT_THE_MIDDLEWARE.has(r), `${r} mutates outside /v1/*, so the idempotency middleware does NOT run for it. Either mount it under /v1/*, or record here HOW it deduplicates a retry.`).toBe(true);
    }
  });

  it("the recorded mechanisms are reasons, not restatements", () => {
    for (const why of DEDUPED_WITHOUT_THE_MIDDLEWARE.values()) expect(why.length).toBeGreaterThan(60);
  });

  it("BEHAVIOUR: an AUTHENTICATED /v1 mutation without an Idempotency-Key is refused 400", async () => {
    // Deliberately authenticated. The first draft of this case accepted [400, 401], which passes on the 401
    // a token-less request already gets — it would have proved nothing about idempotency at all (the exact
    // "asserts the one branch where the property cannot fail" shape audit §51 measured).
    const t = await token({ sub: "u1", tenant: "tenant-a", role: "ops" });
    const res = await app.fetch(
      new Request("https://api.test/v1/shipments", {
        method: "POST",
        headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
        body: "{}",
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("IDEMPOTENCY");
  });
});
