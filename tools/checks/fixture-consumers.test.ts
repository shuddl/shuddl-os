import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §1475 (REQ-118/119) — A FIXTURE WHOSE PATH NOTHING READS CANNOT UNBLOCK ANYTHING.
//
// Five gates are BLOCKED on nine pending engagement fixtures, and that is the only thing between this repo and
// PROMOTABLE. §1458 proved the CONSUMERS detect divergence (`runParity` catches a status mismatch). §1474 gave
// the remaining question: when a claim's truth is out of reach, verify its PRECONDITION — here, *is the
// instrument still wired?* A fixture vendored into a path no code reads satisfies nothing, and looks identical
// from the outside to one that has not arrived yet: the board says BLOCKED either way.
//
// MEASURED at §1475, and the pattern is clean: every VENDORED fixture has at least one code consumer, and the
// four with NONE are all pending —
//
//   customer-roster        `fixtures/roster/`          declares `WP-14/15 Migrator`
//   legacy-import-formats  `fixtures/legacy-imports/`  declares `WP-15 projections`
//   legacy-export-replay   `fixtures/legacy-export/`   declares `WP-02/04/15 ±2% aggregate`
//   synthetic-blitz-3100   `fixtures/blitz/`           declares `WP-15 shadow tooling`
//
// `legacy-export-replay` is the sharp one: CLAUDE.md rule 6 names *"legacy-export replay ±2% aggregate"* as a
// MERGE gate, and no code reads the path its manifest entry declares. Vendoring it would unblock the manifest
// hash check and nothing else.
//
// This is recorded, not fixed: building those consumers is new scope needing a register row, and the fixtures
// they would read do not exist yet. What the gate prevents is the two silent decays — a NEW manifest entry
// landing with no consumer, and an EXISTING consumer being renamed away from its path, which would turn a
// wired fixture into an inert one with no signal at all.

const MANIFEST = "fixtures/manifest.json";

interface Entry {
  readonly id: string;
  readonly path: string;
  readonly status: string;
  readonly gates?: string;
}

/** Fixtures declared with NO code consumer today, each with what vendoring it would (not) achieve. */
const DECLARED_UNCONSUMED: readonly { readonly id: string; readonly why: string }[] = [
  {
    id: "customer-roster",
    why:
      "Declares `WP-14/15 Migrator`. No code reads `fixtures/roster/`. Its plausible consumer is the identity " +
      "surface (the roster is what an IDENTITY_DENYLIST would be built from), and that gate is itself BLOCKED " +
      "on the denylist secret — so this fixture is second in a chain, not directly wired.",
  },
  {
    id: "legacy-import-formats",
    why:
      "Declares `WP-15 projections`. No code reads `fixtures/legacy-imports/`. This is the fixture the " +
      "checklist's *routes ±10%* row is about: CLAUDE.md rule 6 names four fixture gates and that one has " +
      "neither a REQ row nor an implementation, which is recorded there as OPEN.",
  },
  {
    id: "legacy-export-replay",
    why:
      "Declares `WP-02/04/15 ±2% aggregate`, and CLAUDE.md rule 6 names *legacy-export replay ±2% aggregate* " +
      "as a MERGE gate. Nothing reads `fixtures/legacy-export/`, so the merge gate that law describes has no " +
      "implementation behind it — the strongest instance of this class and the reason the gate exists.",
  },
  {
    id: "synthetic-blitz-3100",
    why:
      "Declares `WP-15 shadow tooling`. No code reads `fixtures/blitz/`. A load/soak corpus whose consumer is " +
      "the shadow-mode tooling, which is not built; unlike the three above it names no law in CLAUDE.md, so it " +
      "is the least surprising member.",
  },
];

function entries(root: string): Entry[] {
  const raw = JSON.parse(readFileSync(`${root}/${MANIFEST}`, "utf8")) as unknown;
  const list = Array.isArray(raw) ? raw : ((raw as { fixtures?: unknown }).fixtures ?? []);
  const arr = Array.isArray(list) ? list : Object.entries(list as Record<string, object>).map(([id, v]) => ({ id, ...v }));
  return arr as Entry[];
}

