import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ErrorEnvelope } from "@shuddl/contracts";
import { token } from "./helpers.js";

// REQ-156 / REQ-106 generalized: Idempotency-Key required on all mutations; replays return the original result.
describe("idempotency", () => {
  async function post(key?: string, body: unknown = { n: 1 }, tenant = "tenant-a") {
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

  // H-5 (REQ-206): only a 2xx success is cached. A FAILED (4xx precondition) request carries no
  // committed state to protect, so it MUST be retryable — a same-key retry after a 4xx has to
  // RE-RUN the handler. Caching the 4xx would replay the stale failure forever and silently lose
  // the write the corrected retry intended (Driver-PWA offline-replay evidence loss).
  it("does NOT cache a 4xx — a corrected same-key retry RE-RUNS the handler and succeeds", async () => {
    const bad = await post("key-4xx", { n: "not-a-number" }); // VALIDATION_FAILED → 400
    expect(bad.status).toBe(400);
    expect(bad.headers.get("idempotency-replay")).toBeNull();
    // Same key, now a valid body: if the 400 had been cached this would replay the 400 and next()
    // would never run. It must re-execute and commit fresh.
    const retry = await post("key-4xx", { n: 7 });
    expect(retry.status).toBe(200);
    expect(retry.headers.get("idempotency-replay")).toBeNull();
    expect(await retry.text()).toContain('"n":7');
  });

  it("a repeated 4xx keeps re-running (the failure is never memoized)", async () => {
    const first = await post("key-4xx-b", { n: "x" });
    expect(first.status).toBe(400);
    const second = await post("key-4xx-b", { n: "y" });
    expect(second.status).toBe(400);
    expect(second.headers.get("idempotency-replay")).toBeNull(); // re-ran, not replayed
  });
});
