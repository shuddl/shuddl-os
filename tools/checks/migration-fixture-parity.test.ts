import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./repo-root.js";

// §920 — A TEST FIXTURE THAT STANDS UP A SCHEMA MUST NOT SILENTLY DIVERGE FROM THE ONE WE SHIP.
//
// §919's defect in one sentence: `money-projection.test.ts` applied migrations 0001-0003 and stopped, so
// its assertion about `mapMoneyProjectionError` passed against a database the product never deploys — and
// the branch it "covered" is unreachable under the real schema, where 0008's BEFORE INSERT trigger fires
// before the UNIQUE index it was matching on. A second invoice correction 500'd instead of 400'ing.
//
// Nothing was wrong with the test. Nothing was wrong with the migration. The defect lived in the DELTA
// between two lists nobody could see at once: that suite's, and `workers/api/test/helpers.ts`'s.
//
// MEASURED AT §920 before building this: the full class was swept, not just the one instance. Adding 0008
// to each of the twelve `packages/ledger` suites that omit it — **all twelve stay green**. §919 was the
// sole member. So this gate is not repairing a field of defects; it is making the delta visible, because
// the delta is what nobody could see.
//
// THIS GATE OWNS ONE HALF, AND THE OTHER HALF ALREADY EXISTED — which is the sharper finding.
//
// `checkTestSchemaParity` (audit §239, wired into the blocking `check:invariants`) already enforces "a
// harness applies every shipped tenant migration". A first cut of this file re-implemented that rule and
// was deleted: a second mechanism for one invariant is how the two drift, and this repo has the scar.
//
// **Its corpus is `globSync("workers/*/test/helpers.ts")` — the four worker helpers, and nothing else.**
// §919's defect lived in `packages/ledger/test/money-projection.test.ts`: a test file, in a package, one
// directory outside that glob. The gate existed, was blocking, was correct, and could not see the file.
// That is the adjacency shape — a discipline applied at the boundary it was written for, stopping one line
// short of the neighbouring one.
//
// So this gate deliberately does NOT restate the fullness rule. It covers the appliers §239 cannot reach,
// with a weaker and more honest rule: a subset is LEGAL there — twelve of them are deliberate and were
// measured harmless at §920 — it just may not be INVISIBLE. §919's defect was a delta between two lists
// nobody could see at once.
//
// WHAT A GREEN HERE DOES NOT MEAN. It does not say a subset is SAFE; §920 measured that separately, once,
// and a future migration could make one of these subsets matter again. It says the subset is DECLARED.

const TENANT_DIR = "db/tenant/migrations";

