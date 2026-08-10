import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §942 — THE SURFACE DEPLOY IS FAIL-CLOSED BY ORDERING, AND ORDERING WAS ENFORCED BY A COMMENT.
//
//   deploy:surfaces = pnpm build:surfaces && pnpm check:surfaces -- --built && pnpm --filter … run deploy
//
// Three properties make that a gate rather than a decoration: the check runs BEFORE the deploy, it BLOCKS the
// deploy when it fails, and it inspects the BUILT bundles (`-- --built`) rather than the sources. Until §942
// the only statement of any of them lived in a comment at `gate-wiring.test.ts:17` — §288's own finding,
// applied to the file that recorded it.
//
// MEASURED AT §942. Deleting `check:surfaces` from the chain DOES go red, but the red is
// "gate script(s) nothing invokes" — the §289 ORPHAN check — and it fires only because this chain is
// `check:surfaces`'s SOLE invoker. Incidental: give the script a second caller and the coverage evaporates.
// The three repeal routes that keep it invoked were all SILENT (failed-test count pinned at the baseline 3):
//   R1  run the check AFTER the deploy      → invoked, gates nothing
//   R2  `&&` → `;` before the deploy        → a failing check no longer stops the deploy
//   R3  drop `-- --built`                   → checks the sources, not the bundles that ship
// Each one ships a LIVE PRODUCTION SURFACE past its contract check.
//
// SCOPE, STATED: this pins the CHAIN, not the checker. Whether `tools/deploy/surface-contract.ts` correctly
// validates a built bundle is a separate claim with its own tests; this gate does not re-derive it.

const PKG = "package.json";
const SCRIPT = "deploy:surfaces";

describe("§942: the surface deploy cannot outrun its contract check", () => {
  const scripts = JSON.parse(readFileSync(`${repoRoot()}/${PKG}`, "utf8")).scripts as Record<string, string>;
  const raw = scripts[SCRIPT];
  // Deliberately NOT `as string`: a type argument that lies is worse than none (§"a type argument can be a
  // cast"). If the script is renamed away, `cmd` is "" and every assertion below fails loudly rather than
  // reading a cast-away undefined.
  const cmd = raw ?? "";

  it("the script exists (non-vacuity — a rename must fail here, not silently disable this file)", () => {
    expect(raw, `${PKG} has no "${SCRIPT}" script. If it was renamed, point this gate at the new name; if the ` +
      "surface deploy moved elsewhere, that new path needs these same three properties.").toBeDefined();
  });

  it("runs the contract check BEFORE the deploy, and blocks on it", () => {
    const check = cmd.indexOf("check:surfaces");
    const deploy = cmd.indexOf("run deploy");
    expect(check, `"${SCRIPT}" no longer runs check:surfaces at all (script: "${cmd}")`).toBeGreaterThanOrEqual(0);
    expect(deploy, `"${SCRIPT}" no longer runs the surface deploy (script: "${cmd}")`).toBeGreaterThanOrEqual(0);
    expect(
      check,
      `"${SCRIPT}" runs check:surfaces AFTER the deploy (script: "${cmd}"). The check is still invoked — so the ` +
        "§289 orphan gate stays green — while gating nothing: the surfaces are already live when it runs.",
    ).toBeLessThan(deploy);

    // The segment between the check and the deploy must be a BLOCKING `&&`. A `;` or `||` leaves the check
    // running and its verdict ignored — §656's M158 shape, on the production deploy path.
    const between = cmd.slice(check, deploy);
    expect(
      /&&/.test(between) && !/[;|]\s*$|\|\|/.test(between),
      `"${SCRIPT}" does not BLOCK the deploy on check:surfaces (segment: "${between.trim()}"). With ';' or '||' ` +
        "the check runs, fails, and the deploy proceeds anyway — an unchecked surface goes live.\n" +
        "NOTE: this `&&` is deliberate and must stay. §940/§941 removed `&&` from `test` and `typecheck` " +
        "because those chain two INDEPENDENT corpora and short-circuiting lost one. This is a DEPENDENT " +
        "pipeline — build, then check the built artifact, then deploy — where the `&&` is the fail-closed " +
        "property itself. Do not apply that lesson here.",
    ).toBe(true);
  });

  it("checks the BUILT bundles, not the sources", () => {
    // Without `--built` the contract check reads the source tree and passes on an artifact it never saw —
    // green evidence for a bundle nobody validated. RELEASE-EVIDENCE records this gate's result as if it did.
    expect(
      /check:surfaces\s+--\s+--built/.test(cmd),
      `"${SCRIPT}" runs check:surfaces without \`-- --built\` (script: "${cmd}"). It then validates the sources ` +
        "rather than the bundles being deployed, and reports PASS for an artifact it never inspected.",
    ).toBe(true);
  });

  it("builds before it checks (the check needs an artifact to look at)", () => {
    const build = cmd.indexOf("build:surfaces");
    expect(build, `"${SCRIPT}" no longer builds the surfaces (script: "${cmd}")`).toBeGreaterThanOrEqual(0);
    expect(
      build,
      `"${SCRIPT}" runs check:surfaces before build:surfaces — with \`--built\` there is no bundle yet, so the ` +
        "check either fails spuriously or inspects a stale one from a previous run.",
    ).toBeLessThan(cmd.indexOf("check:surfaces"));
  });
});