/**
 * Every tracked TS source/test — the places a fixture path could actually be read from.
 *
 * SELF EXCLUDED BY PATH. This file quotes `fixtures/roster/` and the other three in its declarations, so
 * scanning itself makes every unconsumed fixture look consumed — the gate's own consistency check caught that
 * on its first run (§1416's `PRAGMA writable_schema` shape, where a scanner flags its own message). Excluded by
 * PATH and not by a phrase filter, per §1426: a named file cannot quietly widen, a phrase can.
 */
const SELF = "tools/checks/fixture-consumers.test.ts";

function codeCorpus(root: string): string {
  const files = execSync("git ls-files -- '*.ts' '*.tsx'", { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .filter((f) => f !== "" && f !== SELF);
  return files.map((f) => readFileSync(`${root}/${f}`, "utf8")).join("\n");
}

describe("§1475 REQ-119: every fixture the manifest declares is read by some code", () => {
  const root = repoRoot();
  const all = entries(root);
  const code = codeCorpus(root);
  const consumed = (e: Entry): boolean => code.includes(e.path.replace(/\/$/, ""));

  it("derives a real population (non-vacuity)", () => {
    // LIVE, MEASURED at §1475: 17 entries — 9 pending, 7 vendored, 1 in-repo-test.
    expect(all.length, "the manifest parsed to nothing — its shape changed, not the fixtures").toBeGreaterThanOrEqual(10);
    expect(code.length, "the code corpus read as empty — every fixture would look unconsumed").toBeGreaterThan(500_000);
  });

  it("every VENDORED fixture is read by code (the positive control that the detector works)", () => {
    // This is what makes the failure below meaningful: vendored fixtures are demonstrably wired, so a zero for
    // a pending one is a fact about the wiring rather than about the detector.
    const dark = all.filter((e) => e.status === "vendored" && !consumed(e)).map((e) => `${e.id} → ${e.path}`);
    expect(
      dark,
      "a VENDORED fixture's path is read by no code — it is present, hashed, and inert. Either a consumer was " +
        "renamed away from it, or it was vendored for a gate that was never built:\n  " + dark.join("\n  "),
    ).toEqual([]);
  });

  it("every unconsumed fixture is DECLARED, with what vendoring it would not achieve", () => {
    const undeclared = all
      .filter((e) => !consumed(e) && !DECLARED_UNCONSUMED.some((d) => d.id === e.id))
      .map((e) => `${e.id} (${e.status}) → ${e.path}  [declares gates: ${e.gates ?? "none"}]`);
    expect(
      undeclared,
      "a manifest fixture's path is read by NO code, so vendoring it unblocks the manifest hash check and " +
        "nothing else — while the board reports BLOCKED identically whether it is absent or merely unread. " +
        "Wire a consumer, or declare it here with what its `gates` field promises and why nothing implements " +
        "that yet:\n  " + undeclared.join("\n  "),
    ).toEqual([]);
  });

  it("every declaration still has its subject, and is still unconsumed (no exemption outlives either)", () => {
    for (const d of DECLARED_UNCONSUMED) {
      const e = all.find((x) => x.id === d.id);
      expect(e, `DECLARED_UNCONSUMED names ${d.id}, which the manifest no longer lists — delete the entry`).toBeDefined();
      expect(
        e !== undefined && consumed(e),
        `${d.id} now HAS a code consumer — delete this declaration so the gate enforces it directly`,
      ).toBe(false);
      expect(d.why.length, `${d.id}'s reason is too short to be a reason`).toBeGreaterThan(140);
    }
  });
});

// §1586 (REQ-112/118/119) — `check:fixtures` READS ONE MANIFEST; `fixtures/` HOLDS TWO.
//
// `tools/fixtures/verify.ts` reads exactly `fixtures/manifest.json`. But `fixtures/jurisdiction/` carries its
// OWN manifest with a different schema (`note` / `border_policy` / `artifacts`), and the root manifest does not
// name that directory at all. Nothing was wrong — the jurisdiction artifact is byte-bound by
// `packages/ledger/test/jurisdiction.test.ts`, which reads the recorded `sha256` from its manifest and COMPUTES
// the fixture's digest (one side read, the other derived — the only shape that pins anything).
//
// What was missing is the TOTALITY of the claim. A reader running `check:fixtures` reasonably believes it covers
// `fixtures/`; it covers one manifest's paths. So a THIRD manifest, or a fixture directory with none at all,
// could arrive and no gate would say a word. This makes the coverage exhaustive: every tracked file under
// `fixtures/` is either inside a root-manifest path, or inside a directory declared below WITH the test that
// enforces it, or an explicitly non-fixture file.

/** A fixture directory that carries its own manifest, and the test that byte-binds it. */
const SELF_MANIFESTED: readonly { readonly dir: string; readonly manifest: string; readonly enforcedBy: string; readonly why: string }[] = [
  {
    dir: "fixtures/jurisdiction/",
    manifest: "fixtures/jurisdiction/manifest.json",
    enforcedBy: "packages/ledger/test/jurisdiction.test.ts",
    why:
      "REQ-166: the synthetic 5-state polygon set. Its manifest carries a per-artifact `role` (active vs the " +
      "BLOCKED licensed production dataset) and a `border_policy`, which the root manifest's schema has no place " +
      "for. The enforcing test asserts the fixture's digest EQUALS the manifest's recorded sha256, that the " +
      "embedded const deep-equals the file, and that the licensed artifact stays path-less and hash-less.",
  },
];

/** Files under `fixtures/` that are not fixtures. */
const NON_FIXTURE: readonly string[] = ["fixtures/README.md", "fixtures/manifest.json"];

describe("§1586 REQ-112: every file under fixtures/ is covered by a manifest that something enforces", () => {
  const root = repoRoot();
  const tracked = execSync('git ls-files "fixtures"', { cwd: root, encoding: "utf8" }).split("\n").filter((f) => f.length > 0);
  const rootPaths = (JSON.parse(readFileSync(`${root}/fixtures/manifest.json`, "utf8")) as { fixtures: { path: string }[] }).fixtures.map((f) => f.path);

  it("derives a real population (non-vacuity)", () => {
    expect(tracked.length, "no tracked files under fixtures/ — the scan broke, not the tree").toBeGreaterThanOrEqual(10);
    expect(rootPaths.length, "the root manifest declares almost nothing — it did not parse").toBeGreaterThanOrEqual(15);
  });

  it("each self-manifested directory still has BOTH its manifest and its enforcing test (no row outlives its subject)", () => {
    for (const s of SELF_MANIFESTED) {
      expect(existsSync(`${root}/${s.manifest}`), `${s.dir}: declared manifest ${s.manifest} is gone`).toBe(true);
      expect(existsSync(`${root}/${s.enforcedBy}`), `${s.dir}: enforcing test ${s.enforcedBy} is gone — the exemption now covers nothing`).toBe(true);
      expect(s.why.length, `${s.dir}: an exemption without a stated reason is an unexplained hole`).toBeGreaterThan(80);
    }
  });

  it("no fixture file sits outside every manifest", () => {
    const orphans = tracked.filter(
      (f) =>
        !NON_FIXTURE.includes(f) &&
        !rootPaths.some((p) => f === p || f.startsWith(p)) &&
        !SELF_MANIFESTED.some((s) => f.startsWith(s.dir)),
    );
    expect(
      orphans,
      "these files live under `fixtures/` but no manifest declares them, so `check:fixtures` never hashes them " +
        "and nothing detects an edit. Add the path to `fixtures/manifest.json`, or — if the directory needs its " +
        "own schema — give it a manifest AND a test that binds the bytes to it, then declare both in " +
        "SELF_MANIFESTED above:\n  " + orphans.join("\n  "),
    ).toEqual([]);
  });
});
