import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

// §1549 (REQ-025/180/118) — THE POOL BINDING ROSTER IS ONE FACT, DECLARED IN FOUR WORKERS.
//
// `POOL_BINDINGS = ["TENANT_POOL_01_DB", "TENANT_POOL_02_DB"]` appears verbatim in `api/provision.ts`,
// `agents/tenants.ts`, `billing/tenants.ts` and `translator/tenants.ts`. It is not a per-worker choice: it is
// HOW MANY POOL SLOTS THE PLATFORM HAS, and a claimed tenant lives in one of them. A worker whose copy is short
// by one cannot resolve a tenant in the new slot — `allTenantSlugs`/`claimedTenantSlugs` simply omit it, so its
// cron work skips that tenant in silence rather than failing.
//
// WHY A GATE HERE AND NOT FOR EVERY DUPLICATE (§1546's rule: gate a class when it has produced a defect, not
// when it has produced a list). This is not a list — it is four copies of ONE fact with no legitimate reason to
// differ, so the invariant is total and the gate needs no allowlist. Contrast `ApiError` (three definitions,
// two meanings) or the per-worker `SecretResolver` classes, where difference is the point.
//
// The tomls ARE gated in the other direction — `tools/deploy/preflight.ts` and `wrangler-scope-parity` compare
// each deployable scope against the declared binding surface, proved by mutation at §1545 (deleting the prod
// `SHIPMENT_SEQ` block reds both). But preflight carries its OWN hardcoded lists rather than importing these
// arrays, so nothing tied the four source copies to each other or to the tomls. This closes that seam only:
// the four must agree with each other.

const OWNERS = [
  "workers/api/src/provision.ts",
  "workers/agents/src/tenants.ts",
  "workers/billing/src/tenants.ts",
  "workers/translator/src/tenants.ts",
] as const;

/** The literal array a file declares for POOL_BINDINGS, in source order. */
function poolBindingsIn(root: string, file: string): string[] | null {
  const m = /export const POOL_BINDINGS[^=]*=\s*\[([^\]]*)\]/.exec(readFileSync(`${root}/${file}`, "utf8"));
  if (m === null) return null;
  return [...(m[1] as string).matchAll(/"([^"]+)"/g)].map((x) => x[1] as string);
}

describe("§1549 REQ-025: every worker agrees on how many tenant pool slots exist", () => {
  const root = repoRoot();

  it("derives a real population (non-vacuity — a missing declaration must not read as agreement)", () => {
    // Floor the INPUT (§1148). If a file is renamed, this fails LOUDLY rather than comparing three copies and
    // calling the tree clean — the failure mode the roster exists to prevent.
    for (const f of OWNERS) {
      expect(poolBindingsIn(root, f), `${f} no longer declares POOL_BINDINGS — update this roster, do not delete the check`).not.toBeNull();
    }
  });

  it("all four declarations are identical, in the same order", () => {
    const seen = OWNERS.map((f) => ({ file: f, bindings: poolBindingsIn(root, f) ?? [] }));
    const first = seen[0]!;
    const disagree = seen
      .filter((s) => s.bindings.join(",") !== first.bindings.join(","))
      .map((s) => `${s.file} → [${s.bindings.join(", ")}]`);
    expect(
      disagree,
      `the workers disagree about the tenant pool roster. This is one platform fact — how many pool slots exist — ` +
        `and a worker whose copy is SHORT cannot resolve a tenant in the missing slot: allTenantSlugs and ` +
        `claimedTenantSlugs omit it, so that worker's cron work skips the tenant in SILENCE rather than failing. ` +
        `Baseline is ${first.file} → [${first.bindings.join(", ")}]:\n  ` + disagree.join("\n  "),
    ).toEqual([]);
  });

  it("every declared binding is also declared in that worker's wrangler.toml (the roster is not free-floating)", () => {
    // A roster that agrees with itself but not with the deployment is agreement about nothing. Preflight checks
    // the toml against ITS OWN list; this checks the toml against the SOURCE list, which is the seam between them.
    const tomls = execSync("git ls-files", { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter((f) => f.endsWith("wrangler.toml"));
    const missing: string[] = [];
    for (const f of OWNERS) {
      const worker = f.split("/").slice(0, 2).join("/");
      const toml = tomls.find((t) => t.startsWith(`${worker}/`));
      if (toml === undefined) continue;
      const text = readFileSync(`${root}/${toml}`, "utf8");
      for (const b of poolBindingsIn(root, f) ?? []) {
        if (!text.includes(`"${b}"`)) missing.push(`${toml} does not declare ${b} (named by ${f})`);
      }
    }
    expect(missing, "a worker's source names a pool binding its own wrangler.toml never declares:\n  " + missing.join("\n  ")).toEqual([]);
  });
});
