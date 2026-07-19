import { describe, it, expect } from "vitest";
import { DEFAULT_004010, resolveMapping, applyMapping, dialectStatus } from "../src/mapping.js";
import type { TenderDoc } from "../src/types.js";

describe("mapping (per-partner config layer)", () => {
  it("returns the default for an empty config", () => {
    expect(resolveMapping({})).toEqual(DEFAULT_004010);
  });

  it("merges a status-dialect override over the default", () => {
    const m = resolveMapping({ statusDialect: { arrived: "AA" } });
    expect(dialectStatus("arrived", m)).toBe("AA"); // overridden
    expect(dialectStatus("departed", m)).toBe("AF"); // default preserved
    expect(dialectStatus("nope", m)).toBe("nope"); // unknown code passes through
    expect(m.version).toBe("004010"); // untouched keys fall back to default
  });

  it("rejects an unknown config field (.strict())", () => {
    expect(() => resolveMapping({ bogus: true })).toThrow();
  });

  it("applyMapping remaps ref qualifiers to canonical names, keeping unknown refs", () => {
    const tender: TenderDoc = {
      partnerScac: "MEGA",
      purpose: "00",
      refs: { BM: "BOL987", XYZ: "keepme" },
      stops: [],
    };
    const out = applyMapping(tender, DEFAULT_004010);
    expect(out.refs).toEqual({ bol: "BOL987", XYZ: "keepme" });
    // non-refs fields are carried through unchanged
    expect(out.partnerScac).toBe("MEGA");
    expect(out.purpose).toBe("00");
  });

  it("dialectStatus returns the default AT7 code for a known canonical status", () => {
    expect(dialectStatus("arrived", DEFAULT_004010)).toBe("X3");
    expect(dialectStatus("delivered", DEFAULT_004010)).toBe("D1");
  });

  it("applyMapping does not corrupt a ref whose key collides with a prototype member", () => {
    const tender: TenderDoc = {
      partnerScac: "MEGA",
      purpose: "00",
      refs: { toString: "keepme" },
      stops: [],
    };
    const out = applyMapping(tender, DEFAULT_004010);
    // The unknown qualifier passes through unchanged — NOT into an inherited Object.prototype.toString.
    expect(Object.keys(out.refs)).toEqual(["toString"]);
    expect(out.refs["toString"]).toBe("keepme");
  });

  it("dialectStatus always returns a string, even for a prototype-member code", () => {
    expect(dialectStatus("__proto__", DEFAULT_004010)).toBe("__proto__");
    expect(dialectStatus("toString", DEFAULT_004010)).toBe("toString");
    expect(dialectStatus("constructor", DEFAULT_004010)).toBe("constructor");
    expect(typeof dialectStatus("hasOwnProperty", DEFAULT_004010)).toBe("string");
  });
});
