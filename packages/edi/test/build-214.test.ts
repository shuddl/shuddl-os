import { describe, it, expect } from "vitest";
import { build214 } from "../src/build-214.js";
import type { StatusView } from "../src/types.js";

const view: StatusView = {
  shipmentRef: "SHIP123",
  partnerScac: "MEGA",
  isaControl: "42",
  gsControl: "77",
  stops: [
    { statusCode: "X3", reasonCode: "NS", ts: "2026-07-20T08:00:00Z", city: "NEWARK", state: "NJ" },
    { statusCode: "D1", ts: "2026-07-21T16:30:00Z", city: "BOSTON", state: "MA" },
  ],
};

// Expected bytes, built independently of the serializer's internals (fixed-width ISA via padEnd here).
const isa = [
  "ISA", "00", " ".repeat(10), "00", " ".repeat(10), "ZZ", "SHUDDL".padEnd(15), "ZZ", "MEGA".padEnd(15),
  "000101", "0000", "U", "00401", "000000042", "0", "P", ">",
].join("*");

const expected = [
  isa,
  "GS*QM*SHUDDL*MEGA*20000101*0000*77*X*004010",
  "ST*214*0077",
  "B10*SHIP123*SHIP123*MEGA",
  "LX*1",
  "AT7*X3*NS***20260720*0800",
  "MS1*NEWARK*NJ",
  "LX*2",
  "AT7*D1****20260721*1630",
  "MS1*BOSTON*MA",
  "SE*9*0077",
  "GE*1*77",
  "IEA*1*000000042",
].map((s) => s + "~").join("");

describe("build214", () => {
  it("serializes a two-stop StatusView to the exact expected X12 214 bytes", () => {
    expect(build214(view)).toBe(expected);
  });

  it("is byte-stable: identical input yields identical output", () => {
    expect(build214(view)).toBe(build214(view));
  });

  it("pads the interchange control number to the fixed 9-char ISA13/IEA02 field", () => {
    const out = build214(view);
    expect(out).toContain("*000000042*0*P*>~"); // ISA13 padded
    expect(out.endsWith("IEA*1*000000042~")).toBe(true);
  });
});
