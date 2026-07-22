import { describe, expect, it } from "vitest";
import { analyzeAuthorityCoverage, collectAuthoritativeFiles, AUTHORITATIVE_FILES, type CoverageModule } from "./authority-coverage.js";

// WP-15 Task 2 (REQ-030 / L8) — the anti-silent-bypass coverage lint. These tests feed the pure analyzer
// SYNTHETIC inputs to prove it (a) flags an authoritative file that DROPS the resolveAuthority consultation,
// (b) is MODULE-AWARE — flags a file registered for module X that only consults module Y (the Concierge
// rating-bypass class), and (c) passes a file that consults the right module; then assert the REAL wired files
// all consult, and that the registry shape (5 modules / 9 (module,file) consults / 8 distinct files) has not
// silently shrunk.

describe("analyzeAuthorityCoverage — flags a dropped or WRONG-MODULE consultation, passes the right one", () => {
  it("flags an authoritative file with NO resolveAuthority( call", () => {
    const v = analyzeAuthorityCoverage([{ module: "rating", file: "workers/api/src/routes/rate.ts", content: "export function x(){ return priceShipment(); }" }]);
    expect(v).toHaveLength(1);
    expect(v[0]?.module).toBe("rating");
    expect(v[0]?.file).toBe("workers/api/src/routes/rate.ts");
  });

  it("passes a file that calls resolveAuthority(db, '<its module>')", () => {
    const v = analyzeAuthorityCoverage([{ module: "invoicing", file: "workers/agents/src/biller.ts", content: "const a = authoritativeSource(await resolveAuthority(db, 'invoicing'), false);" }]);
    expect(v).toEqual([]);
  });

  it("MODULE-AWARE — flags a file registered for 'rating' that consults ONLY 'comms' (the Concierge bypass class)", () => {
    // The exact reviewer-flagged bug: a file that emits comms AND prices, but consults only comms authority. A
    // file-granular "consults SOME authority" scan would pass it; the module-aware scan flags the missing rating.
    const v = analyzeAuthorityCoverage([{ module: "rating", file: "workers/agents/src/concierge.ts", content: "const c = authoritativeSource(await resolveAuthority(db, 'comms'), false);" }]);
    expect(v).toHaveLength(1);
    expect(v[0]?.module).toBe("rating");
    expect(v[0]?.detail).toContain("resolveAuthority(db, 'rating')");
  });

  it("passes a dual-module file that consults BOTH its modules", () => {
    const bothConsults = "resolveAuthority(db, 'comms'); resolveAuthority(db, 'rating');";
    const v = analyzeAuthorityCoverage([
      { module: "rating", file: "workers/agents/src/concierge.ts", content: bothConsults },
      { module: "comms", file: "workers/agents/src/concierge.ts", content: bothConsults },
    ]);
    expect(v).toEqual([]);
  });

  it("does NOT accept a bare mention without the module-specific call (a dangling import is not a consultation)", () => {
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

describe("the REAL wired authoritative files all consult their module's resolveAuthority (REQ-030/L8)", () => {
  it("has zero coverage violations across the registered rating/invoicing/settlement/comms/dispatch pairs", () => {
    const files = collectAuthoritativeFiles();
    expect(files.length).toBeGreaterThan(0); // guard: prove we actually read the tree
    expect(analyzeAuthorityCoverage(files)).toEqual([]);
  });

  it("registers all 5 overlay modules / 9 (module,file) consults / 8 distinct files — a shrink is a red flag", () => {
    const modules = AUTHORITATIVE_FILES.map((m) => m.module);
    expect(new Set(modules)).toEqual(new Set<CoverageModule>(["rating", "invoicing", "settlement", "comms", "dispatch"]));
    const pairs = collectAuthoritativeFiles();
    expect(pairs.length).toBe(9); // (module,file) consults — concierge.ts counts under BOTH rating and comms
    expect(new Set(pairs.map((p) => p.file)).size).toBe(8); // distinct files
    // dispatch is covered (orchestrator decision): its consult is the sequencer DO gate, scoped to the
    // appointment.set / dispatch.assigned gated kinds.
    expect(modules).toContain("dispatch");
    expect(AUTHORITATIVE_FILES.find((m) => m.module === "dispatch")?.files).toEqual(["workers/api/src/do/sequencer.ts"]);
    // concierge.ts is authoritative for BOTH comms (it sends) and rating (it prices) — registered under both.
    expect(AUTHORITATIVE_FILES.find((m) => m.module === "rating")?.files).toContain("workers/agents/src/concierge.ts");
    expect(AUTHORITATIVE_FILES.find((m) => m.module === "comms")?.files).toContain("workers/agents/src/concierge.ts");
    // the EDI 204 inbound handler independently prices a partner load tender → authoritative for rating, registered.
    expect(AUTHORITATIVE_FILES.find((m) => m.module === "rating")?.files).toContain("workers/translator/src/inbound.ts");
  });
});
