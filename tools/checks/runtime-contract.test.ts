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

// REQ-118 §555 — UNPARSEABLE VERSIONS FAIL CLOSED.
//
// `installedPnpm()` catches a failed `pnpm --version` and returns the literal string `"unavailable"`. That
// fallback VALUE is where the guarantee lives, not the catch: this session already found a `{}` default that
// opened three gate knobs it claimed to floor. A missing or broken pnpm is the realistic case — a fresh
// machine, a corepack that has not shimmed yet, a PATH without it.
//
// Both halves fail closed today, and MEASUREMENT changed what this comment says about why.
//
// The first draft claimed the Node half was incidental — that `parseSemver("unavailable")` yields
// `[NaN, 0, 0]` (`?? 0` does not catch NaN) and survives only because `compare` returns 1 for a NaN pair,
// tripping the exclusive upper bound; and that hardening `compare` to treat NaN as 0 would flip it to PASS.
// **That was wrong.** Applying exactly that hardening left all 12 tests green: `[0, 0, 0]` then falls below
// the MINIMUM and the lower bound catches it instead. Dropping the lower bound outright also left these
// tests green, because NaN goes back to tripping the upper one.
//
// So the Node half is over-determined: the check is a two-sided RANGE, and unparseable input lands outside
// it whichever way the NaN falls. No single-bound mutation reddens the Node test below — it records a true
// fact it cannot be the one to catch. Kept, cheaply, as documentation of a measured property.
//
// The pnpm half is the one that needed pinning. It is a string equality, and the realistic refactor is the
// tolerant one: "do not fail the build just because we could not detect pnpm." Adding that exemption
// (`!== "unavailable" && ...`) reddens both pnpm tests below and nothing else — the discrimination that
// makes a pin worth its line count.
describe("REQ-118 §555: an unparseable version is a violation, never a pass", () => {
  const UNPARSEABLE = ["unavailable", "", "not-a-version", "NaN.NaN.NaN"];

  it("rejects every unparseable Node string", () => {
    for (const node of UNPARSEABLE) {
      const r = checkRuntime({ node, pnpm: RUNTIME_CONTRACT.pnpm.version });
      expect(r.ok, `Node ${JSON.stringify(node)} was accepted — an unverifiable runtime certified itself`).toBe(false);
    }
  });

  it("rejects every unparseable pnpm string, including installedPnpm()'s own fallback", () => {
    for (const pnpm of UNPARSEABLE) {
      const r = checkRuntime({ node: "v22.15.0", pnpm });
      expect(r.ok, `pnpm ${JSON.stringify(pnpm)} was accepted`).toBe(false);
    }
  });

  it("the exact fallback literal is covered by name", () => {
    // Bound to the string `installedPnpm()` actually returns: if that literal changes, this test should be
    // the thing that notices, rather than the class-based loop above passing on a value nobody produces.
    const src = readFileSync(new URL("./runtime-contract.ts", import.meta.url), "utf8");
    const fallback = /catch\s*\{\s*return\s+"([^"]+)"/.exec(src)?.[1];
    expect(fallback, "installedPnpm()'s catch no longer returns a string literal — re-verify this test").toBeTruthy();
    expect(checkRuntime({ node: "v22.15.0", pnpm: fallback! }).ok).toBe(false);
  });
});
