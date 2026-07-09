import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ErrorEnvelope } from "@shuddl/contracts";
import { token } from "./helpers.js";

describe("REQ-132/133: authn", () => {
  it("rejects missing token", async () => {
    const res = await SELF.fetch("https://api.local/v1/whoami");
    expect(res.status).toBe(401);
    expect(ErrorEnvelope.parse(await res.json()).code).toBe("UNAUTHORIZED");
  });
  it("rejects a token signed with the wrong secret", async () => {
    const t = await token({ sub: "u1", tenant: "tenant-a", role: "ops" }, "attacker-secret");
    const res = await SELF.fetch("https://api.local/v1/whoami", { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status).toBe(401);
  });
  it("rejects claims that fail the schema (unknown role)", async () => {
    const t = await token({ sub: "u1", tenant: "tenant-a", role: "superuser" });
    const res = await SELF.fetch("https://api.local/v1/whoami", { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status).toBe(401);
  });
  it("returns the session for a valid token", async () => {
    const t = await token({ sub: "u1", tenant: "tenant-a", role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/whoami", { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sub: string; tenant: string; role: string };
    expect(body).toMatchObject({ sub: "u1", tenant: "tenant-a", role: "ops" });
  });
});

describe("REQ-132: role matrix", () => {
  it.each(["driver", "portal", "read"])("role %s cannot hit an ops-gated route", async (role) => {
    const t = await token({ sub: "u1", tenant: "tenant-a", role });
    const res = await SELF.fetch("https://api.local/v1/_probe", { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status).toBe(403);
    expect(ErrorEnvelope.parse(await res.json()).code).toBe("FORBIDDEN");
  });
});
