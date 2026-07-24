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

  it("runs strict visual, accessibility, and performance in merge mode (BLOCK, never skip)", () => {
    expect(CI).toMatch(/test:visual/);
    expect(CI).toMatch(/test:a11y/);
    expect(CI).toMatch(/perf:map/);
    // the strict browser gates are invoked in a non-local mode so an absent browser BLOCKS rather than skips
    expect(CI).toMatch(/--mode merge/);
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
