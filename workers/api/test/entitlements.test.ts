import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { EntitlementError } from "@shuddl/contracts";
import { resolveProofToCashEntitlement, assertProofToCashEntitledFor } from "../src/provision.js";
import { ensureSchema } from "./helpers.js";

// REQ-162 (WP-14 Task 9) — the PROOF-TO-CASH SKU entitlement, resolved SERVER-SIDE from the control plane keyed
// off the SERVER slug (never a client field), mirroring Task 8's resolveSparkPlan. Fail-closed / default OFF: a
// non-SKU plan OR an unknown tenant is NOT entitled. Tenant-scoped: the resolver reads the NAMED tenant's OWN
// control row, so one tenant can never inherit another's SKU grant. DARK-adjacent — the gate ships enforcing;
// the granting plan provisions at M-H/R1 (no current tenant is entitled).

const SKU_TENANT = "t9-ptc-sku"; // plan = 'proof_to_cash' → ENTITLED
const NON_SKU_TENANT = "t9-ptc-pilot"; // plan = 'pilot' → NOT entitled (default OFF)
const OTHER_SKU_TENANT = "t9-ptc-other"; // a DISTINCT proof_to_cash row — proves per-row scoping

async function seedTenant(id: string, slug: string, plan: string, policy = "{}"): Promise<void> {
  await env.CONTROL_DB.prepare("INSERT OR IGNORE INTO tenants (id, name, slug, plan, policy, created_ts) VALUES (?,?,?,?,?,?)")
    .bind(id, id, slug, plan, policy, 0)
    .run();
}

beforeAll(async () => {
  await ensureSchema(env); // control plane + tenant-a
  await seedTenant("t-ptc-sku", SKU_TENANT, "proof_to_cash");
  await seedTenant("t-ptc-pilot", NON_SKU_TENANT, "pilot");
  await seedTenant("t-ptc-other", OTHER_SKU_TENANT, "proof_to_cash");
});

describe("PROOF-TO-CASH SKU entitlement — server-side plan-flag (REQ-162)", () => {
  it("a tenant on the SKU plan is ENTITLED (ON → allowed)", async () => {
    expect(await resolveProofToCashEntitlement(env.CONTROL_DB, SKU_TENANT)).toBe(true);
    await expect(assertProofToCashEntitledFor(env.CONTROL_DB, SKU_TENANT)).resolves.toBeUndefined();
  });

  it("a NON-SKU plan (pilot) is NOT entitled (default OFF → the guard refuses)", async () => {
    expect(await resolveProofToCashEntitlement(env.CONTROL_DB, NON_SKU_TENANT)).toBe(false);
    await expect(assertProofToCashEntitledFor(env.CONTROL_DB, NON_SKU_TENANT)).rejects.toBeInstanceOf(EntitlementError);
  });

  it("an UNKNOWN tenant fails CLOSED — no control row → NOT entitled", async () => {
    expect(await resolveProofToCashEntitlement(env.CONTROL_DB, "t9-ptc-does-not-exist")).toBe(false);
    await expect(assertProofToCashEntitledFor(env.CONTROL_DB, "t9-ptc-does-not-exist")).rejects.toBeInstanceOf(EntitlementError);
  });

  it("is TENANT-SCOPED: the entitlement is keyed off the NAMED tenant's OWN row — no cross-tenant inheritance", async () => {
    // The non-SKU tenant stays NOT entitled even though SKU siblings exist; each slug resolves its own row.
    expect(await resolveProofToCashEntitlement(env.CONTROL_DB, NON_SKU_TENANT)).toBe(false);
    expect(await resolveProofToCashEntitlement(env.CONTROL_DB, SKU_TENANT)).toBe(true);
    expect(await resolveProofToCashEntitlement(env.CONTROL_DB, OTHER_SKU_TENANT)).toBe(true);
  });
});
