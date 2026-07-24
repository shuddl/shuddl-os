import { describe, expect, it } from "vitest";
import { fixtureGateResult, verifyManifest } from "./verify.js";

describe("REQ-112: fixture registry", () => {
  it("verifies a vendored entry by hash and fails on mismatch", () => {
    const r = verifyManifest({
      fixtures: [{ id: "x", gates: "t", status: "vendored", path: "fixtures/README.md", sha256: "0".repeat(64), source: "t" }],
    });
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toContain("hash mismatch");
  });
  it("pending entries are reported loudly but do not fail WP-01", () => {
    const r = verifyManifest({ fixtures: [{ id: "y", gates: "WP-04", status: "pending", path: "fixtures/none/", sha256: null, source: "s" }] });
    expect(r.ok).toBe(true);
    expect(r.pending).toContain("y");
  });
  it("a vendored entry whose file is missing fails", () => {
    const r = verifyManifest({ fixtures: [{ id: "z", gates: "t", status: "vendored", path: "fixtures/does-not-exist.bin", sha256: "0".repeat(64), source: "t" }] });
    expect(r.ok).toBe(false);
  });
  it("an in-repo-test entry with an existing path is ok and NOT reported pending (presence-checked, never hash-pinned)", () => {
    const r = verifyManifest({
      fixtures: [{ id: "soak", gates: "WP-05", status: "in-repo-test", path: "fixtures/README.md", sha256: null, source: "t" }],
    });
    expect(r.ok).toBe(true);
    expect(r.pending).not.toContain("soak");
  });
  it("an in-repo-test entry whose path is missing fails (deleting the test turns CI red)", () => {
    const r = verifyManifest({
      fixtures: [{ id: "soak", gates: "WP-05", status: "in-repo-test", path: "workers/api/test/does-not-exist.test.ts", sha256: null, source: "t" }],
    });
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toContain("in-repo-test missing");
  });
});

// REQ-288 (V1 remediation Task 3): pending private fixtures are advisory locally but a non-promotable
// BLOCKED under merge/release; a real failure is FAIL regardless of mode.
describe("REQ-288: fixtureGateResult — pending fixtures BLOCK a merge/release gate", () => {
  const pending = { ok: true, failures: [], pending: ["legacy-export-replay", "synthetic-blitz-3100"] };
  it("pending + local → PENDING (advisory, exit 0 preserved)", () => {
    expect(fixtureGateResult("local", pending, 5).status).toBe("PENDING");
  });
  it("pending + merge → BLOCKED (the advisory skip that used to green)", () => {
    const g = fixtureGateResult("merge", pending, 5);
    expect(g.status).toBe("BLOCKED");
    expect(g.detail).toContain("legacy-export-replay");
  });
  it("pending + release → BLOCKED", () => {
    expect(fixtureGateResult("release", pending, 5).status).toBe("BLOCKED");
  });
  it("a hash-mismatch failure is FAIL regardless of mode", () => {
    const failed = { ok: false, failures: ["x: hash mismatch"], pending: [] };
    expect(fixtureGateResult("local", failed, 5).status).toBe("FAIL");
    expect(fixtureGateResult("merge", failed, 5).status).toBe("FAIL");
  });
  it("clean + no pending → PASS with assertions = verified count", () => {
    const g = fixtureGateResult("merge", { ok: true, failures: [], pending: [] }, 7);
    expect(g.status).toBe("PASS");
    expect(g.assertions).toBe(7);
  });
});
