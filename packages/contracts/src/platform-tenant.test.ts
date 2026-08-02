import { describe, expect, it } from "vitest";
import { PLATFORM_TENANT_ID, isPlatformTenant, assertNotPlatformTenant, RESERVED_TENANT_PLANS, UNCLAIMED_TENANT_PLAN, PLATFORM_TENANT_PLAN, CLAIMED_TENANT_PLAN_SQL, CLAIMED_TENANT_BY_SLUG_SQL, CLAIMED_TENANTS_SQL } from "./platform-tenant.js";

// REQ-123/025 (WP-14 Task 1): the reserved PLATFORM revenue tenant + its two-way isolation lock.
// These tests PIN the sentinel value + the guards. If PLATFORM_TENANT_ID ever changes, or a guard
// stops fail-closing, this fails — the constant is a well-known id the whole billing plane keys off.
describe("platform tenant sentinel (REQ-123/025)", () => {
  it("PLATFORM_TENANT_ID is the reserved, DNS-illegal, underscore-prefixed sentinel", () => {
    // A leading underscore can NEVER be a customer slug: a customer slug is a DNS-hostname label (it routes
    // the public /pub surface via HOST_TENANTS and names the physical D1 `shuddl-t-{slug}-{env}`), and a
    // hostname label may not begin with "_". So the sentinel lives OUTSIDE the customer slug space by shape.
    expect(PLATFORM_TENANT_ID).toBe("_platform");
    expect(PLATFORM_TENANT_ID.startsWith("_")).toBe(true);
    // A DNS label is [a-z0-9] with internal hyphens; the sentinel is not a legal one.
    expect(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(PLATFORM_TENANT_ID)).toBe(false);
  });

  it("isPlatformTenant is true ONLY for the sentinel", () => {
    expect(isPlatformTenant(PLATFORM_TENANT_ID)).toBe(true);
    expect(isPlatformTenant("_platform")).toBe(true);
    // No customer slug collides.
    for (const customer of ["tenant-a", "tenant-b", "platform", "_platform ", "PLATFORM", "sys", ""]) {
      expect(isPlatformTenant(customer)).toBe(false);
    }
  });

  it("assertNotPlatformTenant fail-closed rejects the platform id, passes a customer slug", () => {
    expect(() => assertNotPlatformTenant(PLATFORM_TENANT_ID)).toThrow(/PLATFORM_TENANT_FORBIDDEN/);
    expect(() => assertNotPlatformTenant("_platform")).toThrow();
    // A real customer slug is accepted (no throw).
    expect(() => assertNotPlatformTenant("tenant-a")).not.toThrow();
    expect(() => assertNotPlatformTenant("tenant-b")).not.toThrow();
  });
});

// ---- The reserved plans + the shared claimed-tenant SQL (2026-08-02 audit §14, REQ-121/123/025) -------
//
// These pin the exact BYTES the four workers now share. The predicate was written seven times as a raw
// string across api/agents/translator/billing with no parity pin — a new reserved plan added to one
// worker's literal would have left billing metering a suspended tenant and the translator still
// transmitting its EDI. If a reserved plan is added, THESE tests fail first and name the decision.
describe("reserved tenant plans + the shared claimed-tenant predicate", () => {
  it("the reserved plans are exactly the two non-customer row kinds", () => {
    expect(RESERVED_TENANT_PLANS).toEqual(["unclaimed", "platform"]);
    expect(UNCLAIMED_TENANT_PLAN).toBe("unclaimed");
    expect(PLATFORM_TENANT_PLAN).toBe("platform");
  });

  it("the SQL fragment is DERIVED from the array, so the two cannot disagree", () => {
    expect(CLAIMED_TENANT_PLAN_SQL).toBe("plan NOT IN ('unclaimed','platform')");
    for (const plan of RESERVED_TENANT_PLANS) {
      expect(CLAIMED_TENANT_PLAN_SQL).toContain(`'${plan}'`);
    }
  });

  it("both shared queries embed the predicate; only `slug` is ever a bound parameter", () => {
    expect(CLAIMED_TENANT_BY_SLUG_SQL).toBe(
      "SELECT policy FROM tenants WHERE slug = ? AND plan NOT IN ('unclaimed','platform')",
    );
    expect(CLAIMED_TENANTS_SQL).toBe("SELECT slug, policy FROM tenants WHERE plan NOT IN ('unclaimed','platform')");
    // Exactly ONE placeholder in the by-slug form, none in the enumeration form — a second `?` would mean
    // something else became parameterised, which is the shape this constant exists to prevent.
    expect((CLAIMED_TENANT_BY_SLUG_SQL.match(/\?/g) ?? []).length).toBe(1);
    expect(CLAIMED_TENANTS_SQL).not.toContain("?");
  });
});
