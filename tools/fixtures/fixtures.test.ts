import { describe, expect, it } from "vitest";
import { verifyManifest } from "./verify.js";

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
});
