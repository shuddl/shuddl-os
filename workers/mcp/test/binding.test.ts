import { env } from "cloudflare:test";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { callApi } from "../src/index.js";

// WP-13 Task 1 (REQ-101) — proves the api SERVICE-BINDING reuse seam.
//
// vitest.config.ts loads the REAL compiled api worker as the `shuddl-api-dev` auxiliary, so `env.API` (the
// mcp worker's `[[services]]` binding) dispatches IN-PROCESS to the actual api Hono app — its auth +
// idempotency middleware and every /v1 gate. GET /v1/whoami is the ideal target: it needs a valid JWT (auth
// runs) but no seeded data (it just echoes the session claims), so it returns 200 for any valid token and
// 401 without one — a clean read of "did the api's auth middleware run for a call the mcp worker forwarded?".

// Mirrors workers/api/test/helpers.ts `token()`: an HS256 JWT the api's auth middleware verifies against
// JWT_SECRET. vitest.config.ts injects the SAME secret into the api auxiliary, so a token signed here verifies
// there. Standard SessionClaims shape (sub/tenant/role/exp) — @shuddl/contracts SessionClaims.
const API_TEST_SECRET = "test-secret-do-not-use-in-prod";
function mintSessionJwt(claims: { sub: string; tenant: string; role: string }): Promise<string> {
  return sign({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims }, API_TEST_SECRET);
}

describe("api service-binding reuse seam (callApi -> env.API)", () => {
  it("runs the api worker's auth middleware IN-PROCESS: a valid JWT reaches /v1/whoami (200)", async () => {
    const jwt = await mintSessionJwt({ sub: "u-mcp", tenant: "tenant-a", role: "admin" });

    const res = await callApi(env, { method: "GET", path: "/v1/whoami", jwt });

    expect(res.status).toBe(200);
    // whoami echoes the verified session claims — proof the api decoded the token, not the mcp worker.
    const body = (await res.json()) as { sub: string; tenant: string; role: string };
    expect(body).toMatchObject({ sub: "u-mcp", tenant: "tenant-a", role: "admin" });
  });

  it("the api's auth middleware — NOT the mcp worker — gates the call: no JWT is 401", async () => {
    // callApi enforces nothing itself; the 401 can only come from the bound api worker's auth middleware.
    const res = await callApi(env, { method: "GET", path: "/v1/whoami" });

    expect(res.status).toBe(401);
  });

  it("a garbage bearer token is rejected by the api (401), never silently accepted by the seam", async () => {
    const res = await callApi(env, { method: "GET", path: "/v1/whoami", jwt: "not-a-real-jwt" });

    expect(res.status).toBe(401);
  });
});
