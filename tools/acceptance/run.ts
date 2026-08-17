import { spawnSync } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { repoRoot } from "../checks/repo-root.js";
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

/**
 * Workspace package name → its directory, from the three globs in pnpm-workspace.yaml.
 *
 * §1003 — same fix as `missingSpineFiles` below, and the second instance of one idiom: a `cwd` parameter
 * defaulting to the shell's location in a gate that always means the repo. Left unfixed it would resolve ZERO
 * packages from a subdirectory, and `missingSpineFiles` would then report every spine package as
 * *"no workspace package declares this name"* — a true statement about the wrong directory.
 */
// ── §1753 — THIS RUNNER IS A REPORTER, NOT A RATCHET (run `test:tools` too) ────────────────────────────────
//
// Measured: emptying demo 1's `spine` array in `demos.ts` makes this runner print
// `ACCEPTANCE SPINE: GREEN — all 6 spine FILES pass` — a true sentence about a spine that just lost a file,
// and the command named for the job is the one that cannot see it. Three gates in `demos.test.ts` catch it,
// including *"all five doc-00 demos are declared, each with AT LEAST ONE spine test"*.
//
// So the division is deliberate and worth knowing: this file EXECUTES the declared spine, and the ratchet on
// WHAT IS DECLARED lives next door. The merge gate runs both, so the board is protected; the exposure is the
// inner loop, where someone runs `pnpm test:acceptance` alone and reads GREEN.
//
// Third measured instance of that shape in this audit — `biller.ts` (§1740) and `booking.ts` (§1741) carry
// the same note for the same reason: the suite named after the subject is not always the one that can see it.

export function packageDirs(cwd: string = repoRoot()): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of globSync("{apps,workers,packages}/*/package.json", { cwd })) {
    const name = (JSON.parse(readFileSync(`${cwd}/${p}`, "utf8")) as { name?: string }).name;
    if (name !== undefined) out.set(name, dirname(p));
  }
  return out;
}

/**
 * REQ-119 §607 — EVERY REGISTERED SPINE FILE MUST EXIST ON DISK.
 *
 * The comment this replaced claimed vitest's own exit code made the runner immune to a typo'd filter:
 * *"vitest exits non-zero on a genuine failure AND on 'no test files found', so a silent no-op can never
 * pass as green."* **That is true only when NO filter in the package matches anything.** `@shuddl/api`
 * carries FOUR of the seven spine files, so one renamed or deleted file drops out silently while the other
 * three hold the package's exit at 0 — and the summary line then prints `spineFileCount()`, which counts the
 * REGISTRY rather than what ran, so the gate reports "all 7 spine FILES pass" having run six.
 *
 * Measured: pointing demo 1's spine at a non-existent file left `pnpm test:acceptance` GREEN at exit 0.
 * That is the §572 shape — a check whose floor bounds the hits it found instead of the corpus it read — in
 * the one gate whose entire job is the five doc-00 demos that define "done enough to show".
 */
/*
 * §1003 — the default is repoRoot(), not process.cwd().
 *
 * The parameter stays (a caller may scope the check to a fixture tree), but the DEFAULT must be the repo, not
 * the shell's location. Measured at §1003: `missingSpineFiles()` returned **0 from the repo root and 4 from
 * any subdirectory**, so running `pnpm test:acceptance` from `packages/…` reported the acceptance spine as
 * broken. Fail-CLOSED, so it cried wolf rather than passing vacuously — which is why it survived the sweep
 * that anchored sixteen other gates to `repoRoot()`.
 *
 * The tell was in the test, not the runner: `demos.test.ts:80` already called `missingSpineFiles(repoRoot())`,
 * passing explicitly to work around this default. A test that compensates for a defect is evidence the defect
 * is known and unfixed — the argument there is now redundant, and deliberately kept so the parameter stays
 * exercised.
 */
export function missingSpineFiles(cwd: string = repoRoot()): string[] {
  const dirs = packageDirs(cwd);
  const missing: string[] = [];
  for (const [pkg, files] of spineByPackage()) {
    const dir = dirs.get(pkg);
    if (dir === undefined) {
      missing.push(`${pkg}: no workspace package declares this name — the spine names a package that does not exist`);
      continue;
    }
    for (const f of files) if (!existsSync(`${cwd}/${dir}/${f}`)) missing.push(`${pkg} → ${dir}/${f}`);
  }
  return missing;
}

/** Run one package's spine files through its own vitest config. A genuine failure exits non-zero; a filter
 * matching nothing does NOT, whenever a sibling filter in the same package still matches — which is why
 * `missingSpineFiles()` runs first. */
function runPackage(pkg: string, files: readonly string[]): boolean {
  console.log(`\n▶ ${pkg} — ${files.join(", ")}`);
  const res = spawnSync("pnpm", ["--filter", pkg, "exec", "vitest", "run", ...files], { stdio: "inherit" });
  return res.status === 0;
}

function main(): void {
  banner();
  const byPkg = spineByPackage();

  // BEFORE any vitest run: a spine file that does not exist would otherwise be masked by its siblings.
  const missing = missingSpineFiles();
  if (missing.length > 0) {
    console.error(
      `\nACCEPTANCE SPINE: FAIL — ${missing.length} registered spine file(s) do not exist. The demo they ` +
        `prove is UNTESTED, and vitest cannot report it: a filter matching nothing is silent whenever a ` +
        `sibling filter in the same package matches. Restore the file, or update tools/acceptance/demos.ts ` +
        `and say which demo lost its proof:\n  ${missing.join("\n  ")}`,
    );
    process.exit(1);
  }

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
  // §118: spineFileCount() counts FILES, not test cases. Printing it as "tests" taught every record that
  // quoted this line a wrong number (the 7 files carry 36 cases). Say what the number is.
  console.log(`ACCEPTANCE SPINE: GREEN — all ${spineFileCount()} spine FILES pass. The FILMED half is the`);
  console.log("launch-gate checklist in docs/wp/acceptance-demos.md.");
}

// Entry-point guard (the convention at tools/checks/bundle-ratchet.ts:85 and four siblings). Without it,
// `import { missingSpineFiles }` from the test would EXECUTE the runner and recursively spawn vitest.
if (process.argv[1]?.endsWith("run.ts")) main();
