import { describe, expect, it } from "vitest";
import type { ClassAdapter } from "@shuddl/contracts";
import { classToDensityPcf } from "../src/adapters/class.js";

// REQ-004: class is an ISOLATED edge adapter (class ↔ density), never the engine foundation. There is
// NO SMC3/NMFC table baked into this module — every density comes from the tenant's ClassAdapter config.
// These tests prove exactly that: the return value is a function of the PASSED adapter, and a class the
// config does not contain is a loud config gap, not a silent default.

const adapterA: ClassAdapter = {
  kind: "class_adapter",
  id: "ca-A",
  version: "1",
  class_to_density_pcf: { "50": 30, "70": 15 },
};

// A DIFFERENT tenant maps the same class to a different density — nothing is hardcoded.
const adapterB: ClassAdapter = {
  kind: "class_adapter",
  id: "ca-B",
  version: "3",
  class_to_density_pcf: { "50": 35, "70": 9.5 },
};

describe("REQ-004: class↔density edge adapter", () => {
  it("returns the density configured for a known class", () => {
    expect(classToDensityPcf("70", adapterA)).toBe(15);
    expect(classToDensityPcf("50", adapterA)).toBe(30);
  });

  it("throws for a class absent from the config, naming the class and the adapter id@version", () => {
    expect(() => classToDensityPcf("999", adapterA)).toThrow(/999/);
    expect(() => classToDensityPcf("999", adapterA)).toThrow(/ca-A@1/);
  });

  it("has NO hardcoded class table — two adapters give different densities for the same class", () => {
    // If a SMC3/NMFC table were baked in, both adapters would return the same number. They must not:
    // the density is a projection of the tenant's config, nothing else.
    expect(classToDensityPcf("70", adapterA)).toBe(15);
    expect(classToDensityPcf("70", adapterB)).toBe(9.5);
    expect(classToDensityPcf("70", adapterA)).not.toBe(classToDensityPcf("70", adapterB));
    expect(classToDensityPcf("50", adapterA)).not.toBe(classToDensityPcf("50", adapterB));
  });
});
