import { createExecutionContext, env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi, afterEach } from "vitest";
import worker from "../src/index.js";
import { resolveTenantDb, allTenantSlugs, claimedTenantSlugs, tenantDb, TENANT_SLUGS, POOL_BINDINGS } from "../src/tenants.js";
import type { AgentsEnv } from "../src/tenants.js";
import { applyControl, seedControlTenant } from "./helpers.js";
import indexSrc from "../src/index.ts?raw";

// 2026-08-01 audit C3, the resolver half (the retry-toward-DLQ hardening landed first): the agents worker
// could not serve CLAIMED POOL tenants — the api worker + sequencer DO resolve them, so their committed
// events enqueue triggers this worker could only park, and every cron sweep enumerated the static roster
// only. This suite pins the claimed-aware resolver (the mirror of workers/api resolveClaimedTenantDb, same
// fail-closed contract: control row with plan NOT IN unclaimed/platform, policy.pool_binding constrained to
// the static POOL_BINDINGS allowlist) and the shared cron enumerator. Pre-R4 line item on the GO-LIVE
// ledger: this must hold BEFORE any PROVISIONING_ENABLED flip (REQ-121/123/025/169).

beforeAll(async () => {
  await applyControl(env.CONTROL_DB);
  // Seed HERE, not in the its: isolatedStorage rolls back per-test writes, so only beforeAll persists.
  await seedControlTenant(env.CONTROL_DB, { id: "ct-claimed-1", slug: "ct-acme", plan: "pilot", policy: JSON.stringify({ pool_binding: "TENANT_POOL_01_DB" }) });
  await seedControlTenant(env.CONTROL_DB, { id: "ct-claimed-2", slug: "ct-beta", plan: "spark", policy: JSON.stringify({ pool_binding: "TENANT_POOL_02_DB" }) });
  await seedControlTenant(env.CONTROL_DB, { id: "ct-sent-1", slug: "_pool_09", plan: "unclaimed", policy: JSON.stringify({ pool_binding: "TENANT_POOL_02_DB" }) });
  await seedControlTenant(env.CONTROL_DB, { id: "ct-bad-1", slug: "ct-bad", plan: "pilot", policy: JSON.stringify({ pool_binding: "CONTROL_DB" }) });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveTenantDb — static hot path, claimed fallback, fail-closed misses (REQ-025)", () => {
  it("a static slug resolves to its binding with no control-plane read", async () => {
    expect(await resolveTenantDb(env, "tenant-a")).toBe(env.TENANT_A_DB);
    expect(await resolveTenantDb(env, "tenant-b")).toBe(env.TENANT_B_DB);
  });

  it("a CLAIMED pool tenant resolves to the pool binding its control row names", async () => {
    expect(await resolveTenantDb(env, "ct-acme")).toBe(env.TENANT_POOL_01_DB);
  });

  it("an UNCLAIMED pool sentinel throws — a sentinel row is not a tenant", async () => {
    await expect(resolveTenantDb(env, "_pool_09")).rejects.toThrow(/UNKNOWN_TENANT/);
  });

  it("a claimed row whose pool_binding is OUTSIDE the static allowlist throws — no arbitrary-handle path", async () => {
    await expect(resolveTenantDb(env, "ct-bad")).rejects.toThrow(/UNKNOWN_TENANT/);
  });

  it("an unknown slug and the platform tenant both throw", async () => {
    await expect(resolveTenantDb(env, "ct-nobody")).rejects.toThrow(/UNKNOWN_TENANT/);
    await expect(resolveTenantDb(env, "_platform")).rejects.toThrow(/UNKNOWN_TENANT/);
  });

  it("the sync static resolver is unchanged (anchor-cron hot path)", () => {
    expect(tenantDb(env, "tenant-a")).toBe(env.TENANT_A_DB);
    expect(() => tenantDb(env, "ct-acme")).toThrow(/UNKNOWN_TENANT/);
  });
});

