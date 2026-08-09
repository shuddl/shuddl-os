import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ErrorEnvelope } from "@shuddl/contracts";
import { ensureSchema, seedShipment, token } from "./helpers.js";

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

  it("the cached response EXPIRES — the record is written with a TTL, not forever (§789)", async () => {
    // Deleting `{ expirationTtl: 60 * 60 * 24 }` from the KV put left this suite 6/6 GREEN. Two consequences,
    // both permanent because nothing ever removes the record:
    //   · every successful mutation leaks one KV entry, for the life of the namespace;
    //   · the replay window becomes unbounded — a key reused much later replays a stale response instead of
    //     executing, and `next()` never runs.
    // The 2xx-only rule beside it is well pinned (3 tests red when it is relaxed); the TTL was the half of
    // this middleware nothing watched.
    //
    // Asserted through KV's own `expiration` metadata rather than by advancing a clock: the property that
    // matters is that the record CARRIES an expiry at all, and a bare `put` reports `expiration: undefined`.
    // The bound is deliberately loose — this pins "it expires, on a sane horizon", not the exact constant,
    // so retuning the window stays a one-line product decision rather than a test edit.
    const before = Math.floor(Date.now() / 1000);
    const res = await post("key-ttl-789", { n: 7 });
    expect(res.status).toBe(200);

    const listed = await env.IDEMPOTENCY.list();
    expect(listed.keys.length, "no idempotency record was written — the probe missed its own subject").toBeGreaterThan(0);
    for (const k of listed.keys) {
      expect(k.expiration, `idempotency record ${k.name} has NO expiry — it will outlive the namespace`).toBeTypeOf("number");
      // > 1 hour out (so a truncated TTL is caught) and <= 7 days (so "forever-ish" is caught).
      expect(k.expiration!).toBeGreaterThan(before + 3_600);
      expect(k.expiration!).toBeLessThanOrEqual(before + 7 * 24 * 3_600);
    }
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

// Task 9 (REQ-170 / REQ-206) — THE EVIDENCE-ORDER 4xx MUST NOT BE CACHED. A driver replaying offline captures
// can upload evidence BEFORE its recording event lands → the route 422s (hash_not_recorded). That 4xx carries no
// committed state and MUST be retryable: caching it would replay the stale failure forever and silently lose the
// evidence the corrected retry (once the event lands) intends to store — the exact offline-replay evidence loss
// the fix guards. This pins the not-memoized property on the /v1/evidence route specifically.
describe("Task 9 — a retryable evidence-order 4xx is not cached (REQ-170/206)", () => {
  beforeAll(async () => {
    await ensureSchema(env);
    await seedShipment("idem-t9-evidence");
  });

  it("a same-key evidence upload that 422s (hash_not_recorded) RE-RUNS on retry — the 4xx is never memoized", async () => {
    const shp = "idem-t9-evidence";
    const hash = "a".repeat(64); // a well-formed 64-hex NEVER recorded on the stream → 422 hash_not_recorded
    const t = await token({ sub: "u-idem-t9", tenant: "tenant-a", role: "ops" });
    const url = `https://api.local/v1/evidence?shipment_id=${shp}&photo_hash=${hash}`;
    const headers = { Authorization: `Bearer ${t}`, "Idempotency-Key": "idem-t9-evidence-key", "content-type": "application/octet-stream" };

    const first = await SELF.fetch(url, { method: "POST", headers, body: new Uint8Array([1, 2, 3]) });
    expect(first.status).toBe(422);
    expect(first.headers.get("idempotency-replay")).toBeNull();

    // Same key, same request — the 422 must RE-RUN, never replay a cached failure (an offline-order retry, once
    // the recording event lands, has to reach the handler and store the bytes).
    const second = await SELF.fetch(url, { method: "POST", headers, body: new Uint8Array([1, 2, 3]) });
    expect(second.status).toBe(422);
    expect(second.headers.get("idempotency-replay"), "a 4xx evidence-order failure is never memoized").toBeNull();
  });
});
