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



  it("a MALFORMED policy row refuses as UNKNOWN_TENANT rather than throwing a SyntaxError", async () => {
    await env.CONTROL_DB
      .prepare("INSERT OR IGNORE INTO tenants (id, name, slug, plan, policy, created_ts) VALUES (?,?,?,?,?,0)")
      .bind("ct-bad-json", "ct-bad-json", "ct-bad-json", "pilot", "{not json")
      .run();
    await expect(resolveTenantDb(env, "ct-bad-json")).rejects.toThrow(/UNKNOWN_TENANT/);
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

  it("pool-binding exclusivity fails CLOSED — two claimed rows naming ONE binding exclude BOTH slugs with a loud log (REQ-025)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // ct-acme already claims TENANT_POOL_01_DB (beforeAll); this second row makes the binding ambiguous.
    // isolatedStorage rolls this seed back after the test, so the duplicate never leaks into siblings.
    await seedControlTenant(env.CONTROL_DB, { id: "ct-dup-1", slug: "ct-dup", plan: "pilot", policy: JSON.stringify({ pool_binding: "TENANT_POOL_01_DB" }) });
    const claimed = await claimedTenantSlugs(env);
    expect(claimed).not.toContain("ct-acme");
    expect(claimed).not.toContain("ct-dup");
    expect(claimed).toContain("ct-beta"); // the unambiguous binding is unaffected
    expect(spy.mock.calls.some((c) => String(c[0]).includes("exclusivity VIOLATED"))).toBe(true);
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
  it("NO src module iterates bare TENANT_SLUGS — every fan-out goes through allTenantSlugs (the review caught the ninth fan-out hiding in watchtower-snapshot.ts, which an index.ts-only pin could never see)", async () => {
    // The call must stay a LITERAL import.meta.glob — Vite transforms it statically (aliasing broke at
    // runtime); the type lives in raw.d.ts. Dynamic discovery is the point: a NEW module cannot escape.
    const modules = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default" });
    let fanouts = 0;
    for (const [path, load] of Object.entries(modules)) {
      const src = (await load()) as string;
      // ALLOWLIST, not a method blacklist (2026-08-02 §15). The enumerated-method matcher was proved to
      // miss five real fan-out shapes — [...TENANT_SLUGS], an alias variable, Array.from(), an index loop,
      // and TENANT_SLUGS.filter(...).map(...): one .filter() between the identifier and .map() defeated the
      // alternation, which is the literal Promise.all sweep the widening claimed to close. Enumerating the
      // legal forms is a losing game, so invert it: the roster identifier may appear ONLY in tenants.ts
      // (which defines it and builds allTenantSlugs from it) and on import/export lines. Every other
      // occurrence under src/** is flagged — which is the rule this test title has always claimed.
      const isRosterHome = /(^|\/)tenants\.ts$/.test(path);
      if (!isRosterHome) {
        const offenders = src
          .split("\n")
          .map((line, i) => ({ line, n: i + 1 }))
          .filter(({ line }) => /\bTENANT_SLUGS\b/.test(line))
          // Exempt only GENUINE import/export statements of the identifier — not any line that happens to
          // start with `export`. The first cut of this rule exempted `export const c = () =>
          // Array.from(TENANT_SLUGS)`, so a probe carrying all five missed fan-out shapes passed 11/11.
          .filter(({ line }) => !/^\s*import\b[^;]*\bfrom\b/.test(line))
          .filter(({ line }) => !/^\s*export\s*(?:\{[^}]*\}|\*)/.test(line))
          .filter(({ line }) => !/^\s*export\s+(?:declare\s+)?(?:const|let|var|type)\s+TENANT_SLUGS\b/.test(line))
          .filter(({ line }) => !/^\s*(?:\/\/|\*)/.test(line));
        expect(
          offenders.map((o) => `${path}:${o.n}`),
          `${path} references TENANT_SLUGS outside tenants.ts — fan out over allTenantSlugs instead`,
        ).toEqual([]);
      }
      // §14: the claimed-tenant predicate is SHARED from @shuddl/contracts. A raw copy here is the
      // seven-literals drift this pin exists to prevent — a new reserved plan would reach only one worker.
      expect(src.includes("plan NOT IN"), `${path} inlines the claimed-tenant predicate instead of importing CLAIMED_TENANT_* from @shuddl/contracts`).toBe(false);
      fanouts += (src.match(/allTenantSlugs\(/g) ?? []).length;
    }
    expect(fanouts).toBeGreaterThanOrEqual(9);
    expect(indexSrc.match(/of TENANT_SLUGS\b/g)).toBeNull();
  });

  it("the agents POOL_BINDINGS allowlist mirrors the api's (same parity law as the slug roster)", async () => {
    const apiProvision = (await import("../../api/src/provision.ts?raw")).default as string;
    const apiPools = [...apiProvision.matchAll(/"(TENANT_POOL_[0-9]+_DB)"/g)].map((m) => m[1]).sort();
    expect([...new Set(apiPools)]).toEqual([...POOL_BINDINGS].sort());
  });
});
