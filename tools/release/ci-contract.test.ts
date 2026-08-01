import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// V1 remediation Task 4 (REQ-288 / REQ-276) — CI must exercise the COMPLETE merge surface, not a subset,
// and every claim must be non-skippable. This contract parses the workflow text and fails if a required
// job is missing or if any action is pinned to a mutable tag. It is the guard that keeps CI honest.

const CI = readFileSync(".github/workflows/ci.yml", "utf8");

describe("CI runtime + workspace surface", () => {
  it("takes its Node from the pinned .node-version and runs the runtime preflight", () => {
    expect(CI).toMatch(/node-version-file:\s*\.node-version/);
    expect(CI).toMatch(/check:runtime/);
  });

  it("builds every workspace", () => {
    expect(CI).toMatch(/pnpm -r --if-present build/);
  });

  it("runs acceptance", () => {
    expect(CI).toMatch(/test:acceptance/);
  });

  it("runs the aggregate merge-evidence gate (parity, identity, invariant, authority, traceability, coverage)", () => {
    // verify:merge is run-gate: it runs rater/invoice/concierge parity, the identity-leak gate, the
    // invariant/authority/traceability/coverage gates, and the browser BLOCK detection in one record.
    expect(CI).toMatch(/verify:merge/);
  });
});

describe("CI strict browser/accessibility/performance jobs", () => {
  it("installs the Playwright browser + OS deps", () => {
    expect(CI).toMatch(/playwright install/);
  });

  it("runs strict visual, accessibility, end-to-end, and performance in merge mode (BLOCK, never skip)", () => {
    expect(CI).toMatch(/test:visual/);
    expect(CI).toMatch(/test:a11y/);
    expect(CI).toMatch(/test:e2e/);
    expect(CI).toMatch(/perf:map/);
    // EVERY strict browser gate is invoked in a non-local mode so an absent browser BLOCKS rather than
    // skips. Asserted per-step (2026-08-01 audit): a single /--mode merge/ match let three of the four
    // steps silently lose their flag and fall back to local mode, where an all-skipped run exits 0.
    for (const step of ["test:visual", "test:a11y", "test:e2e", "perf:map"]) {
      const line = CI.split("\n").find((l) => l.includes(`pnpm ${step}`));
      expect(line, `ci.yml must invoke ${step}`).toBeDefined();
      expect(line, `${step} must carry --mode merge — without it playwright-guard runs local and cannot block`).toContain("--mode merge");
    }
  });
});

describe("each browser gate selects its own Playwright project", () => {
  // Task 14: `test:a11y` used to point at a config whose testDir was ./tests/visual, so the accessibility
  // step silently re-ran the screenshot tests. A gate whose name does not match the tests it runs is
  // worse than no gate — it reports a green for a claim nobody checked.
  const PKG = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };

  it.each([
    ["test:visual", "visual"],
    ["test:a11y", "a11y"],
    ["test:e2e", "e2e"],
  ])("%s runs --project %s", (script, project) => {
    expect(PKG.scripts[script]).toContain(`--project ${project}`);
  });

  it("declares a distinct project per gate so no two gates run the same tests", () => {
    const projects = ["test:visual", "test:a11y", "test:e2e"].map((s) => /--project (\S+)/.exec(PKG.scripts[s] ?? "")?.[1]);
    expect(new Set(projects).size).toBe(3);
  });
});

