import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiBase, get, post } from "./api.js";
import { clear, setToken } from "../session.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Pull the plain-object headers off the Nth fetch call (the client passes headers as a Record).
function headersOf(mock: ReturnType<typeof vi.fn>, call: number): Record<string, string> {
  const init = mock.mock.calls[call]?.[1] as RequestInit | undefined;
  return (init?.headers ?? {}) as Record<string, string>;
}

describe("command api client (REQ-081)", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("targets the base URL from VITE_API_BASE", async () => {
    vi.stubEnv("VITE_API_BASE", "https://api.stub.example");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await get("/v1/approvals?status=open");

    expect(apiBase()).toBe("https://api.stub.example");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.stub.example/v1/approvals?status=open");
  });

  it("defaults to a synthetic (non-real) base with no trailing slash when VITE_API_BASE is unset", () => {
    expect(apiBase()).toMatch(/\.example$/); // reserved TLD — never a real customer domain (REQ-167)
    expect(apiBase().endsWith("/")).toBe(false);
  });

  it("a POST attaches a FRESH Idempotency-Key and the bearer token, and JSON-encodes the body", async () => {
    setToken("header.payload.sig");
    // A FRESH Response per call — a Response body can only be read once, so two POSTs need two bodies.
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ id: "x" }, 201)));
    vi.stubGlobal("fetch", fetchMock);

    await post("/v1/copilot/ask", { q: "A" });
    await post("/v1/copilot/ask", { q: "B" });

    const h1 = headersOf(fetchMock, 0);
    const h2 = headersOf(fetchMock, 1);
    expect(h1["authorization"]).toBe("Bearer header.payload.sig");
    expect(h1["idempotency-key"]).toBeTruthy();
    expect(h1["content-type"]).toBe("application/json");
    // FRESH per request — a replay-safe key is never reused across POSTs.
    expect(h1["idempotency-key"]).not.toBe(h2["idempotency-key"]);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ q: "A" }));
  });

  it("a GET works with NO token (no Authorization, no Idempotency-Key) — keeps the token-less shape", async () => {
    clear();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ approvals: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await get<{ approvals: unknown[] }>("/v1/approvals?status=open");

    expect(out.approvals).toEqual([]);
    const h = headersOf(fetchMock, 0);
    expect(h["authorization"]).toBeUndefined();
    expect(h["idempotency-key"]).toBeUndefined();
  });

  it("a 401 surfaces a distinguishable re-auth signal carrying the envelope code + req_id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ code: "UNAUTHORIZED", message: "NO SESSION", req_id: "r1" }, 401));
    vi.stubGlobal("fetch", fetchMock);

    const err = await get("/v1/exceptions").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(401);
    expect(apiErr.code).toBe("UNAUTHORIZED");
    expect(apiErr.isAuthError).toBe(true); // the command shell drops the session + re-prompts for a magic link
    expect(apiErr.reqId).toBe("r1");
  });

  it("a non-401 error still throws a typed ApiError with the code, isAuthError false", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ code: "VALIDATION_FAILED", message: "BAD", req_id: "r2" }, 422));
    vi.stubGlobal("fetch", fetchMock);

    const err = await post("/v1/copilot/ask", {}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("VALIDATION_FAILED");
    expect((err as ApiError).isAuthError).toBe(false);
  });

  it("a non-envelope error body still throws a typed ApiError (BAD_RESPONSE)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("<html>502</html>", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);

    const err = await get("/v1/approvals").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("BAD_RESPONSE");
    expect((err as ApiError).status).toBe(502);
  });
});
