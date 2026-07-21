import { describe, expect, it } from "vitest";
import {
  hazmatEnabled,
  proofToCashEnabled,
  assertHazmatEnabled,
  assertProofToCashEntitled,
  EntitlementError,
  HAZMAT_ENABLED_POLICY_KEY,
  PROOF_TO_CASH_PLAN,
  type TenantEntitlementRow,
} from "./entitlements.js";

// REQ-060/162 (WP-14 Task 9) — PURE unit tests for the two control-plane entitlement levers over
// tenants.plan / tenants.policy. Both fail CLOSED (default OFF): an absent/malformed signal grants NOTHING.
// The helpers are pure functions of the passed control-plane row, so an entitlement is scoped to ITS OWN row
// — one tenant can never inherit another's (proved by evaluating distinct rows independently).

const row = (plan: string, policy: string): TenantEntitlementRow => ({ plan, policy });

// ── HAZMAT (REQ-060) — a per-tenant policy.hazmat_enabled flag ────────────────────────────────────────
describe("hazmatEnabled — a per-tenant tenants.policy workspace flag (REQ-060)", () => {
  it("policy.hazmat_enabled === true → ON", () => {
    expect(hazmatEnabled(row("pilot", '{"hazmat_enabled":true}'))).toBe(true);
  });
  it("an EMPTY policy (default) → OFF (fail-closed)", () => {
    expect(hazmatEnabled(row("pilot", "{}"))).toBe(false);
  });
  it("policy.hazmat_enabled === false → OFF", () => {
    expect(hazmatEnabled(row("pilot", '{"hazmat_enabled":false}'))).toBe(false);
  });
  it("the key ABSENT (other policy concerns present) → OFF", () => {
    expect(hazmatEnabled(row("pilot", '{"gates":{"dims_required":true}}'))).toBe(false);
  });
  it("a NON-boolean value (string \"true\", 1) does NOT grant → OFF (only a literal boolean true)", () => {
    expect(hazmatEnabled(row("pilot", '{"hazmat_enabled":"true"}'))).toBe(false);
    expect(hazmatEnabled(row("pilot", '{"hazmat_enabled":1}'))).toBe(false);
  });
  it("MALFORMED / non-object policy JSON → OFF (fail-closed floor)", () => {
    expect(hazmatEnabled(row("pilot", "not json"))).toBe(false);
    expect(hazmatEnabled(row("pilot", "[1,2,3]"))).toBe(false);
    expect(hazmatEnabled(row("pilot", "null"))).toBe(false);
  });
  it("the flag lives in POLICY, never PLAN: a proof_to_cash plan with an empty policy is hazmat-OFF", () => {
    expect(hazmatEnabled(row(PROOF_TO_CASH_PLAN, "{}"))).toBe(false);
  });
  it("the constant names the wire key (shared with the sequencer read)", () => {
    expect(HAZMAT_ENABLED_POLICY_KEY).toBe("hazmat_enabled");
    expect(hazmatEnabled(row("pilot", JSON.stringify({ [HAZMAT_ENABLED_POLICY_KEY]: true })))).toBe(true);
  });
});

// ── PROOF-TO-CASH SKU (REQ-162) — a tenants.plan plan-flag ────────────────────────────────────────────
describe("proofToCashEnabled — a tenants.plan plan-flag (REQ-162)", () => {
  it("plan === the SKU slug → ENTITLED", () => {
    expect(proofToCashEnabled(row(PROOF_TO_CASH_PLAN, "{}"))).toBe(true);
  });
  it("a NON-SKU customer plan (pilot) → NOT entitled (default OFF)", () => {
    expect(proofToCashEnabled(row("pilot", "{}"))).toBe(false);
  });
  it("an EMPTY / reserved plan → NOT entitled (fail-closed)", () => {
    expect(proofToCashEnabled(row("", "{}"))).toBe(false);
    expect(proofToCashEnabled(row("unclaimed", "{}"))).toBe(false);
    expect(proofToCashEnabled(row("platform", "{}"))).toBe(false);
  });
  it("the SKU is a PLAN flag, never grantable via a policy field (a spoofed policy cannot lift it)", () => {
    expect(proofToCashEnabled(row("pilot", '{"proof_to_cash":true,"hazmat_enabled":true}'))).toBe(false);
  });
});

// ── Fail-closed guards ────────────────────────────────────────────────────────────────────────────────
describe("assert* guards throw a typed EntitlementError when OFF, pass when ON", () => {
  it("assertHazmatEnabled: OFF → throws 'hazmat_not_enabled'; ON → passes", () => {
    try {
      assertHazmatEnabled(row("pilot", "{}"));
      throw new Error("expected assertHazmatEnabled to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(EntitlementError);
      expect((e as EntitlementError).code).toBe("hazmat_not_enabled");
    }
    expect(() => assertHazmatEnabled(row("pilot", '{"hazmat_enabled":true}'))).not.toThrow();
  });
  it("assertProofToCashEntitled: OFF → throws 'proof_to_cash_not_entitled'; ON → passes", () => {
    try {
      assertProofToCashEntitled(row("pilot", "{}"));
      throw new Error("expected assertProofToCashEntitled to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(EntitlementError);
      expect((e as EntitlementError).code).toBe("proof_to_cash_not_entitled");
    }
    expect(() => assertProofToCashEntitled(row(PROOF_TO_CASH_PLAN, "{}"))).not.toThrow();
  });
});

// ── Tenant scoping: each helper is a pure fn of the PASSED row — no cross-row inheritance ──────────────
describe("entitlements are tenant-scoped — a row governs only itself (REQ-025 discipline)", () => {
  it("a hazmat-ON tenant and a hazmat-OFF tenant evaluate INDEPENDENTLY", () => {
    const enabled = row("pilot", '{"hazmat_enabled":true}');
    const disabled = row("pilot", "{}");
    expect(hazmatEnabled(enabled)).toBe(true);
    expect(hazmatEnabled(disabled)).toBe(false); // the enabled sibling does NOT leak in
  });
  it("a SKU tenant and a non-SKU tenant evaluate INDEPENDENTLY", () => {
    expect(proofToCashEnabled(row(PROOF_TO_CASH_PLAN, "{}"))).toBe(true);
    expect(proofToCashEnabled(row("pilot", "{}"))).toBe(false);
  });
  it("the two levers are ORTHOGONAL: hazmat (policy) and proof-to-cash (plan) never grant each other", () => {
    // A hazmat-enabled pilot tenant is NOT SKU-entitled; a SKU tenant with empty policy is NOT hazmat-enabled.
    expect(proofToCashEnabled(row("pilot", '{"hazmat_enabled":true}'))).toBe(false);
    expect(hazmatEnabled(row(PROOF_TO_CASH_PLAN, "{}"))).toBe(false);
  });
});
