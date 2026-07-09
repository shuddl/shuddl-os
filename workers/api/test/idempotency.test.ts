import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ErrorEnvelope } from "@shuddl/contracts";
import { token } from "./helpers.js";

// REQ-156 / REQ-106 generalized: Idempotency-Key required on all mutations; replays return the original result.
describe("idempotency", () => {
  async function post(key?: string, body = { n: 1 }, tenant = "tenant-a") {
    const t = await token({ sub: "u1", tenant, role: "ops" });
    return SELF.fetch("https://api.local/v1/_echo", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${t}`,
        "content-type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  it("rejects a mutation without the header", async () => {
    const res = await post(undefined);
    expect(res.status).toBe(400);
    expect(ErrorEnvelope.parse(await res.json()).code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("replay returns the original result, not a re-execution", async () => {
    const first = await post("key-1", { n: 1 });
    expect(first.status).toBe(200);
    const firstBody = await first.text();
    const replay = await post("key-1", { n: 999 }); // different body, same key
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(firstBody);
    expect(replay.headers.get("idempotency-replay")).toBe("true");
  });

  it("keys are tenant-scoped — tenant-b with the same key executes fresh", async () => {
    await post("key-2", { n: 1 }, "tenant-a");
    const other = await post("key-2", { n: 2 }, "tenant-b");
    expect(other.headers.get("idempotency-replay")).toBeNull();
    expect(await other.text()).toContain('"n":2');
  });
});
