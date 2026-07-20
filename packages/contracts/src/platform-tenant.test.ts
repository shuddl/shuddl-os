import { describe, expect, it } from "vitest";
import { PLATFORM_TENANT_ID, isPlatformTenant, assertNotPlatformTenant } from "./platform-tenant.js";

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
