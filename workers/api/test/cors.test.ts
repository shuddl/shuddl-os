import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CORS_ALLOWED_ORIGINS } from "../src/middleware/cors.js";

// REQ-025 / REQ-189 (WP-09 Task 5) — the Portal + public status page are a SEPARATE browser ORIGIN from this
// API, so cross-origin reads need CORS. The middleware must: allow a SCOPED, named allowlist (never `*`);
// echo the matched origin; answer the OPTIONS preflight with a 204 (it used to 404 via notFound); and give a
// denied origin NO Access-Control-Allow-Origin header at all. Every case drives the REAL worker via SELF.

const ALLOWED = "https://portal.example"; // in CORS_ALLOWED_ORIGINS
const DENIED = "https://not-allowed.example"; // NOT in the allowlist

describe("CORS allowlist fixture (source parity)", () => {
  it("the allowed fixture is in the shipped allowlist, the denied one is not, and there is no wildcard", () => {
    expect(CORS_ALLOWED_ORIGINS.includes(ALLOWED)).toBe(true);
    expect(CORS_ALLOWED_ORIGINS.includes(DENIED)).toBe(false);
    expect(CORS_ALLOWED_ORIGINS).not.toContain("*"); // the allowlist is never a wildcard
  });
});

describe("OPTIONS preflight", () => {
  it("from an ALLOWED origin -> 204 echoing that origin + the method/header allowlist", async () => {
    const res = await SELF.fetch("https://api.local/v1/shipments/x/events", {
      method: "OPTIONS",
      headers: {
        Origin: ALLOWED,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type,idempotency-key",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED); // echoed, not `*`
    const methods = res.headers.get("Access-Control-Allow-Methods") ?? "";
    for (const m of ["GET", "POST", "OPTIONS"]) expect(methods).toContain(m);
    const allowHeaders = (res.headers.get("Access-Control-Allow-Headers") ?? "").toLowerCase();
    for (const h of ["authorization", "content-type", "idempotency-key"]) expect(allowHeaders).toContain(h);
    expect(res.headers.get("Vary") ?? "").toContain("Origin");
  });

  it("from a DENIED origin -> NO Access-Control-Allow-Origin header (the browser blocks the call)", async () => {
    const res = await SELF.fetch("https://api.local/v1/shipments/x/events", {
      method: "OPTIONS",
      headers: { Origin: DENIED, "Access-Control-Request-Method": "POST" },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("the preflight is answered BEFORE auth — a browser sends it with NO bearer token, and it is not a 401", async () => {
    const res = await SELF.fetch("https://api.local/v1/shipments/x/events", {
      method: "OPTIONS",
      headers: { Origin: ALLOWED, "Access-Control-Request-Method": "POST" },
    });
    expect(res.status).toBe(204); // used to be a 404 via notFound; now cors short-circuits before auth
  });
});

describe("actual (non-preflight) responses", () => {
  it("a GET from an allowed origin carries ACAO echoing it + Vary: Origin, never `*`", async () => {
    const res = await SELF.fetch("https://api.local/v1/health", { headers: { Origin: ALLOWED } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED);
    expect(res.headers.get("Access-Control-Allow-Origin")).not.toBe("*"); // `*` + credentials would be a leak
    expect(res.headers.get("Vary") ?? "").toContain("Origin");
  });

  it("a GET from a DENIED origin gets NO ACAO header (the read is CORS-blocked in the browser)", async () => {
    const res = await SELF.fetch("https://api.local/v1/health", { headers: { Origin: DENIED } });
    expect(res.status).toBe(200); // the server still answers; the BROWSER is what withholds a denied origin
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("the /pub surface is covered too — a /pub response to an allowed origin carries ACAO", async () => {
    // even the uniform 401 for a bad cap carries ACAO, proving the middleware wraps /pub/*, not just /v1/*.
    const res = await SELF.fetch("https://api.local/pub/status/not-a-real-cap", { headers: { Origin: ALLOWED } });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED);
  });
});

// 2026-08-01 audit (config-deploy): the served allowlist was env-agnostic — two localhost dev origins and
// the two .example placeholders compiled into EVERY deploy including prod, and the deploy-preflight's
// origin checks read only the operator state file, so no gate observed what prod actually served. The
// served list is now ENV-AWARE: prod serves exactly the real deploy origins; dev/staging keep the full
// development list (the harness fixtures still assert against it).
describe("prod serves ONLY the real deploy origins (2026-08-01)", () => {
  it("effectiveOrigins('prod') is exactly the four real surfaces — no localhost, no .example, no wildcard", async () => {
    const { effectiveOrigins } = await import("../src/middleware/cors.js");
    const prod = effectiveOrigins("prod");
    expect([...prod].sort()).toEqual([
      "https://command.shuddl.tech",
      "https://driver.shuddl.tech",
      "https://portal.shuddl.tech",
      "https://track.shuddl.tech",
    ]);
    expect(prod.some((o) => o.includes("localhost") || o.includes(".example"))).toBe(false);
  });

  it("non-prod keeps the full development list (fixtures + local Vite origins)", async () => {
    const { effectiveOrigins } = await import("../src/middleware/cors.js");
    expect(effectiveOrigins("dev")).toEqual(CORS_ALLOWED_ORIGINS);
    expect(effectiveOrigins("staging")).toEqual(CORS_ALLOWED_ORIGINS);
  });

  it("UNKNOWN fails CLOSED: an unset, typo'd, or unrecognized ENVIRONMENT serves the prod list, never the dev one", async () => {
    // The review caught the first cut restricting only the literal "prod" — a scope that lost its [vars]
    // would have served localhost from production. The dev list is now allowlisted, not the prod one.
    const { effectiveOrigins } = await import("../src/middleware/cors.js");
    expect(effectiveOrigins("")).toEqual(effectiveOrigins("prod"));
    expect(effectiveOrigins("production")).toEqual(effectiveOrigins("prod"));
    expect(effectiveOrigins("").some((o) => o.includes("localhost") || o.includes(".example"))).toBe(false);
  });
});
