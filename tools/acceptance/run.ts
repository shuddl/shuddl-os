import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { DEMOS, spineByPackage, spineFileCount } from "./demos.js";

// `pnpm test:acceptance` — runs EXACTLY the five doc-00 acceptance SPINE tests (REQ-119 DoD), as the
// named demo-acceptance set, and NOTHING else. Each demo's causal-chain proof already exists; this runner
// does not rebuild them — it invokes each in its OWN package's vitest config (the api/mcp pools are
// vitest-pool-workers, driver is node, map is jsdom — they cannot share one root config), filtered to the
// spine file(s). Green here === the code-provable half of the two-tier DoD holds on the current tree. The
// FILMED half (the <5s / <10min wall-clock, the real driver, the real Claude booking, the visual map-dim)
// is the manifest's job: docs/wp/acceptance-demos.md.

const MCP_API_BUNDLE = "workers/mcp/dist/api/index.js";

function banner(): void {
  console.log(`\n━━━ ACCEPTANCE SPINE — the five doc-00 demos (${spineFileCount()} spine files) ━━━`);
  for (const d of DEMOS) {
    const files = d.spine.map((s) => `${s.pkg} ${s.file}`).join("\n           ");
    console.log(`  demo ${d.n} · ${d.title}\n     spine: ${files}`);
  }
  console.log("━".repeat(72));
}

// The mcp test pool boots an AUXILIARY api Worker (workers/mcp/vitest.config.ts) whose scriptPath is a
// PRE-COMPILED bundle (dist/api). vitest-pool-workers cannot boot without it, so ensure it exists — the
// `pretest` npm hook builds it. quote-book.test.ts asserts over a RECORDING-FAKE api (not this bundle), so
// a present-but-stale bundle never affects its correctness; it only has to let the pool start.
function ensureMcpApiBundle(): void {
  if (existsSync(MCP_API_BUNDLE)) return;
  console.log(`\nacceptance: mcp api bundle missing (${MCP_API_BUNDLE}) — building it (pretest)…`);
  const res = spawnSync("pnpm", ["--filter", "@shuddl/mcp", "run", "pretest"], { stdio: "inherit" });
  if (res.status !== 0) {
    console.error("acceptance: FAILED to build the mcp api bundle — cannot run demo 4's spine.");
    process.exit(1);
  }
}

/** Run one package's spine files through its own vitest config. vitest exits non-zero on a genuine
 * failure AND on "no test files found" (a typo'd filter), so a silent no-op can never pass as green. */
function runPackage(pkg: string, files: readonly string[]): boolean {
  console.log(`\n▶ ${pkg} — ${files.join(", ")}`);
  const res = spawnSync("pnpm", ["--filter", pkg, "exec", "vitest", "run", ...files], { stdio: "inherit" });
  return res.status === 0;
}

function main(): void {
  banner();
  const byPkg = spineByPackage();
  if (byPkg.has("@shuddl/mcp")) ensureMcpApiBundle();

  const failed: string[] = [];
  for (const [pkg, files] of byPkg) {
    if (!runPackage(pkg, files)) failed.push(pkg);
  }

  console.log(`\n${"━".repeat(72)}`);
  if (failed.length > 0) {
    console.error(`ACCEPTANCE SPINE: FAIL — ${failed.length} package(s) red: ${failed.join(", ")}`);
    process.exit(1);
  }
  console.log(`ACCEPTANCE SPINE: GREEN — all ${spineFileCount()} spine tests pass. The FILMED half is the`);
  console.log("launch-gate checklist in docs/wp/acceptance-demos.md.");
}

main();
