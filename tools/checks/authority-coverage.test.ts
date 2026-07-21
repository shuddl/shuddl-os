import { describe, expect, it } from "vitest";
import { analyzeAuthorityCoverage, collectAuthoritativeFiles, AUTHORITATIVE_FILES, type CoverageModule } from "./authority-coverage.js";

// WP-15 Task 2 (REQ-030 / L8) — the anti-silent-bypass coverage lint. These tests feed the pure analyzer
// SYNTHETIC inputs to prove it flags an authoritative file that DROPS the resolveAuthority consultation (the
// regression the lint exists to catch) and passes one that keeps it; then assert the REAL wired files all
// consult, and that the registry shape (4 modules / 6 files) has not silently shrunk.

describe("analyzeAuthorityCoverage — flags a dropped consultation, passes a present one", () => {
  it("flags an authoritative file with NO resolveAuthority( call", () => {
    const v = analyzeAuthorityCoverage([{ module: "rating", file: "workers/api/src/routes/rate.ts", content: "export function x(){ return priceShipment(); }" }]);
    expect(v).toHaveLength(1);
    expect(v[0]?.module).toBe("rating");
    expect(v[0]?.file).toBe("workers/api/src/routes/rate.ts");
  });

  it("passes a file that calls resolveAuthority(...)", () => {
    const v = analyzeAuthorityCoverage([{ module: "invoicing", file: "workers/agents/src/biller.ts", content: "const a = authoritativeSource(await resolveAuthority(db, 'invoicing'), false);" }]);
    expect(v).toEqual([]);
  });

  it("does NOT accept a bare mention without the call-paren (a dangling import is not a consultation)", () => {
    const v = analyzeAuthorityCoverage([{ module: "comms", file: "workers/api/src/routes/dunning.ts", content: "import { resolveAuthority } from '../authority.js'; // never called" }]);
    expect(v.map((x) => x.module)).toEqual(["comms"]);
  });

  it("flags each dropped file independently across a mixed batch", () => {
    const v = analyzeAuthorityCoverage([
      { module: "rating", file: "a.ts", content: "resolveAuthority(db, 'rating')" }, // ok
      { module: "settlement", file: "b.ts", content: "no consult here" }, // dropped
      { module: "comms", file: "c.ts", content: "x = resolveAuthority ( db , 'comms' )" }, // ok (whitespace)
    ]);
    expect(v.map((x) => x.file)).toEqual(["b.ts"]);
  });
});

describe("the REAL wired authoritative files all consult resolveAuthority (REQ-030/L8)", () => {
  it("has zero coverage violations across the registered rating/invoicing/settlement/comms files", () => {
    const files = collectAuthoritativeFiles();
    expect(files.length).toBeGreaterThan(0); // guard: prove we actually read the tree
    expect(analyzeAuthorityCoverage(files)).toEqual([]);
  });

  it("registers 4 modules / 6 files — a shrink is a red flag the lint should surface, not hide", () => {
    const modules = AUTHORITATIVE_FILES.map((m) => m.module);
    expect(new Set(modules)).toEqual(new Set<CoverageModule>(["rating", "invoicing", "settlement", "comms"]));
    expect(AUTHORITATIVE_FILES.reduce((n, m) => n + m.files.length, 0)).toBe(6);
    // dispatch is DELIBERATELY absent (no native-compute service seam outside the sequencer hot path — pending
    // an orchestrator decision). Assert it stays out until that lands, so re-adding it is a conscious edit.
    expect(modules).not.toContain("dispatch");
  });
});
