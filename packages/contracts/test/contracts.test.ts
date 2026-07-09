import { describe, expect, it } from "vitest";
import { ErrorEnvelope, ErrorCode, Role, SessionClaims } from "../src/index.js";

describe("REQ-156: error envelope", () => {
  it("accepts a gate refusal carrying its evidence requirement", () => {
    const parsed = ErrorEnvelope.parse({
      code: "GATE_BLOCKED",
      message: "DELIVERY REQUIRES SIGNATURE + PLACED-FREIGHT PHOTO",
      req_id: "req_123",
      event_ids: ["evt_1"],
      gate: { required_evidence: ["pod.signed", "delivery.evidenced"] },
    });
    expect(parsed.code).toBe("GATE_BLOCKED");
  });
  it("rejects unknown codes — codes are stable strings", () => {
    expect(() => ErrorCode.parse("SOMETHING_NEW")).toThrow();
  });
});

describe("REQ-132: role model (doc 10 users.role)", () => {
  it("accepts exactly the six roles", () => {
    for (const r of ["admin", "ops", "finance", "read", "driver", "portal"]) {
      expect(Role.parse(r)).toBe(r);
    }
    expect(() => Role.parse("superuser")).toThrow();
  });
});

describe("session claims", () => {
  it("requires sub, tenant, role, exp", () => {
    expect(() => SessionClaims.parse({ sub: "u1", tenant: "tenant-a" })).toThrow();
    const ok = SessionClaims.parse({ sub: "u1", tenant: "tenant-a", role: "ops", exp: 2000000000 });
    expect(ok.tenant).toBe("tenant-a");
  });
});
