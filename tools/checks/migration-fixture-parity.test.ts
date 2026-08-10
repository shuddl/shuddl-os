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
// TWO RULES, and only the first is substantive:
//   1. A SHARED harness (`*/test/helpers.ts`) that stands up a tenant D1 must apply the FULL shipped set.
//      A per-test subset is a local choice, visible in the file that makes it. A shared helper's subset is
//      applied to every test in the package by someone who never sees the list.
//   2. Every other applier's set is PINNED. A subset stays legal — it just stops being invisible.
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

  it("a SHARED harness stands up the FULL shipped tenant schema", () => {
    // The substantive half. A helpers.ts subset is applied to every test in its package by people who never
    // read the list — which is how an entire suite can validate against a schema that does not exist.
    const partial = found
      .filter((a) => a.file.endsWith("/helpers.ts"))
      .filter((a) => a.tenant.length !== shippedTenant.size)
      .map((a) => `${a.file} applies ${a.tenant.length}/${shippedTenant.size} (${nums(a.tenant)})`);
    expect(
      partial,
      "a shared test harness stands up a PARTIAL tenant schema. Every test in that package then runs against " +
        "a database the product never deploys, and any behaviour the missing migrations change is untestable " +
        "there — §919's double-correction 500 is exactly that, one migration deep. Add the missing files:\n  " +
        partial.join("\n  "),
    ).toEqual([]);
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
