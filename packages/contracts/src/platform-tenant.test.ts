import { describe, expect, it } from "vitest";
import { PLATFORM_TENANT_ID, isPlatformTenant, assertNotPlatformTenant, RESERVED_TENANT_PLANS, UNCLAIMED_TENANT_PLAN, PLATFORM_TENANT_PLAN, CLAIMED_TENANT_PLAN_SQL, CLAIMED_TENANT_BY_SLUG_SQL, CLAIMED_TENANTS_SQL, parseTenantPolicy } from "./platform-tenant.js";

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

// ---- parseTenantPolicy — the SHARED "may this tenant append?" predicate (2026-08-02 §19) --------------
// One predicate, two callers: the sequencer (which refuses the append) and the EDI translator's preflight
// (which must reach the SAME verdict before it writes anything, or the append's 500 becomes a partner
// retry-storm against a deterministic condition). Two copies would let them disagree about a security
// refusal, which is the drift §14 closed for the reserved plans.
describe("parseTenantPolicy — usable vs not", () => {
  it("a well-formed policy parses, including tenant-specific keys this package does not enumerate", () => {
    expect(parseTenantPolicy("{}")).toEqual({});
    expect(parseTenantPolicy('{"gates":{"dims_required":true}}')).toEqual({ gates: { dims_required: true } });
    expect(parseTenantPolicy('{"hazmat_enabled":true,"pool_binding":"TENANT_POOL_01_DB"}')).toEqual({
      hazmat_enabled: true,
      pool_binding: "TENANT_POOL_01_DB",
    });
  });

  it("unparseable, absent, and non-OBJECT policies are all unusable", () => {
    for (const bad of ["{not json", "", "null", "7", '"a string"', "[1,2]"]) {
      expect(parseTenantPolicy(bad), `${bad} must be unusable`).toBeNull();
    }
    expect(parseTenantPolicy(null)).toBeNull();
    expect(parseTenantPolicy(undefined)).toBeNull();
  });

  it("a MIS-KEYED policy is unusable — the likelier ops error, and the one an object check alone accepts", () => {
    // Each of these parses AND is an object, so a null+typeof guard admits it — and then every gate reader
    // sees `undefined` and takes the permissive branch, which is exactly the `{}` widening. A truncated
    // paste rarely parses; a mis-keyed one always does.
    expect(parseTenantPolicy('{"gates":[1,2]}'), "gates as an array reads dims_required=false").toBeNull();
    expect(parseTenantPolicy('{"gates":"strict"}'), "gates as a string reads dims_required=false").toBeNull();
    expect(parseTenantPolicy('{"gates":{"dims_required":"true"}}'), "the STRING 'true' is not true").toBeNull();
    expect(parseTenantPolicy('{"gates":{"geofence_radius_m":"50"}}'), "a string radius falls to the 150m default").toBeNull();
    expect(parseTenantPolicy('{"visibility":"internal"}'), "visibility must be a per-kind map, not a scalar").toBeNull();
  });

  it("NULL is ABSENT, not a refusal — the §27 outage (a YAML key with no value serialises to null)", () => {
    // .optional() admits undefined and REJECTS null, so these were all refused — and a refusal means the
    // sequencer declines EVERY append for the tenant and the EDI preflight quarantines every tender. Tenant
    // #0's policy is generated from a config pack OUTSIDE this repo, where an empty YAML key is exactly null.
    // Every consumer already treats null as absent (?. and ??), so it can harm nothing.
    for (const pol of [
      '{"gates":null}',
      '{"visibility":null}',
      '{"gates":{"dims_required":null}}',
      '{"gates":{"geofence_radius_m":null}}',
      '{"gates":{"invoice_without_pod_classes":null}}',
      // the cruellest one: a correctly-set knob taken down by a SIBLING being null
      '{"gates":{"dims_required":true,"geofence_radius_m":null}}',
    ]) {
      expect(parseTenantPolicy(pol), pol + " must be ACCEPTED — null means unset").not.toBeNull();
    }
  });

  it("a visibility TYPO is refused HERE, not thrown as a raw ZodError deep in the sequencer (§27)", () => {
    // The first cut typed only the KEY (z.record(z.string(), z.string())), so any string value passed this
    // predicate AND the translator preflight — then LedgerEvent.parse threw a raw ZodError inside the
    // sequencer: a 500, not a named refusal, which is the VAN retry-storm §19 exists to prevent, reached
    // through the same corrupt-policy vector and with the projection orphans intact.
    for (const bad of ["publc", "Internal", "privte", "COUNTERPARTY", ""]) {
      expect(
        parseTenantPolicy(JSON.stringify({ visibility: { "freight.photographed": bad } })),
        bad + " is not a Visibility rank",
      ).toBeNull();
    }
    for (const good of ["internal", "counterparty", "public"]) {
      expect(parseTenantPolicy(JSON.stringify({ visibility: { "freight.photographed": good } }))).not.toBeNull();
    }
  });

  it("a `{\"gate\":{…}}` TYPO is NOT caught — passthrough is deliberate, and this records the limit", () => {
    // Honest boundary: the schema passes through unknown keys because a tenant policy legitimately carries
    // keys this package must not enumerate. So a misspelled `gate` survives as an unknown key and the real
    // `gates` is simply absent — indistinguishable, here, from a tenant that set no gates at all. Catching
    // it needs a closed schema, which would refuse every tenant-specific key. Recorded, not pretended away.
    expect(parseTenantPolicy('{"gate":{"dims_required":true}}')).toEqual({ gate: { dims_required: true } });
  });
});
