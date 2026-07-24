import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkRuntime, RUNTIME_CONTRACT } from "./runtime-contract.js";

// V1 remediation Task 2 (build contract) — pin and PROVE the one runtime the 1,131-test suite was
// verified under. Node 20 mis-resolves the vitest-pool-workers/chai chain and the D1 trigger semantics
// the ledger relies on; the build is only trustworthy under Node 22.15 + pnpm 11.10. checkRuntime is a
// PURE function so the contract is unit-testable without spawning a second Node.

describe("checkRuntime — the verified Node/pnpm contract", () => {
  it("rejects a Node-20-shaped input and names the required Node line", () => {
    expect(checkRuntime({ node: "20.11.1", pnpm: "11.10.0" })).toMatchObject({
      ok: false,
      violations: expect.arrayContaining([expect.stringMatching(/Node 22\.15/)]),
    });
  });

  it("accepts the exact verified pair", () => {
    expect(checkRuntime({ node: "22.15.0", pnpm: "11.10.0" }).ok).toBe(true);
  });

  it("accepts a v-prefixed Node string (process.version shape) inside the range", () => {
    expect(checkRuntime({ node: "v22.15.3", pnpm: "11.10.0" }).ok).toBe(true);
  });

  it("rejects Node 23 (upper bound is exclusive)", () => {
    const r = checkRuntime({ node: "23.0.0", pnpm: "11.10.0" });
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual(expect.arrayContaining([expect.stringMatching(/Node 22\.15/)]));
  });

  it("rejects a mismatched pnpm and names the required pnpm version", () => {
    const r = checkRuntime({ node: "22.15.0", pnpm: "9.0.0" });
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual(expect.arrayContaining([expect.stringMatching(/pnpm 11\.10\.0/)]));
  });

  it("reports both violations when both are wrong", () => {
    const r = checkRuntime({ node: "20.11.1", pnpm: "9.0.0" });
    expect(r.ok).toBe(false);
    expect(r.violations).toHaveLength(2);
  });
});

// The four declarations of the SAME contract must agree byte-for-byte, or an operator can pass one gate
// while installing a Node the build was never verified under. This is the exact drift the design forbids.
describe("the .node-version / engines / packageManager declarations describe ONE contract", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    engines?: { node?: string; pnpm?: string };
    packageManager?: string;
  };

  it(".node-version pins the exact verified Node", () => {
    expect(readFileSync(".node-version", "utf8").trim()).toBe(RUNTIME_CONTRACT.node.version);
  });

  it("engines.node encodes the same >=22.15.0 <23 range", () => {
    expect(pkg.engines?.node).toBe(RUNTIME_CONTRACT.node.engines);
  });

  it("engines.pnpm and packageManager both pin pnpm 11.10.0", () => {
    expect(pkg.engines?.pnpm).toBe(RUNTIME_CONTRACT.pnpm.version);
    expect(pkg.packageManager).toBe(RUNTIME_CONTRACT.pnpm.packageManager);
  });
});
