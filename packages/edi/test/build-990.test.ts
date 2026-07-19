import { describe, it, expect } from "vitest";
import { build990 } from "../src/build-990.js";

const isa = [
  "ISA", "00", " ".repeat(10), "00", " ".repeat(10), "ZZ", "SHUDDL".padEnd(15), "ZZ", "MEGA".padEnd(15),
  "000101", "0000", "U", "00401", "000000042", "0", "P", ">",
].join("*");

function expected(action: "A" | "D"): string {
  return [
    isa,
    "GS*GF*SHUDDL*MEGA*20000101*0000*77*X*004010",
    "ST*990*0077",
    `B1*MEGA*SHIP123*${action}`,
    "SE*3*0077",
    "GE*1*77",
    "IEA*1*000000042",
  ].map((s) => s + "~").join("");
}

describe("build990", () => {
  it("serializes an ACCEPT (B1 action A) to exact bytes", () => {
    const out = build990({ shipmentRef: "SHIP123", partnerScac: "MEGA", isaControl: "42", gsControl: "77", action: "A" });
    expect(out).toBe(expected("A"));
  });

  it("serializes a DECLINE (B1 action D) to exact bytes", () => {
    const out = build990({ shipmentRef: "SHIP123", partnerScac: "MEGA", isaControl: "42", gsControl: "77", action: "D" });
    expect(out).toBe(expected("D"));
  });

  it("is byte-stable across re-runs", () => {
    const r = { shipmentRef: "SHIP123", partnerScac: "MEGA", isaControl: "42", gsControl: "77", action: "A" } as const;
    expect(build990(r)).toBe(build990(r));
  });
});
