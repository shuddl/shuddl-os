import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { tenantDb, TENANT_SLUGS } from "../src/tenants.js";
import type { AgentsEnv } from "../src/tenants.js";

// REQ-025 / CLAUDE.md rule 8 — THE AGENTS WORKER'S TENANT RESOLUTION IS TENANT-CORRECT (audit §324).
//
// Isolation in this repo is D1-per-tenant: the guarantee is not a WHERE clause, it is WHICH HANDLE you are
// given. Each worker declares its OWN `tenantDb` over its OWN `TENANT_BINDINGS` allowlist — four independent
// resolvers, not one shared chokepoint (audit §320's correction, itself corrected in §324).
//
// WHY THIS FILE EXISTS. Mutating this worker's resolver to return a FIXED database for every slug — the total
// cross-tenant leak — left all 110 agents tests GREEN. The same mutation in `workers/billing` and
// `workers/translator` went RED immediately. The difference is not that agents never resolves a tenant: its
// tests call `tenantDb()` exactly as often as billing's. It is that the agents suite seeds and reads tenant-b
// through the RAW binding (`env.TENANT_B_DB`), so nothing it asserts depends on the resolver being right.
//
// The agents worker is where the protocol runs — the Biller, the Concierge, the sweeps. A resolver regression
// here means an agent processing tenant-b's shipment appends to tenant-a's ledger, which is the exact failure
// CLAUDE.md rule 8 calls a build failure. The code is correct; this makes a regression in it observable.

describe("REQ-025: the agents worker resolves each tenant to ITS OWN database", () => {
  it("distinct slugs resolve to DISTINCT handles (a fixed-binding resolver fails here)", () => {
    const a = tenantDb(env as unknown as AgentsEnv, "tenant-a");
    const b = tenantDb(env as unknown as AgentsEnv, "tenant-b");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // Identity, not equality: two slugs must not share one D1 handle. This is the assertion the suite lacked —
    // every other agents test reaches tenant-b through `env.TENANT_B_DB` directly, which cannot observe it.
    expect(a).not.toBe(b);
  });

  it("every declared slug resolves, and no two share a handle (non-vacuity + completeness)", () => {
    // Without the length guard an empty TENANT_SLUGS would make the loop below assert nothing — the shape
    // this audit rejects repeatedly (a check that passes on an empty set certifies nothing).
    expect(TENANT_SLUGS.length).toBeGreaterThan(1);
    const handles = TENANT_SLUGS.map((s) => tenantDb(env as unknown as AgentsEnv, s));
    expect(handles.every((h) => h !== undefined)).toBe(true);
    expect(new Set(handles).size, "two tenant slugs resolved to the SAME D1 handle — a cross-tenant leak").toBe(handles.length);
  });

  it("an unknown slug is REFUSED, never silently defaulted", () => {
    // The dangerous failure is not a throw, it is a fallback: a resolver that returns SOME database for an
    // unrecognised slug hands the caller another tenant's ledger. Fail-closed is the invariant.
    expect(() => tenantDb(env as unknown as AgentsEnv, "tenant-does-not-exist")).toThrow(/UNKNOWN_TENANT/);
  });
});
