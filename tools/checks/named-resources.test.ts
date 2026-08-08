import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// REQ-154 §618 — EVERY CLOUD RESOURCE genesis/14 §02 NAMES EITHER EXISTS OR IS RECORDED AS PENDING.
//
// §617 found `shuddl-tiles` — an R2 bucket §02 names as part of the environment contract — declared in NO
// wrangler.toml. It appeared in exactly one file in the repo: genesis/14 itself.
//
// §618 first tried to generalize §617 the obvious way, by SEMANTICS: scan the source context around every
// citation of a row classified `built-annotated` for deferral language ("deploy line item", "not built",
// "deferred", "stub"). That heuristic FAILED, twice over, and the failure is why this file takes a different
// shape:
//
//   1. It returned 51 hits from 171 rows. The three most explicit ("NOT built") were read in full and ALL
//      THREE were false positives — in each, the deferral referred to a DIFFERENT thing than the cited row.
//      REQ-048's comment says `approval.requested` SATISFIES it; REQ-203's cert flow is fully built
//      (cert_status column, a withhold gate, dedicated tests) and the unbuilt thing was the transport adapter.
//   2. Worse, it could not have found REQ-075 at all. The admission — "self-hosted Protomaps vectors ... are a
//      deploy line item" — lives in `packages/map/src/demo.ts`, a file that contains ZERO citations of
//      REQ-075. A citation-context scan cannot see a confession written where the row is not cited.
//
// The signal that DID work was structural, and it has no semantic component: a name stated in the environment
// contract that appears in no config is either unprovisioned or a typo, and both are worth failing on. That is
// what this file checks. It cannot find every §617-shaped gap — nothing mechanical can read "this is a deploy
// line item" — but it finds this one reliably, which the heuristic did not.

const PENDING: ReadonlyMap<string, string> = new Map([
  [
    "shuddl-tiles",
    "UNPROVISIONED, recorded 2026-08-07 (audit §617). The shipped Command surface renders against " +
      "DEMO_TILE_URL (a third-party public host) and packages/map/src/demo.ts calls the self-hosted bucket " +
      "'a deploy line item'. REQ-075 carries the disposition. Delete this entry when the bucket is bound.",
  ],
]);

/** Every `shuddl-*` resource name genesis/14 §02 states. */
function namedInSpec(root: string): string[] {
  const spec = readFileSync(`${root}/genesis/14-BUILD-EXECUTION-SPEC.md`, "utf8");
  const section = /## \(02\) ENVIRONMENTS & NAMING(.*?)## \(03\)/s.exec(spec)?.[1] ?? "";
  // Literal names only — the `{env}`/`{slug}` templates are patterns, not resources, and are covered by the
  // conformance measurement in §617 rather than by existence.
  return [...new Set([...section.matchAll(/`(shuddl-[a-z0-9-]+)`/g)].map((m) => m[1]!))]
    .filter((n) => !/\{|\}/.test(n))
    .sort();
}

/** Every resource name any committed wrangler.toml declares. */
function declaredInConfigs(root: string): Set<string> {
  const out = new Set<string>();
  for (const f of execSync('git ls-files "workers/*/wrangler.toml"', { cwd: root, encoding: "utf8" }).trim().split("\n")) {
    for (const m of readFileSync(`${root}/${f}`, "utf8").matchAll(/"(shuddl-[a-z0-9-]+)"/g)) out.add(m[1]!);
  }
  return out;
}

describe("REQ-154 §618: every resource named in the environment contract exists", () => {
  const root = repoRoot();

  it("the §02 section parses and the configs declare resources (non-vacuity)", () => {
    // Either half going silent compares empty to empty and passes — the class this repo met in fifteen gates
    // (§487 … §616), and one this phase committed itself in §616's first parse.
    expect(namedInSpec(root).length, "genesis/14 §02 named no literal resource — the section moved or was reworded").toBeGreaterThan(0);
    expect(declaredInConfigs(root).size, "no shuddl-* names found in any wrangler.toml — the scan is broken").toBeGreaterThan(20);
  });

  it("every literal name in §02 is declared somewhere, or recorded as pending with a reason", () => {
    const declared = declaredInConfigs(root);
    const orphans = namedInSpec(root).filter((n) => !declared.has(n) && !PENDING.has(n));
    expect(
      orphans,
      "genesis/14 §02 names a cloud resource that no wrangler.toml declares. It is either unprovisioned — in " +
        "which case a reader of the environment contract believes infrastructure exists that does not — or a " +
        "typo, and both should fail. Bind it, or add it to PENDING with what it is waiting on:\n  " +
        orphans.join("\n  "),
    ).toEqual([]);
  });

  it("nothing sits in PENDING after it has been provisioned", () => {
    // §"record holds with expiry triggers": a hold that cannot notice its own reason expiring becomes a
    // permanent exemption. Binding the bucket must delete the entry, not silently keep excusing it.
    const declared = declaredInConfigs(root);
    const stale = [...PENDING.keys()].filter((n) => declared.has(n));
    expect(stale, `PENDING still excuses a resource that is now declared — delete the entry:\n  ${stale.join("\n  ")}`).toEqual([]);
  });
});