describe("the blessed-screenshot determinism contract actually delivers reduced motion", () => {
  // THE DEFECT THIS EXISTS FOR. playwright.config.ts declared the motion axis of its determinism
  // contract as `use: { reducedMotion: "reduce" }` on all three browser projects. That is not a
  // Playwright test option — 1.61 assembles `_combinedContextOptions` from an enumerated fixture list
  // that has no such entry, plus `contextOptions` — so the key was dropped SILENTLY. The config loaded
  // clean, every gate stayed green, and `matchMedia("(prefers-reduced-motion: reduce)").matches` was
  // `false` in every blessed capture for the whole life of the refs. A typo'd option cannot fail, which
  // is exactly why it survived: the only thing that noticed was a typecheck the config was excluded
  // from.
  //
  // These assertions read the RESOLVED CONFIG OBJECT — the same object Playwright consumes — rather
  // than the file's text, so they cannot be satisfied by a comment and cannot be fooled by
  // reformatting. Reverting either config to the bare key turns them RED.
  //
  // The sibling guards, deliberately at different altitudes: tests/visual/screens.spec.ts asserts the
  // media query inside the browser at the point of capture (the end of the channel), and
  // tsconfig.tools.json now compiles both configs, so the bare key is a type error too.

  it("pins reduced motion through contextOptions — the only channel Playwright reads — on every project", async () => {
    const config = (await import("../../playwright.config.js")).default;
    const projects = config.projects ?? [];
    expect(projects.map((p) => p.name)).toEqual(["visual", "e2e", "a11y"]);

    for (const p of projects) {
      const use = p.use ?? {};
      // The trap, named. `use.reducedMotion` is the spelling that looks right, typechecks nowhere, and
      // does nothing. Its presence is the regression, whether or not contextOptions is also set.
      expect(Object.keys(use), `${p.name}: reducedMotion sits directly on \`use\`, where Playwright never reads it`).not.toContain("reducedMotion");
      expect(use.contextOptions?.reducedMotion, `${p.name}: the capture is not pinned to reduced motion`).toBe("reduce");
    }
  });

  it("keeps the capture's own assertion that the preference reached the page", () => {
    // Config-shape alone would still pass if a future Playwright renamed the channel. The screenshot
    // spec asks the browser directly, and that question must not be quietly deleted.
    const SPEC = readFileSync("tests/visual/screens.spec.ts", "utf8");
    expect(SPEC).toMatch(/matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches/);
  });

  it("does NOT pin reduced motion on the deployed-surface field gate", async () => {
    // A deliberate asymmetry, not an oversight. playwright.prod.config.ts takes no screenshots, so it
    // has no baseline to keep deterministic, and its entire purpose is to observe what a stranger sees
    // — a stranger who does not arrive with a non-default OS accessibility preference set. Copying the
    // knob across would make the field observation less faithful, not more.
    const prod = (await import("../../playwright.prod.config.js")).default;
    const use = prod.use ?? {};
    expect(Object.keys(use)).not.toContain("reducedMotion");
    expect(use.contextOptions?.reducedMotion).toBeUndefined();
  });
});

describe("CI supply-chain + secret surface", () => {
  it("runs a production dependency audit", () => {
    expect(CI).toMatch(/audit --prod/);
  });

  it("runs a history-wide gitleaks scan (full fetch depth)", () => {
    expect(CI).toMatch(/gitleaks/);
    expect(CI).toMatch(/fetch-depth:\s*0/);
  });

  it("uploads the evidence artifact even when a gate fails", () => {
    expect(CI).toMatch(/upload-artifact/);
    expect(CI).toMatch(/if:\s*(\$\{\{\s*)?always\(\)/);
  });
});

describe("every GitHub Action is pinned to an immutable commit SHA", () => {
  const uses = [...CI.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1] ?? "");

  it("finds action references to check", () => {
    expect(uses.length).toBeGreaterThan(0);
  });

  it("pins each uses: to a full 40-hex commit SHA", () => {
    for (const u of uses) expect(u, `unpinned action: ${u}`).toMatch(/@[0-9a-f]{40}$/);
  });

  it("rejects any mutable @vN version tag", () => {
    // A 40-hex SHA can begin with a digit, so the reject pattern is specifically the version-tag shape
    // `@v<number>` (e.g. @v4, @v4.2.2) — never a bare digit inside a SHA.
    for (const u of uses) expect(u, `mutable tag: ${u}`).not.toMatch(/@v\d/);
  });
});
