import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { generateSeed } from "./generate.js";
import { loadSeed, type MigrationFile } from "./load.js";

// Node CLI for `pnpm seed:load`: load SEED-1 into the LOCAL tenant D1 that workers/api's wrangler
// config provisions (miniflare-backed). wrangler is not a root dependency, so it is resolved from
// workers/api via createRequire. The tested core is loadSeed() (see load.ts + seed-load.test.ts);
// this wrapper just wires it to a real D1 binding for local dev/screenshot baselines.
interface PlatformProxy {
  env: Record<string, unknown>;
  dispose: () => Promise<void>;
}
type GetPlatformProxy = (opts: { configPath: string; persist?: boolean }) => Promise<PlatformProxy>;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

function loadTenantMigrations(): MigrationFile[] {
  const dir = join(repoRoot, "db/tenant/migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ path: f, sql: readFileSync(join(dir, f), "utf8") }));
}

async function main(): Promise<void> {
  const requireFromApi = createRequire(join(repoRoot, "workers/api/package.json"));
  const wrangler = requireFromApi("wrangler") as { getPlatformProxy: GetPlatformProxy };
  const proxy = await wrangler.getPlatformProxy({ configPath: join(repoRoot, "workers/api/wrangler.toml") });
  try {
    const db = proxy.env.TENANT_A_DB;
    if (db === undefined) throw new Error("TENANT_A_DB binding not found in workers/api/wrangler.toml");
    const seed = await generateSeed();
    await loadSeed(db as Parameters<typeof loadSeed>[0], seed, loadTenantMigrations());
    console.log(`SEED-1 loaded into TENANT_A_DB (${seed.shipments.length} shipments, local D1).`);
  } finally {
    await proxy.dispose();
  }
}

await main();