/** Migration basenames the product ships, read from the tree rather than restated (§830). */
function shipped(root: string, dir: string): Set<string> {
  return new Set(
    execSync(`git ls-files ${dir}`, { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.split("/").pop() as string),
  );
}

/** Files that call applyMigrations with at least one literal `path: "<name>.sql"`. */
function appliers(root: string): { file: string; tenant: string[] }[] {
  const files = execSync("git ls-files", { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => f.includes("/test/") && (f.endsWith(".test.ts") || f.endsWith("helpers.ts")));
  const tenant = shipped(root, TENANT_DIR);
  const out: { file: string; tenant: string[] }[] = [];
  for (const f of files) {
    const text = readFileSync(`${root}/${f}`, "utf8");
    if (!text.includes("applyMigrations")) continue;
    const named = new Set([...text.matchAll(/path:\s*"([^"]+\.sql)"/g)].map((m) => m[1] as string));
    const t = [...named].filter((n) => tenant.has(n)).sort();
    if (t.length > 0) out.push({ file: f, tenant: t });
  }
  return out;
}

/**
 * Every applier of TENANT migrations, with the set it stands up (numeric prefixes, comma-joined).
 * Measured at §920. A subset is legal and several are deliberate — `migrate.test.ts` applies one file
 * because its subject IS the migrator, and the projection suites predate later migrations. The row is what
 * makes the choice visible; changing a list is then a decision someone states rather than a diff nobody reads.
 */
const PINNED: Record<string, string> = {
  "packages/ledger/test/anchor.test.ts": "0001,0002,0003,0004",
  "packages/ledger/test/authority-seam.test.ts": "0001,0002",
  "packages/ledger/test/concierge-timeline.test.ts": "0001,0002,0003,0004,0005,0006",
  "packages/ledger/test/gl-netting.fixture.test.ts": "0001,0002,0003",
  "packages/ledger/test/invoice-gate.test.ts": "0001,0002,0003",
  "packages/ledger/test/lens.test.ts": "0001,0002,0003,0004,0005,0006",
  "packages/ledger/test/messages-projection.test.ts": "0001,0002,0003",
  "packages/ledger/test/migrate.test.ts": "0001",
  "packages/ledger/test/money-projection.test.ts": "0001,0002,0003,0008",
  "packages/ledger/test/parity.test.ts": "0001,0002",
  "packages/ledger/test/projections.test.ts": "0001,0002,0003",
  "packages/ledger/test/qb-journal.fixture.test.ts": "0001,0002,0003",
  "packages/ledger/test/retention.test.ts": "0001,0002,0003,0004,0007",
  "packages/ledger/test/schema-core.test.ts": "0001,0002,0003,0008",
  "packages/ledger/test/schema-domain.test.ts": "0001,0002,0003",
  "workers/agents/test/helpers.ts": "0001,0002,0003,0004,0005,0006,0007,0008",
  "workers/api/test/helpers.ts": "0001,0002,0003,0004,0005,0006,0007,0008",
  "workers/billing/test/helpers.ts": "0001,0002,0003,0004,0005,0006,0007,0008",
  "workers/translator/test/helpers.ts": "0001,0002,0003,0004,0005,0006,0007,0008",
};

const nums = (t: string[]): string => t.map((m) => m.slice(0, 4)).join(",");

describe("§920: no test fixture silently diverges from the shipped schema", () => {
  const root = repoRoot();
  const found = appliers(root);
  const shippedTenant = shipped(root, TENANT_DIR);

  it("the scan finds a real population (non-vacuity — an empty scan pins nothing)", () => {
    expect(shippedTenant.size, `no migrations found under ${TENANT_DIR} — the scan is broken, not the schema`).toBeGreaterThanOrEqual(8);
    expect(found.length, "no test file applies a tenant migration — the scan is broken, not the suite").toBeGreaterThanOrEqual(15);
  });

  it("§239 still owns the fullness rule for harnesses (this gate must not silently become its second copy)", () => {
    // Not a re-implementation — a TRIPWIRE on the division of labour. If `checkTestSchemaParity` is ever
    // deleted or renamed, the fullness half stops being enforced anywhere and this file's scope comment
    // becomes a lie that reads like a decision. Cheap to assert, and it fails loudly at the moment the
    // assumption dies (§672).
    const src = readFileSync(`${root}/tools/checks/invariants.ts`, "utf8");
    // The paren is load-bearing, and its absence is a defect this gate had for one mutation round: a bare
    // `toContain("export function checkTestSchemaParity")` is satisfied by `…ParityX`, so renaming the
    // function away left the tripwire GREEN. A prefix is not an identifier (§913's anchor lesson, on my own
    // instrument this time).
    expect(src, "checkTestSchemaParity is gone — the harness-fullness rule this file defers to no longer exists").toContain("export function checkTestSchemaParity(");
    expect(src, "checkTestSchemaParity no longer globs workers/*/test/helpers.ts — re-derive which appliers it covers before trusting the split above").toContain('globSync("workers/*/test/helpers.ts")');
  });

  it("every applier's migration set is exactly what is pinned (two-sided)", () => {
    const actual = Object.fromEntries(found.map((a) => [a.file, nums(a.tenant)]));
    expect(
      actual,
      "a test file's applied migration set changed, or a new applier appeared. A SUBSET IS ALLOWED — this " +
        "gate does not demand fullness outside shared harnesses. What it refuses is the change being " +
        "invisible: §919's defect was a delta between two lists nobody could see at once. Update the pin in " +
        "the same commit, and say in the message why the new set is right.",
    ).toEqual(PINNED);
  });
});
