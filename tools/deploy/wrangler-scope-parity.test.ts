import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  DEPLOYABLE_SCOPES,
  WORKER_CONFIGS,
  bindingSets,
  parseWranglerToml,
  targetFromWrangler,
} from "./preflight.js";

// WHY THIS IS A MERGE GATE AND THE PREFLIGHT IS NOT.
//
// The prod gap — `shuddl-api-prod` declaring a name and nothing else — was real for the whole build and
// invisible to CI, because the only thing that looked at it was `tools/deploy/preflight.ts`, a RELEASE
// profile check somebody runs by hand against an environment. By the time it speaks, the config has
// been merged for weeks.
//
// Whether a scope declares the same bindings as its siblings is not an environment question at all. It
// needs no account, no ids, no network — only the committed TOML. So it belongs where a PR can fail on
// it. `vitest.tools.config.ts` includes tools/**/*.test.ts, and run-gate.ts puts `test` in the merge
// profile, so this file is wired into the merge gate by existing.
//
// It compares NAMES, never ids: an id is provisioning (an external hold, and the preflight's job), a
// name is shape (ours, and mergeable). Wrangler does not inherit top-level bindings into a named
// environment, so a missing set here is a worker that dereferences undefined in production.

const config = (path: string): string => readFileSync(path, "utf8");

describe("every deployable scope declares the same bindings as dev", () => {
  for (const path of WORKER_CONFIGS) {
    const doc = parseWranglerToml(config(path));
    const dev = targetFromWrangler(doc, undefined);
    const expected = bindingSets(dev);

    for (const scope of DEPLOYABLE_SCOPES) {
      it(`${path} — [env.${scope}] matches the dev binding surface`, () => {
        const target = targetFromWrangler(doc, scope);
        expect(target.worker, `${path} [env.${scope}] has no name`).toMatch(new RegExp(`-${scope}$`));
        expect(bindingSets(target), `${path} [env.${scope}] binding surface differs from dev`).toEqual(expected);
      });
    }
  }
});

describe("the deployable surface is complete", () => {
  it("is DISCOVERED from the worker tree, so a new one cannot be added unchecked", () => {
    // This assertion used to be `expect(WORKER_CONFIGS).toHaveLength(5)`, which could not do what the test
    // name promised (audit §286). A hardcoded count is blind to the failure it names: add `workers/foo` with
    // bindings and forget the roster, and the length is STILL 5 — green. It fires only when someone does the
    // RIGHT thing and extends the roster. MEASURED: a sixth worker declaring CONTROL_DB at top level and
    // NOTHING under [env.prod] — the exact defect the suite above exists to catch — left all 251 deploy
    // tests passing, because nothing downstream ever looked at a config outside the hand-typed list.
    //
    // Discovery is two-sided on purpose: a new worker must be rostered, and a deleted one must be unrostered
    // (a stale entry would fail the readFileSync below, but silently pass a `length` check). apps/ is
    // deliberately absent — surfaces bind nothing and are covered by surface-contract.ts, which argues that
    // exclusion; `workers/` is the deployable-worker tree, so membership there is the rule.
    const discovered = readdirSync("workers", { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => `workers/${e.name}/wrangler.toml`)
      .filter((p) => existsSync(p))
      .sort();
    expect(discovered.length, "no wrangler configs discovered — the glob is wrong, not the tree").toBeGreaterThan(0);
    expect([...WORKER_CONFIGS].sort(), "WORKER_CONFIGS must equal the discovered worker tree").toEqual(discovered);
    for (const path of WORKER_CONFIGS) expect(() => config(path)).not.toThrow();
  });

  it("declares ENVIRONMENT truthfully in every scope", () => {
    // A scope whose ENVIRONMENT var disagrees with its own name is how a staging deploy quietly behaves
    // like dev. Cheap to check here, and the preflight blocks on it too.
    for (const path of WORKER_CONFIGS) {
      const doc = parseWranglerToml(config(path));
      for (const scope of DEPLOYABLE_SCOPES) {
        const target = targetFromWrangler(doc, scope);
        expect(target.vars["ENVIRONMENT"], `${path} [env.${scope}] ENVIRONMENT`).toBe(scope);
      }
    }
  });
});
