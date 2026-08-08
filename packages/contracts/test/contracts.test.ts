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

  // REQ-132 §662 — an EMPTY `sub` is not a `sub`.
  //
  // The schema writes `sub: z.string().min(1)` and the comment beside it says why: the value "is recorded
  // permanently as the co-sign actor on server-emitted control events (WP-15 authority.flipped actor.user) —
  // an empty co-sign would be an unattributable audit record."
  //
  // MEASURED (§662): dropping `.min(1)` left packages/contracts at 291/291 AND workers/api at 798/798. The
  // test above passes an ABSENT sub, which Zod rejects on the type check before `.min(1)` is ever consulted,
  // so it never reached the constraint. Absent and empty are different inputs to a required string, and only
  // one of them was tested.
  it("rejects an EMPTY sub — an unattributable co-sign is not a session", () => {
    expect(() => SessionClaims.parse({ sub: "", tenant: "tenant-a", role: "ops", exp: 2000000000 })).toThrow();
  });
});
