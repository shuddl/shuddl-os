import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ErrorEnvelope } from "@shuddl/contracts";
import { token } from "./helpers.js";

describe("REQ-111/114: health", () => {
  it("GET /v1/health is public and reports env", async () => {
    const res = await SELF.fetch("https://api.local/v1/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; env: string };
    expect(body.ok).toBe(true);
    expect(body.env).toBe("dev");
  });
});

describe("REQ-156: every error is the envelope", () => {
  it("authenticated 404 returns {code, message, req_id}", async () => {
    const t = await token({ sub: "u1", tenant: "tenant-a", role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/nope", { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status).toBe(404);
    const parsed = ErrorEnvelope.parse(await res.json());
    expect(parsed.code).toBe("NOT_FOUND");
    expect(parsed.req_id.length).toBeGreaterThan(0);
  });
  it("unauthenticated unknown path is 401, not 404 — route existence is not revealed", async () => {
    const res = await SELF.fetch("https://api.local/v1/nope");
    expect(res.status).toBe(401);
    expect(ErrorEnvelope.parse(await res.json()).code).toBe("UNAUTHORIZED");
  });
});
