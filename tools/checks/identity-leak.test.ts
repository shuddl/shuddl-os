import { describe, expect, it } from "vitest";
import { identityGateResult, parseDenylist, resolveIdentityLeakOutcome, scanForIdentityLeaks } from "./identity-leak.js";

// REQ-167 DoD: a seeded denylist name in a PR fails CI. Tests inject a fake term —
// real names live only in the client-side denylist, never here.
describe("REQ-167: identity-leak lint", () => {
  const files = new Map<string, string>([
    ["src/ok.ts", "export const x = 1;"],
    ["docs/leak.md", "We visited Zebra-Carrier-Testname's dock yesterday."],
  ]);

  it("flags a seeded denylist name (case-insensitive) with file attribution", () => {
    const hits = scanForIdentityLeaks(["ZEBRA-CARRIER-TESTNAME"], files);
    expect(hits.length).toBe(1);
    expect(hits[0]?.file).toBe("docs/leak.md");
  });

  it("masks the term in output — the lint must not amplify the leak", () => {
    const hits = scanForIdentityLeaks(["ZEBRA-CARRIER-TESTNAME"], files);
    expect(hits[0]?.masked).toBe("Z*********************");
    expect(JSON.stringify(hits)).not.toContain("ZEBRA-CARRIER-TESTNAME");
  });

  it("clean tree with a populated denylist passes", () => {
    expect(scanForIdentityLeaks(["ZEBRA-CARRIER-TESTNAME"], new Map([["a.ts", "clean"]]))).toEqual([]);
  });

  it("parses denylists from newline/comma-separated input, ignoring blanks and comments", () => {
    expect(parseDenylist("Alpha Corp\n# comment\nbeta-inc, Gamma LLC\n\n")).toEqual(["Alpha Corp", "beta-inc", "Gamma LLC"]);
  });
});

// REQ-167 (WP-16): the disposition of an ABSENT denylist is the one fail-open gate left in the build.
// It must fail CLOSED in CI / at a WP-exit run, and preserve warn-and-skip only for local dev.
// resolveIdentityLeakOutcome is the pure decision the CLI wraps — tested here without touching process.exit.
describe("REQ-167: absent-denylist disposition fails CLOSED in CI (the last fail-open gate)", () => {
  it("CI + no denylist → code 1, level 'fail' (was exit 0 — this was the fail-open)", () => {
    const o = resolveIdentityLeakOutcome({ terms: null, ci: true, requireDenylist: false, leaks: [] });
    expect(o.code).toBe(1);
    expect(o.level).toBe("fail");
    expect(o.message).toMatch(/REQ-167/);
  });

  it("REQUIRE_DENYLIST + no denylist (even outside CI) → code 1, level 'fail'", () => {
    const o = resolveIdentityLeakOutcome({ terms: null, ci: false, requireDenylist: true, leaks: [] });
    expect(o.code).toBe(1);
    expect(o.level).toBe("fail");
  });

  it("local dev (no CI, no REQUIRE_DENYLIST) + no denylist → code 0, level 'warn' (preserved)", () => {
    const o = resolveIdentityLeakOutcome({ terms: null, ci: false, requireDenylist: false, leaks: [] });
    expect(o.code).toBe(0);
    expect(o.level).toBe("warn");
    expect(o.message).toMatch(/REQ-167/);
  });

  it("clean scan: denylist present + no leaks → code 0, level 'ok' (green even in CI)", () => {
    const o = resolveIdentityLeakOutcome({ terms: ["ZEBRA-CARRIER-TESTNAME"], ci: true, requireDenylist: true, leaks: [] });
    expect(o.code).toBe(0);
    expect(o.level).toBe("ok");
  });

  it("leak found: denylist present + a seeded leak (via scanForIdentityLeaks) → code 1, level 'fail'", () => {
    // The scanner logic is unchanged — feed it an in-memory tree with one planted name.
    const leaks = scanForIdentityLeaks(
      ["ZEBRA-CARRIER-TESTNAME"],
      new Map([
        ["src/ok.ts", "export const x = 1;"],
        ["docs/leak.md", "We visited Zebra-Carrier-Testname's dock yesterday."],
      ]),
    );
    expect(leaks.length).toBe(1);
    const o = resolveIdentityLeakOutcome({ terms: ["ZEBRA-CARRIER-TESTNAME"], ci: false, requireDenylist: false, leaks });
    expect(o.code).toBe(1);
    expect(o.level).toBe("fail");
    // the masked term never leaks back through the disposition message either
    expect(o.message).not.toContain("ZEBRA-CARRIER-TESTNAME");
  });
});

// REQ-288 (V1 remediation Task 3): the mode-aware GateResult the run-gate orchestrator consumes. An
// ABSENT denylist is a missing PREREQUISITE — PENDING locally (promotable=advisory) but BLOCKED under
// merge/release. A found leak is FAIL; a clean scan is PASS with assertions = files scanned.
describe("REQ-288: identityGateResult — absent denylist BLOCKS a merge/release gate", () => {
  it("no denylist + local → PENDING (advisory, promotable only for dev)", () => {
    const g = identityGateResult({ terms: null, mode: "local", leaks: [], filesScanned: 0 });
    expect(g.status).toBe("PENDING");
    expect(g.executed).toBe(false);
  });
  it("no denylist + merge → BLOCKED (the skip that used to green)", () => {
    expect(identityGateResult({ terms: null, mode: "merge", leaks: [], filesScanned: 0 }).status).toBe("BLOCKED");
  });
  it("no denylist + release → BLOCKED", () => {
    expect(identityGateResult({ terms: null, mode: "release", leaks: [], filesScanned: 0 }).status).toBe("BLOCKED");
  });
  it("an empty denylist is treated as absent (nothing was actually asserted)", () => {
    expect(identityGateResult({ terms: [], mode: "merge", leaks: [], filesScanned: 10 }).status).toBe("BLOCKED");
  });
  it("denylist present + a leak → FAIL, assertions>0, and never echoes the raw name", () => {
    const leaks = scanForIdentityLeaks(["ZEBRA-CARRIER-TESTNAME"], new Map([["docs/leak.md", "Zebra-Carrier-Testname"]]));
    const g = identityGateResult({ terms: ["ZEBRA-CARRIER-TESTNAME"], mode: "merge", leaks, filesScanned: 1 });
    expect(g.status).toBe("FAIL");
    expect(g.assertions).toBeGreaterThan(0);
    expect(JSON.stringify(g)).not.toContain("ZEBRA-CARRIER-TESTNAME");
  });
  it("denylist present + clean → PASS with assertions = files scanned", () => {
    const g = identityGateResult({ terms: ["ZEBRA-CARRIER-TESTNAME"], mode: "merge", leaks: [], filesScanned: 42 });
    expect(g.status).toBe("PASS");
    expect(g.executed).toBe(true);
    expect(g.assertions).toBe(42);
  });
});