describe("claimedTenantSlugs / allTenantSlugs — the cron enumeration (REQ-169/025)", () => {
  it("claimed slugs with a valid pool_binding enumerate; unclaimed, platform, and invalid-binding rows do not", async () => {
    const claimed = await claimedTenantSlugs(env);
    expect(claimed).toContain("ct-beta");
    expect(claimed).not.toContain("_pool_09"); // unclaimed sentinel
    expect(claimed).not.toContain("ct-bad"); // invalid pool_binding
    expect(claimed).not.toContain("tenant-a"); // static roster is not re-enumerated here
  });

  it("allTenantSlugs = static roster first, then claimed, deduped", async () => {
    const all = await allTenantSlugs(env);
    expect(all.slice(0, TENANT_SLUGS.length)).toEqual([...TENANT_SLUGS]);
    expect(all).toContain("ct-beta");
    expect(new Set(all).size).toBe(all.length);
  });

  it("a control-plane fault yields the STATIC roster with a loud log — anchoring must never be hostage to enumeration", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { ...env, CONTROL_DB: { prepare: () => { throw new Error("D1_DOWN"); } } } as unknown as AgentsEnv;
    const all = await allTenantSlugs(broken);
    expect(all).toEqual([...TENANT_SLUGS]);
    expect(spy.mock.calls.some((c) => String(c[0]).includes("claimed-tenant enumeration failed"))).toBe(true);
  });
});

describe("queue() dispatch — a claimed tenant's trigger is ROUTED, never roster-parked (REQ-169)", () => {
  function mkMessage(body: unknown): { message: Message; state: { acked: boolean; retried: boolean } } {
    const state = { acked: false, retried: false };
    const message = {
      id: crypto.randomUUID(),
      timestamp: new Date(0),
      body,
      attempts: 1,
      ack: (): void => { state.acked = true; },
      retry: (): void => { state.retried = true; },
    } as unknown as Message;
    return { message, state };
  }
  function mkBatch(messages: Message[]): MessageBatch {
    return { queue: "shuddl-agent-triggers-dev", messages, ackAll: () => { throw new Error("per-message only"); }, retryAll: () => { throw new Error("per-message only"); } } as unknown as MessageBatch;
  }

  it("a claimed tenant's pod.signed reaches the handler (unmigrated pool D1 throws → retry) WITHOUT the roster log", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { message, state } = mkMessage({ kind: "pod.signed", tenant: "ct-acme", shipment_id: "shp-ct-1", event_id: "evt-ct-1" });
    await worker.queue(mkBatch([message]), env, createExecutionContext());
    expect(state.retried).toBe(true); // the handler's first D1 read throws (pool D1 unmigrated in this harness)
    expect(state.acked).toBe(false);
    const rosterLogged = spy.mock.calls.some((c) => String(c[0]).includes("outside this worker's"));
    expect(rosterLogged).toBe(false); // resolution SUCCEEDED — the retry came from the handler, not the roster branch
  });

  it("an unrostered, unclaimed tenant still retries toward the DLQ WITH the roster log (iteration-1 posture unchanged)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { message, state } = mkMessage({ kind: "pod.signed", tenant: "ct-nobody", shipment_id: "shp-ct-2", event_id: "evt-ct-2" });
    await worker.queue(mkBatch([message]), env, createExecutionContext());
    expect(state.retried).toBe(true);
    expect(state.acked).toBe(false);
    expect(spy.mock.calls.some((c) => String(c[0]).includes("outside this worker's"))).toBe(true);
  });
});

describe("source-level pins — no sweep may regress to the static roster (REQ-169)", () => {
  it("index.ts iterates NO bare TENANT_SLUGS — every fan-out goes through allTenantSlugs", () => {
    expect(indexSrc.match(/of TENANT_SLUGS\b/g)).toBeNull();
    expect((indexSrc.match(/allTenantSlugs\(/g) ?? []).length).toBeGreaterThanOrEqual(8);
  });

  it("the agents POOL_BINDINGS allowlist mirrors the api's (same parity law as the slug roster)", async () => {
    const apiProvision = (await import("../../api/src/provision.ts?raw")).default as string;
    const apiPools = [...apiProvision.matchAll(/"(TENANT_POOL_[0-9]+_DB)"/g)].map((m) => m[1]).sort();
    expect([...new Set(apiPools)]).toEqual([...POOL_BINDINGS].sort());
  });
});
