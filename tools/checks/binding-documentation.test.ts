import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §1585 (REQ-118/119/154) — EVERY BINDING A WORKER READS IS DISCOVERABLE.
//
// `binding-readers.test.ts` (§1476) asks the forward question: *is every DECLARED binding read by some code?*
// A declaration nobody reads is waste — a provisioned resource that costs money and confuses the next reader.
// This is the INVERSE, and it is the direction with teeth: **a binding the code READS that appears in no
// `wrangler.toml` and on no ops page is a deploy-time knob nobody can discover.** Unset, it is whatever the
// in-code default happens to be; and when the default is wrong for a tenant, the operator has no way to learn
// the knob exists. Nothing else in the suite asks this — that gap is why this file exists.
//
// THE THREE IT FOUND (all optional, all with working defaults, which is exactly why they stayed invisible):
// `CONCIERGE_FROM_NAME` and `DUNNING_FROM_NAME` — the display names on CUSTOMER-VISIBLE mail — and
// `MIGRATOR_MODEL`. Now in `docs/ops/DEPLOYMENT.md` under "Optional runtime vars".
//
// THE TRAPS ARE INHERITED, not rediscovered. `binding-readers`' header records seven probe corrections, five of
// which were its author's error about correct code. Two apply here and are designed in rather than learned again:
//   · SUBSTRING MATCHING (its trap #5): `env.TEST_SEND_TO` matches inside `TEST_SEND_TOKEN`. The lookup below is
//     word-bounded, and `\b` treats `_` as a word character, so `TEST_SEND_TO` cannot match `TEST_SEND_TOKEN`.
//   · READERS LIVE IN PACKAGES (its trap #6): a worker's env is threaded into `packages/*` code. Scanning only
//     `workers/*/src` under-reads the corpus — measured, that miss reported **zero** violations when there were
//     three. The corpus below is workers AND packages, and the floor guards it.
//
// SCOPE: discoverability, not correctness. A name in a toml OR any `docs/ops/` page passes — this gate does not
// judge WHERE a knob is documented, only that an operator can find it. Secrets are deliberately absent from the
// tomls (`wrangler-no-secrets.test.ts`), so `docs/ops/secrets.md` and the checklist are how they qualify.

/** Every `env.NAME` read in worker or package source (tests excluded — a test's env is a fixture). */
function envNamesRead(root: string): string[] {
  const files = execSync('git ls-files "workers" "packages"', { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.tsx?$/.test(f) && /\/src\//.test(f) && !f.includes(".test.") && !f.includes("/test/"));
  const names = new Set<string>();
  for (const f of files) {
    for (const m of readFileSync(`${root}/${f}`, "utf8").matchAll(/\benv\.([A-Z_][A-Z0-9_]{2,})\b/g)) {
      names.add(m[1] as string);
    }
  }
  return [...names].sort();
}

/** The discoverable surface: every wrangler config plus every ops page, concatenated. */
function discoverableText(root: string): string {
  const files = execSync('git ls-files "workers/*/wrangler*.toml" "docs/ops"', { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => f.length > 0);
  return files.map((f) => readFileSync(`${root}/${f}`, "utf8")).join("\n");
}

/** PURE: the names absent from the haystack, word-bounded. Kept separate so a synthetic corpus can prove it. */
export function undocumentedNames(names: readonly string[], haystack: string): string[] {
  return names.filter((n) => !new RegExp(`\\b${n}\\b`).test(haystack));
}

describe("§1585 REQ-154: every env binding the code reads is discoverable in a config or an ops page", () => {
  const root = repoRoot();
  const names = envNamesRead(root);

  it("reads a real corpus (non-vacuity — an empty scan is documented by everything)", () => {
    // Floor the INPUT (§1148). 27 distinct names measured at §1585 across workers + packages. The floor exists
    // because the FIRST version of this probe scanned only `workers/*/src`, under-read the corpus, and reported
    // a clean tree that had three violations in it.
    expect(names.length, "almost no env reads parsed — the extractor broke, not the tree").toBeGreaterThanOrEqual(20);
    expect(names, "the corpus must include names threaded into packages, not just worker-local ones").toContain("JWT_SECRET");
  });

  it("the detector flags an undocumented name and clears a documented one (positive control)", () => {
    // Without this, a matcher that always returned [] would certify the tree forever.
    const haystack = 'binding = "REAL_ONE"\n| `ALSO_REAL` | agents | a documented var |';
    expect(undocumentedNames(["REAL_ONE", "ALSO_REAL"], haystack)).toEqual([]);
    expect(undocumentedNames(["NEVER_MENTIONED"], haystack)).toEqual(["NEVER_MENTIONED"]);
    // …and the substring trap that cost `binding-readers` a false report (its #5).
    expect(undocumentedNames(["TEST_SEND_TO"], 'binding = "TEST_SEND_TOKEN"')).toEqual(["TEST_SEND_TO"]);
  });

  it("no env read is invisible to an operator", () => {
    const missing = undocumentedNames(names, discoverableText(root));
    expect(
      missing,
      "these env names are READ by worker/package code but appear in no `wrangler.toml` and on no `docs/ops/` " +
        "page, so an operator cannot discover the knob exists. If it is a plain var, add a `[vars]` entry to the " +
        "worker's config; if it is a secret (which must NOT go in a config — see `wrangler-no-secrets.test.ts`), " +
        "add it to `docs/ops/secrets.md`; if it is optional, `DEPLOYMENT.md` has an 'Optional runtime vars' " +
        "table. Do not delete the read to satisfy this:\n  " + missing.join("\n  "),
    ).toEqual([]);
  });
});
