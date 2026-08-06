import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ApiError, handleError, reqId } from "../src/middleware/error.js";

// REQ-156 / REQ-192 — THE UNHANDLED-ERROR FALLBACK LEAKS NOTHING (audit §354).
//
// `genesis/14` §04 specifies the envelope `{code, message, req_id, event_ids?}` for every error leaving this
// worker, and `handleError` is wired at `app.onError` so no route can opt out. An `ApiError` becomes its own
// envelope; **anything else becomes a fixed "INTERNAL ERROR"**, with the real `err.message` sent to the log
// and never to the client.
//
// WHY THIS FILE EXISTS. That fallback had NO test. Mutating `envelope(c, "INTERNAL", 500, "INTERNAL ERROR")`
// to return `err.message` — a client-visible leak of whatever an unexpected exception happened to say, which
// in this codebase includes D1 errors, binding names and JWT internals — left all 754 api tests GREEN. The
// code was correct and nothing observed it, which is the §287 shape (a budget nothing counted) applied to a
// security property.
//
// Tested at the handler rather than through a route, deliberately: to reach the unhandled branch end-to-end a
// route would have to throw a non-`ApiError`, which no production route does — so an integration test would
// need a fixture route that exists only to break, and would prove less than calling the function that every
// route's failure actually lands in.

const ctx = (): { app: Hono; get: (p: string) => Promise<Response> } => {
  const app = new Hono();
  app.use("*", reqId);
  app.onError(handleError);
  return { app, get: (p: string) => app.request(p) };
};

describe("REQ-156: every error leaving the worker is the envelope", () => {
  it("an UNEXPECTED throw returns a FIXED message — never the exception's text", async () => {
    const { app, get } = ctx();
    // A plausible internal leak: D1 errors and binding failures phrase themselves exactly like this.
    app.get("/boom", () => {
      throw new Error("D1_ERROR: no such table: events (binding TENANT_A_DB)");
    });
    const res = await get("/boom");
    const body = (await res.json()) as { code: string; message: string; req_id?: string };

    expect(res.status).toBe(500);
    expect(body.code).toBe("INTERNAL");
    expect(body.message).toBe("INTERNAL ERROR");
    // The load-bearing assertions: no fragment of the original error survives into the response.
    expect(body.message).not.toContain("D1_ERROR");
    expect(body.message).not.toContain("TENANT_A_DB");
    expect(JSON.stringify(body)).not.toContain("no such table");
  });

  it("carries req_id, so a leak-free message is still diagnosable from the log", async () => {
    // The reason a fixed message is safe rather than merely opaque: the correlator is in the envelope, and
    // `logEvent("error.unhandled", …)` carries the real text under the same id.
    const { app, get } = ctx();
    app.get("/boom", () => {
      throw new Error("secret-bearing detail");
    });
    const body = (await (await get("/boom")).json()) as { req_id?: string };
    expect(typeof body.req_id).toBe("string");
    expect((body.req_id ?? "").length).toBeGreaterThan(8);
  });

  it("an ApiError keeps its OWN code and message — the fallback is only for the unexpected", async () => {
    // Negative control: without this, a handler that flattened every error to "INTERNAL ERROR" would pass
    // the assertions above while destroying every gate refusal a client needs to act on.
    const { app, get } = ctx();
    app.get("/gated", () => {
      throw new ApiError("GATE_BLOCKED", 409, "POD REQUIRED");
    });
    const res = await get("/gated");
    const body = (await res.json()) as { code: string; message: string };
    expect(res.status).toBe(409);
    expect(body.code).toBe("GATE_BLOCKED");
    expect(body.message).toBe("POD REQUIRED");
  });
});
